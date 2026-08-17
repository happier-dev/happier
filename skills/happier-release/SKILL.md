---
name: happier-release
description: Route general Happier release preparation through the maintainer-owned release authority.
---

# Happier Release

General release preparation, approval, dispatch, publication, recovery, and
status authority belongs to `hmaint`, not to a repository-local skill.

Start from the absolute repository checkout path and request its machine-readable
bootstrap contract:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

`hmaint` is an access-controlled maintainer-tool installation, not a public npm
fallback. If it is unavailable, obtain the approved `@happier-dev/maintainer-cli`
installation, verify `hmaint --help` exposes `release bootstrap`, then rerun the
command above. Do not copy private runbooks or recreate their shell workflow in
this repository.

Use that response to choose the supported release profile and follow the
maintainer-owned approval/dispatch flow. Do not treat this skill as permission
to publish, deploy, migrate, wait for a fleet, or orchestrate a cutover.

Before any release-note/version commit, the private conductor must inspect the
complete proposed release diff once and use the target-owned
`release-analyze` command to derive changed compatibility seams and the
risk-selected evidence plan. Semantic compatibility adjudication, affected
source/contract checks, notes, and version recommendations belong to that same
pre-materialization pass. After commit/push, confirm only that the analyzed
source is unchanged apart from approved materialization and run exact-artifact
evidence; do not repeat the semantic review unless an unexpected contract
change entered.

Heavy checks are required only when their named seam changed. Skip unrelated
heavy scenarios automatically and record the reason. Ask the maintainer only
about optional/borderline additional certification; `deep` remains explicit
and manual.

For curated Happier StoryDeck and release-note content only, use
`skills/happier-release-notes`; it remains a repository-specific content skill.
For manual-only deep certification, use
`skills/happier-release-validation`; it never dispatches a release.

Issue availability is a public release contract owned by `docs/issue-triage.md`. Normal nightly, preview, and stable workflows snapshot only the earlier `stage:*` queues proven by the selected source topology before candidate binding, then advance those snapshots only after their existing post-promotion verifier succeeds: current `dev` nightly uses source, `dev` → `preview` uses source/dev, `preview` → `main` uses preview, and direct `dev` → `main` uses source/dev. This handles an authorized lower-channel bypass without attributing later dev corrections to an older preview candidate. A reconciliation failure does not roll back already published artifacts, but it is a visible release-workflow failure: inspect/retry the idempotent label job or leave the issues at their prior stage for the next matching release. Never compensate by closing issues or claiming a channel shipped without release evidence.
