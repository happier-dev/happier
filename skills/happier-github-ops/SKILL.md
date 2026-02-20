---
name: happier-github-ops
description: Run GitHub CLI commands as the Happier bot account via `yarn ghops` (forced PAT auth + non-interactive).
---

# Happier GitHub Ops (bot `gh` wrapper)

This repo provides `yarn ghops` as a thin wrapper around the GitHub CLI (`gh`) that **forces** authentication via the bot Personal Access Token.

## Prerequisites

- `gh` is installed on the host and reachable on `PATH`.
- Environment variable `HAPPIER_GITHUB_BOT_TOKEN` is set to the bot's fine-grained PAT.

## Contract / Safety

- `yarn ghops ...` refuses to run if `HAPPIER_GITHUB_BOT_TOKEN` is missing.
- Runs non-interactively (`GH_PROMPT_DISABLED=1`).
- Uses an isolated repo-local `GH_CONFIG_DIR` by default.

## What to write (LLM guidelines)

When creating/updating public issues, keep it **useful but minimal**:

- Prefer **user impact, repro steps, expected vs actual**, and **acceptance criteria**.
- Link to PRs/commits by URL when available.
- Avoid internal-only detail: no private logs, no secrets, no tokens, and no stack dumps from private environments.
- If you need to share sensitive debugging context, summarize it and keep the raw detail local.

Suggested comment format for progress updates:

- What changed (1–3 bullets)
- Why (brief)
- Next step / what’s blocked (one line)
- Links (PR/commit/issues)

## Common commands

Verify identity (must be the bot user):

```bash
yarn ghops api user
```

## Project conventions (Happier roadmap)

Canonical public roadmap project:

- Owner: `happier-dev`
- Project number: `1`
- URL: `https://github.com/orgs/happier-dev/projects/1`

## Labels (conventions)

These labels are intended to keep the public roadmap curated and consistent:

- `roadmap` (triage-owned): include this item on the public roadmap project
- `priority:p0`, `priority:p1`, `priority:p2`, `priority:p3` (triage-owned)
- `stage:not-shipped`, `stage:experimental`, `stage:beta`, `stage:ga` (optional; rollout state)
- `type: bug`, `type: feature`, `type: task` (recommended)
- `source: bug-report` (applied automatically by the bug-report service)

When asked to “create an issue and put it on the roadmap with P0”, do:

1) Create the issue
2) Apply `roadmap` and `priority:p0` (and a `type:*` label)
3) Ensure it lands on the roadmap project (automation should add it; if not, add explicitly)

When you create or meaningfully update an issue/PR, ensure it’s visible on the roadmap:

- Prefer GitHub Project automation (auto-add when `roadmap` label is present).
- If you’re not sure it will be auto-added, explicitly add it:

```bash
yarn ghops project item-add 1 --owner happier-dev --url https://github.com/happier-dev/happier/issues/123
```

Create an issue (repo explicit is recommended):

```bash
yarn ghops issue create -R happier-dev/happier --title "..." --body "..." --label "type: bug"
```

For CLI-created issues, format the body like the templates:

- Bug: summary + what happened + expected behavior + (optional) repro + (optional) frequency/severity + (optional) environment
- Feature: problem + proposal + acceptance criteria

For scripting / machine-readable output, prefer `gh api`:

```bash
yarn ghops api repos/happier-dev/happier/issues \
  -f title="..." \
  -f body="..." \
  --jq '{number: .number, url: .html_url}'
```

Comment on an issue:

```bash
yarn ghops api repos/happier-dev/happier/issues/123/comments -f body="Update: ..."
```

Apply labels (example):

```bash
yarn ghops api repos/happier-dev/happier/issues/123/labels -f labels[]="roadmap" -f labels[]="priority:p0"
```

## Titles (guidelines)

Prefer short, descriptive titles without noisy prefixes:

- Good: `Sessions flicker online/inactive`
- Good: `CLI: doctor fails when daemon is stopped`
- Avoid: `P0: ...` (priority belongs in the project/labels, not the title)
- Avoid: long bracket stacks like `[Bug][iOS][P0] ...`

Add an issue/PR to the org project (Project v2):

```bash
yarn ghops project item-add 1 --owner happier-dev --url https://github.com/happier-dev/happier/issues/123
```

List project fields/items (JSON):

```bash
yarn ghops project field-list 1 --owner happier-dev --format json
yarn ghops project item-list 1 --owner happier-dev --format json
```
