# Compatibility and version skew

This document defines when Happier preserves old behavior across UI, CLI, daemon, server, installers, and persisted state. The goal is safe upgrades and mixed-version operation without turning undeployed implementation history into permanent compatibility debt.

## Trigger

Apply this policy when a change affects a cross-component wire shape or semantic, persisted/session/settings data, schema or migration, feature/capability negotiation, installer or service state, upgrade/coexistence, or rollback. Routine internal refactors that leave these seams unchanged do not need a compatibility matrix or shim.

## Baseline classes

### Hard released obligations

- Active stable and preview releases count because both can exist on user machines or deployed infrastructure.
- Resolve each component independently. UI, CLI/daemon, server, desktop/mobile, and stack tags may point to different commits.
- Discover the current channel through rolling tags such as `cli-preview`, then record the immutable component version tag, commit, and relevant artifact/deploy evidence used by the check.
- Older releases count only when explicitly supported by policy or task scope; tag existence alone does not imply indefinite support.

### Moving `remote-dev` predecessor frontier

- `../remote-dev` is expected to ship before this repository. Its real current on-disk code is a prospective compatibility input even when it is uncommitted or not yet released.
- Inspect committed, staged, and unstaged code in the relevant paths. Record `HEAD`, working-tree status, the relevant diff/basis, and what was directly observed versus inferred.
- Never modify or clean the sibling worktree. Dirty changes may be incomplete or concurrently owned; if the externally observable contract is contradictory or unknowable, report that uncertainty rather than inventing multiple speculative adapters.
- Track the latest observable prospective shape, not every superseded internal implementation. When the sibling evolves before deployment, refresh the comparison and remove support that existed only for a replaced, never-released intermediary shape.
- Recheck relevant sibling paths before handoff when they were dirty or advanced during the task. Released stable/preview shapes remain hard obligations regardless of later sibling changes.

### Non-obligations

- `dev`/`*-dev.*` builds, untagged history outside the live predecessor frontier, abandoned experiments, and undeployed internal module paths are not lasting compatibility contracts.
- Do not keep aliases or adapters solely for an atomic internal rename/move whose old path never shipped.
- The predecessor rule preserves observable wire/data/state behavior, not `remote-dev`'s internal architecture.

## Map the seam

For the changed concept, identify:

- the canonical domain owner;
- every producer, consumer, reader, writer, serializer, parser, and persisted artifact;
- the old/new component versions that can actually meet during rollout or rollback;
- the wire, semantic, persistence, and operational expectations at that seam;
- any existing split-brain, duplicate decision path, fallback, or compatibility adapter in the touched corridor.

An existing same-concept split-brain in the touched corridor must be consolidated at the canonical owner. A compatibility adapter may translate released or predecessor shapes, but it must not independently decide domain behavior.

## Direction and rollout

- New readers accept supported old shapes; new writes use the canonical current shape.
- Old readers need to accept new writes only when coexistence, independent component rollout, or rollback makes that direction reachable.
- New clients talking to old servers must capability-negotiate or degrade safely instead of assuming the new contract.
- Old clients talking to new servers must retain their released wire and semantic expectations.
- Persisted-state changes consider both old-writer → new-reader and, when rollback/coexistence is supported, new-writer → old-reader.
- For an incompatible transition, prefer prepare/expand → activate/migrate → contract. Do not activate new writes until every supported old reader that can encounter them is ready.

## Proportionate matrix

List all affected reachable directions and mark each `required`, `unreachable`, or `unsupported` with a reason. Direct seam tests cover each required direction. End-to-end rows are selected by risk and real deployment order.

Do not run a full Cartesian UI × CLI × daemon × server matrix for an internal or unrelated change. Require broader combinations when a shared protocol, persistence shape, installer/service state, or rollout ordering actually couples those roles.

## Evidence and tests

- Prefer real released/predecessor artifacts, serializers, clients, or provenance-pinned golden vectors.
- A fixture reconstructed from current types is not evidence that the released or predecessor reader/writer behaves that way.
- Use the smallest discriminating test for each material direction, then add risk-selected upgrade, coexistence, rollback, and state-continuity flows.
- Do not multiply shallow permutations. A new test must distinguish a plausible incompatibility, reader/writer mismatch, semantic change, or rollout failure.
- Record the exact tag/commit/artifact or sibling worktree basis, component roles, direction, command, and result.

## Compatibility path lifecycle

Every retained compatibility path records:

- the released or prospective source shape it supports;
- its producer and consumer;
- whether it exists for upgrade, coexistence, rollback, or persisted historical data;
- the canonical owner it delegates to;
- its removal condition.

Remove the path when its support window has ended and evidence shows no supported reader, writer, or stored shape still requires it. Do not remove a released-data reader merely because current writers stopped producing that shape.

## Migration history

Migration source has a stricter authoring boundary than ordinary internal code:

- A migration is **local-only** while it has not shipped in a supported stable or preview artifact. Local-only migrations may be edited, renamed, consolidated, or removed before publication.
- Once a migration ships in a supported stable or preview artifact, its name and bytes are immutable. Correct later behavior with a new append-only migration; do not rewrite, rename, or delete the released migration.
- Shared development branches and `*-dev.*` artifacts are evidence that a development database may need explicit reconciliation, but they do not create a lasting product compatibility obligation. Before the next supported release, their migration source may be corrected or consolidated in place when the final transition is still unreleased.

Before publishing a feature, consolidate local-only migration churn into the smallest clear transition from the published schema to the intended final schema. Do not retain add-then-drop columns, temporary tables, renamed draft identities, checksum aliases, or corrective migrations solely because a developer database applied an earlier draft. Retain multiple migrations only when each step serves a real rollout, backfill, transaction, provider, or mixed-version requirement.

If a persistent development database applied a local-only draft that is later rewritten:

1. back up or snapshot the database;
2. compare its actual schema and migration ledger with the published baseline and intended final schema;
3. prepare a database-specific, reviewable reconciliation procedure;
4. obtain explicit approval before mutating a database that contains retained user or development data;
5. verify the reconciled schema and ledger against the canonical migration set.

The migration edit and its retained-development reconciliation are one work unit. Compare the complete physical schema—not only columns, but also indexes, constraints, and foreign keys—and test the procedure on a current backup or clone after the final migration edit. Any later edit to the migration invalidates earlier checksum/ledger reconciliation evidence and requires the procedure and proof to be refreshed before handoff.

That reconciliation is an operator/development action, not a shipped compatibility path. Do not add runtime checksum exceptions, migration-name aliases, duplicate no-op migrations, or automatic ledger repair merely to preserve unpublished development history.

Keep PostgreSQL, SQLite, and MySQL migrations aligned by intent. Before publication, validate both a clean migration from the published baseline and the approved reconciliation path for any retained development database. After publication, preserve the exact migration history and test upgrades append-only.
