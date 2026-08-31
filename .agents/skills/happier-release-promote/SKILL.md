---
name: happier-release-promote
description: Resolve the private Happier release authority for promotion work.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release Promote

Resolve the private release authority before promotion work:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

Use the returned private skill and its instructions as the authoritative promotion procedure. The public contract is available with `node scripts/pipeline/run.mjs release-contract`; do not recreate private release policy here.

The public issue-stage contract is in `docs/issue-triage.md`. Use the canonical release workflow so its pre-bound issue snapshot advances only after post-promotion verification. Do not manually pre-advance labels, infer availability from a branch move alone, or close issues as part of promotion.
