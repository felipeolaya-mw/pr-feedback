import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CommitInfo, FeedbackItem, Mark, PrInfo, Snapshot } from '../types'

const PANE = 'pr-feedback'
const TITLE = 'PR feedback'
const STALE_MS = 120_000

const snapshot = atom({ plugin: 'pr-feedback', key: 'snapshot' } as const, { status: 'idle', items: [] } as Snapshot)
const selected = atom({ plugin: 'pr-feedback', key: 'selected' } as const, [] as string[])
const marks = atom({ plugin: 'pr-feedback', key: 'marks' } as const, {} as Record<string, Mark>)
const showResolved = atom({ plugin: 'pr-feedback', key: 'showResolved' } as const, false)

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved isOutdated path line originalLine
          comments(first: 50) { nodes { author { login } body url } } }
      }
      reviews(first: 50) { nodes { id author { login } body state url } }
      comments(first: 100) { nodes { id author { login } body url } }
    }
  }
}`

type Login = { login: string } | null
type GqlComment = { id?: string; author: Login; body: string; url: string; state?: string }
type GqlThread = {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  originalLine: number | null
  comments: { nodes: GqlComment[] }
}
type GqlPull = {
  reviewThreads: { nodes: GqlThread[] }
  reviews: { nodes: GqlComment[] }
  comments: { nodes: GqlComment[] }
}

let isRefreshing = false

const who = (author: Login) => author?.login ?? 'ghost'

async function run($: EngineInterface, argv: string[]) {
  const out = await $.process.run(argv, { timeoutMs: 30_000 })
  return { ok: out.exitCode === 0, text: out.stdout.trim(), err: out.stderr.trim() }
}

async function readGit($: EngineInterface): Promise<{ branch: string; commit: CommitInfo } | undefined> {
  const branch = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch.ok) return undefined
  const log = await run($, ['git', 'log', '-1', '--format=%h%x09%s%x09%cr'])
  const [sha = '', subject = '', age = ''] = log.text.split('\t')
  return { branch: branch.text, commit: { sha, subject, age } }
}

function toItems(pull: GqlPull): FeedbackItem[] {
  const threads = pull.reviewThreads.nodes.flatMap<FeedbackItem>(thread => {
    const [first] = thread.comments.nodes
    if (first === undefined) return []

    return [{
      id: thread.id,
      kind: 'thread',
      author: who(first.author),
      path: thread.path,
      line: thread.line ?? thread.originalLine ?? undefined,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      url: first.url,
      comments: thread.comments.nodes.map(c => ({ author: who(c.author), body: c.body })),
    }]
  })
  const reviews = pull.reviews.nodes
    .filter(review => review.body.trim() !== '')
    .map<FeedbackItem>(review => ({
      id: review.id ?? review.url,
      kind: 'review',
      author: who(review.author),
      isResolved: false,
      isOutdated: false,
      url: review.url,
      comments: [{ author: who(review.author), body: `[${review.state ?? 'COMMENTED'}] ${review.body}` }],
    }))
  const comments = pull.comments.nodes.map<FeedbackItem>(comment => ({
    id: comment.id ?? comment.url,
    kind: 'comment',
    author: who(comment.author),
    isResolved: false,
    isOutdated: false,
    url: comment.url,
    comments: [{ author: who(comment.author), body: comment.body }],
  }))

  return [...threads, ...reviews, ...comments]
}

async function refresh($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    await update($, snapshot, (s): Snapshot => ({ ...s, status: 'loading' }))
    const git = await readGit($)
    if (git === undefined) {
      await update($, snapshot, (): Snapshot => ({ status: 'no-repo', items: [] }))
      return
    }
    const view = await run($, [
      'gh', 'pr', 'view', '--json', 'number,title,url,state,reviewDecision,baseRefName',
    ])
    const fetchedAt = await $.clock.now()
    if (!view.ok) {
      const isMissing = /no pull requests found/i.test(view.err)
      await update($, snapshot, (): Snapshot => ({
        status: isMissing ? 'no-pr' : 'error',
        error: isMissing ? undefined : view.err,
        ...git,
        items: [],
        fetchedAt,
      }))
      return
    }
    const pr = JSON.parse(view.text) as PrInfo
    const [, owner = '', name = ''] = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url) ?? []
    const gql = await run($, [
      'gh', 'api', 'graphql',
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr.number}`,
      '-f', `query=${THREADS_QUERY}`,
    ])
    if (!gql.ok) {
      await update($, snapshot, (): Snapshot => ({ status: 'error', error: gql.err, ...git, pr, items: [], fetchedAt }))
      return
    }
    const pull = (JSON.parse(gql.text) as { data: { repository: { pullRequest: GqlPull } } }).data.repository.pullRequest
    const items = toItems(pull)
    const stored = ((await $.store.get(`marks:${pr.url}`)) ?? {}) as Record<string, Mark>
    await update($, marks, () => stored)
    await update($, selected, ids => ids.filter(id => items.some(item => item.id === id)))
    await update($, snapshot, (): Snapshot => ({ status: 'ready', ...git, pr, items, fetchedAt }))
  } catch (error) {
    await update($, snapshot, (s): Snapshot => ({ ...s, status: 'error', error: String(error) }))
  } finally {
    isRefreshing = false
  }
}

