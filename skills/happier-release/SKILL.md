---
name: happier-release
description: Resolve Happier's private release authority from the public repository contract.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release

Inspect the public machine-readable contract with:

```bash
node scripts/pipeline/run.mjs release-contract
```

Then resolve the private release authority for the absolute checkout:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

Use the returned private skill and its instructions as authoritative. The public contract defines targets, profiles, and compatibility intent; private operating procedure stays outside this repository.

Issue availability is a public release contract owned by `docs/issue-triage.md`. Normal nightly, preview, and stable workflows snapshot only the earlier `stage:*` queues proven by the selected source topology before candidate binding, then advance those snapshots only after their existing post-promotion verifier succeeds: current `dev` nightly uses source, `dev` → `preview` uses source/dev, `preview` → `main` uses preview, and direct `dev` → `main` uses source/dev. This handles an authorized lower-channel bypass without attributing later dev corrections to an older preview candidate. A reconciliation failure does not roll back already published artifacts, but it is a visible release-workflow failure: inspect/retry the idempotent label job or leave the issues at their prior stage for the next matching release. Never compensate by closing issues or claiming a channel shipped without release evidence.
