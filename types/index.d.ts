export type FeedbackKind = 'thread' | 'review' | 'comment'

export type FeedbackComment = { author: string; body: string }

export type FeedbackItem = {
  id: string
  kind: FeedbackKind
  author: string
  path?: string
  line?: number
  isResolved: boolean
  isOutdated: boolean
  url: string
  comments: FeedbackComment[]
}

export type PrInfo = {
  number: number
  title: string
  url: string
  state: string
  reviewDecision: string
  baseRefName: string
}

export type CommitInfo = { sha: string; subject: string; age: string }

export type Snapshot = {
  status: 'idle' | 'loading' | 'ready' | 'no-repo' | 'no-pr' | 'error'
  error?: string
  branch?: string
  commit?: CommitInfo
  pr?: PrInfo
  items: FeedbackItem[]
  fetchedAt?: number
}

export type Mark = 'odd' | 'working' | 'done'

declare module 'claude-code' {
  interface PluginState {
    'pr-feedback': {
      snapshot: Snapshot
      selected: string[]
      marks: Record<string, Mark>
      showResolved: boolean
    }
  }
}