async function setMarks($: EngineInterface, ids: string[], mark: Mark | undefined) {
  const { pr } = await read($, snapshot)
  if (pr === undefined) return
  const next = await update($, marks, current => {
    const copy = { ...current }
    for (const id of ids) {
      if (mark === undefined) delete copy[id]
      else copy[id] = mark
    }
    return copy
  })
  await $.store.set(`marks:${pr.url}`, next)
}

function describe(item: FeedbackItem): string {
  const where = item.path === undefined ? '' : ` ${item.path}${item.line === undefined ? '' : `:${item.line}`}`
  const flags = [item.isResolved && 'resolved', item.isOutdated && 'outdated'].filter(Boolean).join(', ')
  const head = `- [${item.kind}]${where} (@${item.author})${flags === '' ? '' : ` [${flags}]`} ${item.url}`
  const body = item.comments
    .map((c, i) => `${i === 0 ? '' : `↳ @${c.author}: `}${c.body}`.replace(/^/gm, '  > '))
    .join('\n')

  return `${head}\n${body}`
}

async function pickedItems($: EngineInterface) {
  const [snap, ids] = await Promise.all([read($, snapshot), read($, selected)])

  return { snap, picked: snap.items.filter(item => ids.includes(item.id)) }
}

async function fillPrompt($: EngineInterface, text: string) {
  const box = await $.prompt.read()
  await $.prompt.fill({ text: box.text.trim() === '' ? text : `\n\n${text}`, mode: box.text.trim() === '' ? 'replace' : 'append' })
}

async function sendToOdd($: EngineInterface) {
  const { snap, picked } = await pickedItems($)
  if (picked.length === 0 || snap.pr === undefined) {
    await $.ui.toast('Selecciona al menos un comentario.')
    return
  }
  await fillPrompt(
    $,
    [
      `Usa el skill vipmed-odd:odd para agregar al ODD de la rama \`${snap.branch}\` este feedback del PR #${snap.pr.number} (${snap.pr.url}).`,
      'Cada comentario es un ítem del checklist con su link; no escribas el doc a mano, va por el flujo de ODD. No respondas ni resuelvas nada en GitHub.',
      '',
      ...picked.map(describe),
    ].join('\n'),
  )
  await setMarks($, picked.map(item => item.id), 'odd')
  await update($, selected, () => [])
}

async function workOn($: EngineInterface) {
  const { snap, picked } = await pickedItems($)
  if (picked.length === 0 || snap.pr === undefined) {
    await $.ui.toast('Selecciona al menos un comentario.')
    return
  }
  await fillPrompt(
    $,
    [
      `Atiende estos comentarios del PR #${snap.pr.number} (${snap.pr.url}) en la rama \`${snap.branch}\`.`,
      'Cambia solo lo que piden y, si el ODD de la rama tiene el ítem, actualízalo por el flujo de ODD. Sin commit, push ni respuestas en GitHub.',
      '',
      ...picked.map(describe),
    ].join('\n'),
  )
  await setMarks($, picked.map(item => item.id), 'working')
  await update($, selected, () => [])
}

async function markDone($: EngineInterface) {
  const ids = await read($, selected)
  if (ids.length === 0) {
    await $.ui.toast('Selecciona al menos un comentario.')
    return
  }
  await setMarks($, ids, 'done')
  await update($, selected, () => [])
}

