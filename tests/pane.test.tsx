import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PR = {
  number: 42,
  title: 'Add patient search',
  url: 'https://github.com/acme/app/pull/42',
  state: 'OPEN',
  reviewDecision: 'CHANGES_REQUESTED',
  baseRefName: 'develop',
}

const GRAPH = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              id: 'T1',
              isResolved: false,
              isOutdated: false,
              path: 'src/search.ts',
              line: 12,
              originalLine: 12,
              comments: {
                nodes: [
                  { author: { login: 'ana' }, body: 'Use the shared constant here', url: 'https://x/t1' },
                  { author: { login: 'felipe' }, body: 'Ok', url: 'https://x/t1r' },
                ],
              },
            },
            {
              id: 'T2',
              isResolved: true,
              isOutdated: false,
              path: 'src/old.ts',
              line: 3,
              originalLine: 3,
              comments: { nodes: [{ author: { login: 'ana' }, body: 'Already fixed', url: 'https://x/t2' }] },
            },
          ],
        },
        reviews: { nodes: [{ id: 'R1', author: { login: 'ana' }, body: '', state: 'COMMENTED', url: 'https://x/r1' }] },
        comments: { nodes: [{ id: 'C1', author: { login: 'luis' }, body: 'Add a test', url: 'https://x/c1' }] },
      },
    },
  },
}

function world(on: On, filled: string[], calls: string[][]) {
  mock.store(on)
  mock.clock(on, { now: 1_000 })
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    const [cmd, sub] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'git' && sub === 'rev-parse') return ok('feature/CU-1-search\n')
    if (cmd === 'git' && sub === 'log') return ok('abc123\tfix search\t2 minutes ago\n')
    if (cmd === 'gh' && sub === 'pr') return ok(JSON.stringify(PR))
    if (cmd === 'gh' && sub === 'api') return ok(JSON.stringify(GRAPH))

    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
}

const PANE_PROPS = { title: 'PR feedback', isFocused: true, bodyColumns: 80, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`lists open feedback and hands the selection to the ODD flow on ${surface}`, async ($, on) => {
    const filled: string[] = []
    const calls: string[][] = []
    world(on, filled, calls)

    const ui = await $.ui.mount({ plugin: 'pr-feedback', surface, component: 'Pane', requestId: 'pr-feedback', props: PANE_PROPS })
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ text: /Add patient search/ })).toBeDefined()
    expect(await ui.find({ text: /Use the shared constant here/ })).toBeDefined()
    expect(await ui.find({ text: /Add a test/ })).toBeDefined()
    expect(await ui.find({ text: /Already fixed/ })).toBeUndefined()
    expect(await ui.find({ key: 'sel-R1' })).toBeUndefined()

    await ui.press({ key: 'sel-T1' })
    await ui.press({ key: 'odd' })

    expect(filled.length).toBe(1)
    const prompt = filled[0] ?? ''
    expect(prompt).toContain('vipmed-odd:odd')
    expect(prompt).toContain('feature/CU-1-search')
    expect(prompt).toContain('src/search.ts:12')
    expect(prompt).toContain('Use the shared constant here')
    expect(prompt).not.toContain('Add a test')
    expect(await ui.find({ text: /en ODD/ })).toBeDefined()
    expect(calls.some(argv => argv.includes('comment') || argv.includes('resolveReviewThread'))).toBe(false)

    await ui.press({ key: 'resolved' })
    expect(await ui.find({ text: /Already fixed/ })).toBeDefined()

    await ui.unmount()
  })
}
