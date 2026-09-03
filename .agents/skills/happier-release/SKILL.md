---
name: happier-release
description: Resolve Happier's private release authority and run an exact-SHA release or nightly through cheap admission, verified CI evidence, resumable immutable candidates, and terminal publication proof. Use for preparing, dispatching, recovering, or assessing a Happier release.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release

Keep release policy simple: test source once, admit the operation cheaply, build immutable candidates once, verify once per trust boundary, promote independent products in parallel where the workflow permits, and recover without rebuilding valid work.

## Resolve authority first

Inspect the public machine-readable contract with:

```bash
node scripts/pipeline/run.mjs release-contract
```

Then resolve the private release authority for the absolute checkout:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

Use the returned private skill and its instructions as authoritative. The public contract defines targets, profiles, and compatibility intent; private operating procedure stays outside this repository.

Do not publish from a dirty or protocol-incompatible maintainer-tools checkout. Bootstrap/preflight must bind the maintainer-tools commit and return structured admission failures before any release mutation. Do not modify or clean that checkout as an implicit part of releasing.

## Admit without repeating CI

Before expensive candidate work, run the repository's cheap, non-mutating release preflight. It validates operation-specific inputs such as source/channel identity, version and notes projection, maintainer protocol compatibility, tools, credentials, external configuration, and selected runner/platform prerequisites. It must call canonical owners and must not repeat unit, typecheck, integration, or E2E work from source CI.

Consume an explicit successful exact-SHA CI run/attestation whenever available. Pass its numeric `ci_run_id`; the release verifier must bind repository, canonical workflow, event, branch, completion, success, and exact head SHA. Nightly release validation remains artifact-specific and risk-selected—it is not another full source-CI run. If source CI is absent, fail or defer quickly through the canonical fallback instead of keeping a release runner watching another workflow.

Keep `fast`, `release`, and `deep` profile ownership distinct as defined in [CI cleanup](../happier-ci-stabilize/references/ci-cleanup.md). Do not turn a profile or runner backend into a copied workflow.

## Recover through one owner

For a failing or slow run, apply `skills/happier-ci-stabilize/SKILL.md`. Its recovery table decides among:

- native failed-job rerun for a same-SHA safe transient failure;
- immutable-candidate resume after a control/test-only fix, preserving individually verified successful siblings;
- fresh release when source, packaging, dependencies, signing inputs, or candidate bytes changed.

Do not blindly retry an ambiguous publication mutation. Reconcile remote state through its canonical mutation owner first. Use one foreground monitor, bound to one run and attempt, with 5-20 minute polling for long operations. Close only from terminal release status, exact candidate identity, required validation, and promoted-reference evidence.

## Preserve issue availability evidence

Issue availability is a public release contract owned by `docs/issue-triage.md`. Snapshot only the earlier `stage:*` queues proved by the selected source topology before candidate binding, and advance that snapshot only after post-promotion verification:

- current `dev` nightly: source;
- `dev` -> `preview`: source/dev;
- `preview` -> `main`: preview;
- authorized direct `dev` -> `main`: source/dev.

A reconciliation failure does not roll back published artifacts, but remains a visible release-workflow failure. Retry only the idempotent label owner or leave issues at their prior stage for the next matching release. Never compensate by closing issues or claiming availability without release evidence.