const MARK_LABEL: Record<Mark, string> = { odd: 'en ODD', working: 'en curso', done: 'hecho' }
const MARK_COLOR: Record<Mark, 'cyan' | 'yellow' | 'green'> = { odd: 'cyan', working: 'yellow', done: 'green' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-feedback',
      description: 'Open the pane with the current commit, PR and its review feedback',
    })
    $.clock.after(1, async () => {
      await refresh($)
      const snap = await read($, snapshot)
      if (snap.status === 'ready') await $.ui.open({ id: PANE, title: TITLE })
    })

    return next(e)
  })

  on('command.run', { command: 'pr-feedback' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    $.clock.after(1, () => refresh($))

    return { text: 'PR feedback pane opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    $.clock.after(1, async () => {
      const snap = await read($, snapshot)
      const git = await readGit($)
      const now = await $.clock.now()
      const isMoved = git?.branch !== snap.branch || git?.commit.sha !== snap.commit?.sha
      if (isMoved || now - (snap.fetchedAt ?? 0) > STALE_MS) await refresh($)
    })

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [snap, ids, marked, withResolved] = await Promise.all([
      read($, snapshot),
      read($, selected),
      read($, marks),
      read($, showResolved),
    ])
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 2)
    const items = snap.items.filter(item => withResolved || !item.isResolved)
    const hidden = snap.items.length - items.length
    const toggle = (id: string) =>
      update($, selected, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold>{snap.branch ?? '—'}</Text>
            {snap.commit && <Text dimColor>{`  ${snap.commit.sha} ${snap.commit.subject} (${snap.commit.age})`}</Text>}
          </Text>
          {snap.pr && (
            <Text wrap="truncate-end">
              <Text color="magenta">{`#${snap.pr.number} `}</Text>
              {`${snap.pr.title}`}
              <Text dimColor>{`  ${snap.pr.state} → ${snap.pr.baseRefName}${snap.pr.reviewDecision ? ` · ${snap.pr.reviewDecision}` : ''}`}</Text>
            </Text>
          )}
          {snap.status === 'loading' && <Text dimColor>Cargando…</Text>}
          {snap.status === 'no-repo' && <Text dimColor>El directorio de la sesión no es un repo git.</Text>}
          {snap.status === 'no-pr' && <Text dimColor>Esta rama no tiene PR abierto.</Text>}
          {snap.status === 'error' && <Text color="red" wrap="wrap">{snap.error ?? 'Error al leer el PR.'}</Text>}
        </Box>

        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="odd" hotkey="o" variant="primary" onPress={() => sendToOdd($)}>
            {`Pasar al ODD (${ids.length})`}
          </Button>
          <Button key="work" hotkey="w" onPress={() => workOn($)}>Trabajar</Button>
          <Button key="done" hotkey="d" onPress={() => markDone($)}>Hecho</Button>
          <Button key="clear" hotkey="c" onPress={() => setMarks($, ids, undefined)}>Quitar marca</Button>
          <Button key="refresh" hotkey="r" onPress={() => refresh($)}>Refrescar</Button>
          <Button key="resolved" hotkey="v" onPress={() => update($, showResolved, v => !v)}>
            {withResolved ? 'Ocultar resueltos' : `Ver resueltos (${hidden})`}
          </Button>
        </Box>

        {snap.status === 'ready' && items.length === 0 && <Text dimColor>Sin comentarios pendientes.</Text>}

        {items.map(item => {
          const mark = marked[item.id]
          const isPicked = ids.includes(item.id)
          const where = item.path === undefined ? item.kind : `${item.path}${item.line === undefined ? '' : `:${item.line}`}`

          return (
            <Box key={`item-${item.id}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Button key={`sel-${item.id}`} plain onPress={() => toggle(item.id)}>
                  {isPicked ? '[x]' : '[ ]'}
                </Button>
                <Text wrap="truncate-middle" dimColor={item.isResolved || mark === 'done'}>
                  <Text color="blue">{where}</Text>
                  <Text dimColor>{` @${item.author}`}</Text>
                  {item.isOutdated && <Text dimColor> outdated</Text>}
                  {item.isResolved && <Text dimColor> resolved</Text>}
                  {mark && <Text color={MARK_COLOR[mark]}>{` · ${MARK_LABEL[mark]}`}</Text>}
                </Text>
              </Box>
              {item.comments.map((comment, index) => (
                <Box key={`c-${item.id}-${index}`} paddingLeft={4} width={width}>
                  <Text wrap="wrap" dimColor={index > 0 || mark === 'done'}>
                    {index === 0 ? comment.body.trim() : `↳ @${comment.author}: ${comment.body.trim()}`}
                  </Text>
                </Box>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
