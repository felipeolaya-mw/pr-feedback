# pr-feedback

A Claude Code mod that opens a side pane with the current branch, its last commit and its pull request, and lists the PR's review feedback: review threads (with file and line), review summaries and general comments.

From the pane you pick the comments to act on and either hand them to the task doc (ODD) flow or ask Claude to work on them. Both actions fill the prompt; nothing is sent until you press Enter.

The mod only reads GitHub. It never replies to, resolves or comments on a PR.

## Install

```
/plugin install pr-feedback --marketplace felipeolaya-mw/pr-feedback
```

Answer `y` to add the marketplace, then pick a scope. The repository is private, so your GitHub account needs access to it.

Requires the GitHub CLI (`gh`) logged in to an account that can read the repository's PRs.

## Use

The pane opens at session start when the branch has a PR (as a sidebar from 144 terminal columns). Open it any time with `/pr-feedback`.

Mark comments with `[ ]`, then:

| Key | Action |
|-----|--------|
| `o` | Pass to ODD: fills the prompt asking the `odd` skill to add the selected comments to the branch's task doc, and marks them "en ODD" |
| `w` | Work: fills the prompt asking Claude to address the selected comments, with no commit, push or GitHub reply, and marks them "en curso" |
| `d` | Mark the selected comments done |
| `c` | Clear the mark of the selected comments |
| `r` | Refresh |
| `v` | Show or hide resolved threads |

Marks are kept per PR across sessions. The pane refreshes after each turn when the branch or commit moved, or when the data is older than two minutes.

## Limits

- Reads the first 100 review threads, 50 reviews and 100 comments of a PR, with no pagination.
- The `o` action relies on the `vipmed-odd` plugin being installed.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
