---
name: happier-compatibility
description: Audit, design, implement, and verify Happier compatibility across UI, CLI, daemon, server, installers, and persisted state. Use when changes affect wire or semantic contracts, serialization, sessions/settings/queues, schemas or migrations, capability negotiation, mixed-version operation, upgrades, rollback, or the `remote-dev` predecessor frontier for `dev`.
---

# Happier Compatibility

Preserve real released and prospective predecessor behavior at system seams without preserving undeployed internal architecture or creating speculative compatibility debt.

Read `docs/compatibility.md` before acting. Also read the owning package instructions and the domain document for the affected protocol, feature, encryption, provider, installer, or persistence surface.

## 1. Classify the surface

Name the observable contract and classify it as wire, semantic, persistence, operational/installer, or internal-only.

If the change is internal-only and leaves external readers, writers, artifacts, and rollout behavior unchanged, stop the compatibility workflow. Do not create a matrix, shim, migration, or compatibility test merely because code moved.

## 2. Establish evidence-backed baselines

- Resolve active stable and preview baselines independently for every affected component. Record immutable version tag, commit, and artifact/deploy evidence; do not use a rolling tag alone as the final basis.
- Include older versions only when explicitly supported.
- Exclude `dev` builds, undeployed internal paths, and abandoned intermediates from lasting obligations.
- Apply any repository-specific predecessor rule in `docs/compatibility.md`. When it requires a live sibling worktree, inspect committed, staged, and unstaged code without modifying it and label observed versus inferred behavior.

Do not proceed from a vague claim such as “the old client probably sends this.” Inspect the released/predecessor producer, reader, serializer, artifact, or pinned golden vector.

## 3. Map the corridor and close split-brains

Inventory the canonical owner and all affected producers, consumers, readers, writers, parsers, serializers, registries, decisions, persistence shapes, tests, and adapters.

Search the touched corridor for same-concept split-brains and similar-but-different logic. Reuse, extend, refine, extract, consolidate, migrate, or remove at the canonical owner. A compatibility adapter may translate a historical shape, but it must delegate domain decisions to that owner rather than becoming another active implementation.

Do not unify coincidental similarity across distinct bounded contexts. Name and verify the distinction when similar logic remains separate.

## 4. Build only the affected skew matrix

For each old/new direction that can occur, record:

- producer/writer version and component;
- consumer/reader version and component;
- upgrade, coexistence, rollback, or persisted-data reason;
- `required`, `unreachable`, or intentionally `unsupported`, with rationale;
- deciding contract/vector test and any risk-selected end-to-end flow.

Cover new-reader/old-writer by default. Cover old-reader/new-writer only when independent rollout, coexistence, or rollback makes it reachable. New-client/old-server behavior must negotiate capabilities or degrade safely; old-client/new-server behavior preserves released wire and semantics.

Do not expand unaffected roles into a Cartesian product. Broaden only when a shared protocol, persisted shape, installer/service state, or deployment order couples them.

## 5. Choose the narrowest safe transition

Prefer additive compatible evolution. When that is insufficient, use prepare/expand → activate/migrate → contract:

1. deploy readers that accept old and new while writes remain old;
2. verify every supported reader that can see the new shape is ready;
3. activate canonical new writes;
4. migrate or backfill historical data when required;
5. remove old support only after its explicit support/removal condition is proven.

Keep feature/capability decisions fail-closed and canonical. Do not add dual writers, fallback domain logic, or multiple registries to simulate compatibility.

### Migration authoring

Classify every affected migration before changing it:

- `local-only`: the migration has not shipped in a supported stable or preview artifact;
- `development-exposed`: the migration appeared on a shared development branch or `*-dev.*` artifact but still has no supported release obligation;
- `released`: the migration shipped in an active stable/preview artifact.

Local-only and development-exposed migrations may be consolidated in place before the next supported release. A development-exposed revision requires an explicit reconciliation path for retained development databases, not a permanent product adapter. Prefer one clear transition from the released schema to the intended final schema over retaining draft add/rename/contract/drop history. Multiple unreleased migrations remain justified only by a real rollout, backfill, transaction, provider, or mixed-version requirement.

Published and released migrations are append-only: never modify their name or bytes. If a published migration is wrong, preserve it and design the smallest forward correction that works from the published state. If the published migration cannot run at all for a supported provider, stop and resolve the release/deployment contract explicitly instead of silently rewriting history.

A local database that applied an unpublished draft does not justify product compatibility code. Reconcile that database explicitly, with backup, schema/ledger inspection, a reviewable provider-specific procedure, and approval before mutating retained data. Do not add checksum allowlists, migration aliases, duplicate identities, no-op bridge migrations, or automatic ledger rewriting solely for local development history.

Treat the migration edit and retained-development reconciliation as one work unit. After the final migration edit and before handoff, compare complete physical schema—including indexes, constraints, and foreign keys—and prove the procedure on a current backup or clone; any later migration edit invalidates earlier checksum/ledger reconciliation evidence.

Use the canonical integration remote and immutable release tags/artifacts to establish the frontier. Verify all affected providers and test a clean upgrade from the published baseline before handoff.

## 6. Test proportionately

- Start with one discriminating contract or golden-vector test per material direction.
- Use real released/predecessor artifacts or provenance-pinned vectors when practical; current-type fixtures cannot prove historical compatibility.
- Add end-to-end upgrade, coexistence, rollback, or continuity flows only for the highest-risk reachable paths.
- Avoid shallow permutations, copied old implementations, and large mock families.
- For behavior changes, follow `skills/happier-testing` and prove RED for the compatibility failure before GREEN.

## 7. Handoff and lifecycle

Report:

- exact baseline tags/commits/artifacts or live predecessor worktree basis;
- observed contract and affected directions;
- canonical owner and split-brains/duplicates removed;
- retained compatibility paths, their provenance, purpose, and removal condition;
- tests and live flows actually run;
- unsupported, unreachable, or unverified directions and why.

Before handoff, recheck a dirty or advancing predecessor worktree and repeat the split-brain audit. If the prospective contract is contradictory or unknowable, report `[blocked]`; do not encode multiple speculative interpretations.
