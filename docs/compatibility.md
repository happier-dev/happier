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

### Non-obligations

- `dev`/`*-dev.*` builds, untagged commits, abandoned experiments, and undeployed internal module paths are not lasting compatibility contracts.
- Do not keep aliases or adapters solely for an atomic internal rename/move whose old path never shipped.
- Repository-specific predecessor rules may add a prospective baseline, but they do not convert every historical intermediate implementation into permanent support.

## Map the seam

For the changed concept, identify:

- the canonical domain owner;
- every producer, consumer, reader, writer, serializer, parser, and persisted artifact;
- the old/new component versions that can actually meet during rollout or rollback;
- the wire, semantic, persistence, and operational expectations at that seam;
- any existing split-brain, duplicate decision path, fallback, or compatibility adapter in the touched corridor.

An existing same-concept split-brain in the touched corridor must be consolidated at the canonical owner. A compatibility adapter may translate released shapes, but it must not independently decide domain behavior.

## Direction and rollout

### Self-hosted independent upgrades

Self-hosted operators can upgrade clients, daemons, relays, and persisted
state independently. Release evidence therefore covers the reachable
directions rather than imposing a fleet wait or a global cutover:

- current clients, CLI, and daemon against a supported older stable relay;
- bounded supported older client/daemon core flows against the current relay;
- persisted state from an older writer into current readers; and
- current writes into older readers only when supported rollback or
  coexistence makes that direction reachable.

The last direction is conditional, not an excuse to add dual writers or a
permanent fallback. The release agent derives the affected, reachable
directions from the actual diff and supported released baselines. Scripts prove
only named behaviors against exact artifacts; they do not issue a general
compatibility verdict. The named Docker relay-upgrade scenario is selected
automatically only when the release changes the server and a supported
published relay predecessor exists. Installer and broader Docker validation
remain risk-selected; deep certification owns cross-OS, provider, mobile, and
comprehensive review.
Product seams still own the actual compatibility implementation.

- New readers accept supported old shapes; new writes use the canonical current shape.
- Old readers need to accept new writes only when coexistence, independent component rollout, or rollback makes that direction reachable.
- New clients talking to old servers must capability-negotiate or degrade safely instead of assuming the new contract.
- Old clients talking to new servers retain released behavior for ordinary compatible changes and for every operation the new server can still execute safely. A major incompatible server change may require a newer client for the affected operation, but that support boundary is an explicit developer/product decision—not an agent-selected default.
- Persisted-state changes consider both old-writer → new-reader and, when rollback/coexistence is supported, new-writer → old-reader.
- Prefer operation-scoped graceful degradation over connection-wide rejection: admit the old client, keep unaffected reads and writes available, and return a typed upgrade requirement only when the requested operation cannot be performed safely. Reject the whole connection only when no authenticated operation can be made safe.
- For an incompatible transition, prefer prepare/expand → activate/migrate → contract when mixed-version coexistence or rollback is an approved requirement. Do not assume that old clients must read new writes merely because the server is self-hosted.

Before adding dual writers, parallel persisted formats, rollout modes, operator flags, socket-drain protocols, or a mandatory client floor, compare their lifetime cost with the actual user behavior required. If preserving old-client/new-server behavior for a major change would require substantial machinery, stop and obtain an explicit developer/product decision among: operation-scoped degradation, a documented client update requirement, or the heavier compatibility transition. An agent must not silently choose either forced upgrades or heavy compatibility machinery. This exception is for genuinely incompatible, high-cost transitions; routine server changes must remain compatible and must not manufacture client-update requirements.

### Self-hosted relay release checks

For stable releases, prioritize current UI, CLI, and daemon core flows against
the supported older self-hosted relay. Check the bounded reverse direction only
for core usability affected by the changed seam. Check released persisted state
against current readers/migrations, and current writers against old readers
only when rollback or coexistence makes that direction reachable.

The registry may automatically select the exact `docker-release-assets`
published-channel-to-current-source upgrade when the server changed and a
supported published predecessor exists. That proves one named SQLite/Postgres relay
upgrade; it is not a generic compatibility verdict. Release orchestration never
waits for client adoption, self-hosted relay upgrades, daemon drain, migration
cohorts, or a global cutover.

## Proportionate matrix

List all affected reachable directions and mark each `required`, `unreachable`, or `unsupported` with a reason. Direct seam tests cover each required direction. End-to-end rows are selected by risk and real deployment order.

Do not run a full Cartesian UI × CLI × daemon × server matrix for an internal or unrelated change. Require broader combinations when a shared protocol, persistence shape, installer/service state, or rollout ordering actually couples those roles.

## Evidence and tests

- Prefer real released/predecessor artifacts, serializers, clients, or provenance-pinned golden vectors.
- A fixture reconstructed from current types is not evidence that the released reader/writer behaves that way.
- Use the smallest discriminating test for each material direction, then add risk-selected upgrade, coexistence, rollback, and state-continuity flows.
- Do not multiply shallow permutations. A new test must distinguish a plausible incompatibility, reader/writer mismatch, semantic change, or rollout failure.
- Record the exact tag/commit/artifact, component roles, direction, command, and result.

## Compatibility path lifecycle

Every retained compatibility path records:

- the released or prospective source shape it supports;
- its producer and consumer;
- whether it exists for upgrade, coexistence, rollback, or persisted historical data;
- the canonical owner it delegates to;
- its removal condition.

Remove the path when its support window has ended and evidence shows no supported reader, writer, or stored shape still requires it. Do not remove a released-data reader merely because current writers stopped producing that shape.

### Session draft rollout

Synchronized Session drafts are negotiated through the `sessions.drafts` server feature bit. A new
client fails closed when that bit or the typed routes are unavailable and retains the incumbent
local-only behavior; it does not send draft records through generic Account KV routes. A capable
server reserves the draft KV prefix so old generic-KV clients cannot read or overwrite typed draft
rows.

The first capable client imports the retired local existing-Session text/semantic stores and the
singleton new-Session draft into the canonical draft repository. It removes each legacy value only
after the corresponding canonical record is durably acknowledged, so an interrupted import remains
recoverable. The legacy readers are migration adapters, not parallel writers, and may be removed
when supported persisted local state no longer requires them.

During supported 0.2/0.3 coexistence, the draft authoring map remains closed except for explicitly
enumerated compatibility keys. The 0.2 reader accepts and preserves the 0.3 `executionTarget`,
`organizationPlacement`, `agentTarget`, `modelSelection`, and `runtimeDescriptorV1` fields but does
not treat them as 0.2 execution authority. The 0.3 reader validates and preserves the published 0.2
`machineId`, `serverId`, `agentId`, `backendTarget`, `modelId`, and `codexBackendMode` fields; its UI
projects only exact safe equivalents into canonical execution, Agent, and native-model selections.
Canonical 0.3 fields, including explicit clears, win over predecessor values, and each version's
writers continue to emit only their native catalog. Remove these reader bridges only after
0.2/0.3 coexistence and persisted drafts from the other catalog are no longer supported inputs.

Draft documents preserve unknown extension fields as JSON. This lets a client without a newer
composer contribution edit fields it understands without deleting newer semantic data; it does not
authorize that client to execute the unknown contribution. Raw files, handles, secrets, and other
device-only state remain outside the compatibility shape.

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
