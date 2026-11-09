---
name: happier-compatibility
description: Audit, design, implement, and verify Happier compatibility across UI, CLI, daemon, server, installers, and persisted state. Use when changes affect wire or semantic contracts, serialization, sessions/settings/queues, schemas or migrations, capability negotiation, mixed-version operation, upgrades, rollback, or the `../0.2` predecessor frontier for `dev`.
---

# Happier Compatibility

Preserve real released and prospective predecessor behavior at system seams without preserving undeployed internal architecture or creating speculative compatibility debt.

Read `docs/compatibility.md` before acting. Also read the owning package instructions and the domain document for the affected protocol, feature, encryption, provider, installer, or persistence surface.

## 0. Constitution rules (moved from root AGENTS.md)

Root `AGENTS.md` "Compatibility and version skew" points here; these are standing rules, not optional guidance.

- New readers accept supported released shapes and new writes use the canonical current shape. Require old readers to accept new writes only when mixed-version coexistence or rollback makes that direction reachable. A field added to a request a supported older server still receives needs one test against that server's strict reader (from `../0.2` source), or the writer omits it for that server through the existing negotiated discriminator, never a new feature bit or a 400 retry (2026-11-05: `usageTimingV1` broke agent switching against 0.2's `.strict()` cutover route; fixed in `5bf1f77fa745`).
- A changed published collection, record or wire shape takes a version step; never change it under the same version. Its RED is the previous version's stored row against the new reader (Channels V19, 2026-11-07: `collection_update_required` for every reader).
- For incompatible format or protocol transitions, use the narrowest necessary prepare/expand → activate/migrate → contract sequence. Compatibility adapters remain seam-owned, delegate domain decisions to the single canonical owner, and record their source release/predecessor plus removal condition.
- Validate affected reachable old/new directions without manufacturing Cartesian matrices, shims, fixture families, or fallbacks for seams the change cannot exercise. Prefer one discriminating test per material direction plus risk-selected end-to-end flows, using real artifacts or provenance-pinned vectors rather than reconstructed current-type fixtures.

### `../0.2` predecessor frontier

- `../0.2` is the moving predecessor expected to ship first. Inspect its real current relevant files—including committed, staged, and unstaged changes—not only releases or `HEAD`; record the inspected `HEAD`, dirty status, diff/basis, and paths without modifying the sibling.
- Treat observable wire/data/state shapes its current code can produce or consume as prospective inputs, while released shapes remain hard obligations. Preserve those contracts, not sibling internals or every superseded intermediary; when it evolves before deployment, refresh the comparison and remove support needed only by a replaced never-released shape.
- Dirty work may be incomplete or concurrently owned. Separate observation from inferred intent, do not encode contradictory speculative interpretations, and recheck affected sibling paths before handoff when they were dirty or advanced. Validate the reachable mixed-version directions and predecessor-created data against `dev`'s canonical implementation.


### Repo-local development database reconciliation (root summary)

- Follow the 2026-10-31 **Migrations: no edits during development, one consolidation before 0.3 release** row in `.project/OWNER-RULINGS.md` for migration authoring, the named release check and accidental-edit reconciliation; the reconciliation procedure is in `apps/stack/AGENTS.md` **Repo-local development database reconciliation**.
- Reconciled means the database schema is equivalent to what a fresh canonical deploy of the current migration set produces, proven by a semantic schema comparison; a ledger checksum update alone is never a reconciliation. Follow the exact procedure in `apps/stack/AGENTS.md` ("Repo-local development database reconciliation").
- The agent that makes the last edit to those migration bytes owns the fresh reconciliation. Re-check current migration bytes and the repo-local ledger immediately before handoff; earlier evidence is stale after any later edit.

## 1. Classify the surface

Name the observable contract and classify it as wire, semantic, persistence, operational/installer, or internal-only.

If the change is internal-only and leaves external readers, writers, artifacts, and rollout behavior unchanged, stop the compatibility workflow. Do not create a matrix, shim, migration, or compatibility test merely because code moved.

### SDK protocol-evolution checklist

For a public SDK, feature-protocol, Host Event, or shared Protocol object/union,
record this checklist before implementation:

- name the wire epoch separately from the npm package version;
- recursively classify every material object as `closed`, `additive-open/drop`,
  or `additive-open/preserve`, including nested objects;
- confirm that stable Host Events and every identity, authority, routing,
  persistence/mutation, executable-declaration, and runtime-union envelope is
  `closed`;
- state whether each new optional input is safely ignorable or instead needs an
  advertised capability/operation or a new epoch;
- classify every changed union as explicitly skippable bounded presentation or
  authority-bearing; only the former may add a member without an existing safe
  `unknown` arm or a new epoch; and
- record unknown-field normalization/round-trip behavior and its bounds. An
  accepted unknown never receives identity, authority, routing, persistence,
  credential-selection, or trusted-content meaning.

Use [the canonical doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
for the normative rules. It also defines the direct-cut ruling: current `dev` →
`../0.2` rollback is not a supported SDK-author-contract direction.

### SDK package SemVer

Package SemVer is an independent compatibility axis from a wire epoch, the
host/runtime ABI, and manifest schema versions. Compare the current generated
public census and reachable declaration report with the provenance-pinned
published baseline owned by release history; never infer the baseline from a
generator's previous output. Feature implementation and QA use current source
and do not build or install a local release archive for this comparison. The
report supplies mechanical facts (`added`, `removed`, `changed`, `deprecated`,
`unchanged`), and the release reviewer classifies their SemVer impact.

A removed public declaration is breaking; any changed declaration block needs
human review. A patch release must not intentionally break package API. An
intentional breaking change to a `0.x` package uses a minor version, requires
explicit human approval, and includes migration notes. This package decision
does not by itself change a wire epoch or relax the separate host/runtime ABI
contract. Unpublished workspace source establishes no released package
compatibility obligation.

## 2. Establish evidence-backed baselines

- Resolve active stable and preview baselines independently for every affected component. Record immutable version tag, commit, and artifact/deploy evidence; do not use a rolling tag alone as the final basis.
- Include older versions only when explicitly supported.
- Exclude `dev` builds, undeployed internal paths, and abandoned intermediates from lasting obligations.
- Apply any repository-specific predecessor rule in `docs/compatibility.md`. When it requires a live sibling worktree, inspect committed, staged, and unstaged code without modifying it and label observed versus inferred behavior.

Do not proceed from a vague claim such as “the old client probably sends this.” Inspect the released/predecessor producer, reader, serializer, artifact, or pinned golden vector.

Before tightening schema strictness, census supported released shapes, current predecessor shapes, and existing stored shapes at the affected read boundary, using authorized non-sensitive evidence. Prove each reachable shape remains readable or has an approved migration or rejection decision; unavailable stored-shape evidence is a named gap, never evidence that only the current shape exists.

## 3. Map the corridor and close split-brains

Inventory the canonical owner and all affected producers, consumers, readers, writers, parsers, serializers, registries, decisions, persistence shapes, tests, and adapters.

Search the touched corridor for same-concept split-brains and similar-but-different logic. Reuse, extend, refine, extract, consolidate, migrate, or remove at the canonical owner. A compatibility adapter may translate a historical shape, but it must delegate domain decisions to that owner rather than becoming another active implementation. Keep one only for a named producer and version (a released contract, or a dev-skew shape actually observed in a loaded runtime). A RED that constructs the old shape proves the adapter works, not that anything still emits that shape.

Do not unify coincidental similarity across distinct bounded contexts. Name and verify the distinction when similar logic remains separate.

## 4. Build only the affected skew matrix

For each old/new direction that can occur, record:

- producer/writer version and component;
- consumer/reader version and component;
- upgrade, coexistence, rollback, or persisted-data reason;
- `required`, `unreachable`, or intentionally `unsupported`, with rationale;
- deciding contract/vector test and any risk-selected end-to-end flow.

Cover new-reader/old-writer by default. Cover old-reader/new-writer only when independent rollout, coexistence, or rollback makes it reachable. New-client/old-server behavior must negotiate capabilities or degrade safely. For routine compatible changes, old-client/new-server behavior preserves released wire and semantics; for a major incompatible change, do not assume that preserving every affected old-client operation is required.

When old-client/new-server support would require dual writers, parallel persisted formats, rollout modes, operator flags, socket-drain protocols, or another substantial mechanism, pause before designing it. Present the concrete user-visible choices and obtain an explicit developer/product decision: preserve the operation with the heavier transition, degrade only the affected operation with a clear update requirement, or intentionally require a client update. Do not silently force all clients to update, and do not silently build the machinery. This decision point applies only to genuinely incompatible high-cost changes; never turn routine server evolution into a client-version bump.

Do not expand unaffected roles into a Cartesian product. Broaden only when a shared protocol, persisted shape, installer/service state, or deployment order couples them.

For browser clients, adding a request header is also a CORS compatibility change. Before using one for capability negotiation, verify that every supported predecessor relay already permits it in `Access-Control-Allow-Headers`; changing only the current relay does not make a new client compatible with an older relay. Prefer a CORS-safelisted header, query parameter, or request body when the value is not sensitive. When a custom header is necessary, negotiate predecessor support first and exercise the real `OPTIONS` preflight for each reachable origin/relay direction. If browser code must read a new response header, verify `Access-Control-Expose-Headers` too.

## 5. Choose the narrowest safe transition

Prefer additive compatible evolution. When that is insufficient, use prepare/expand → activate/migrate → contract:

1. deploy readers that accept old and new while writes remain old;
2. verify every supported reader that can see the new shape is ready;
3. activate canonical new writes;
4. migrate or backfill historical data when required;
5. remove old support only after its explicit support/removal condition is proven.

Keep feature/capability decisions fail-closed and canonical. Prefer operation-scoped admission so unaffected behavior remains available. Do not add dual writers, fallback domain logic, or multiple registries to simulate compatibility.

Stored or received capability records are read **leaf by leaf**. An unknown or newer value in one leaf (for example `protocolVersions:[1,2,3]` for one operation) withdraws only that leaf. It must never invalidate sibling capabilities or the whole record. On 2026-10-26 a whole-object reader on an older server rejected a newer broker's record, so every Team-bound Session create failed with 400 `update_required`. Strict validation stays where the record is published.

### Migration authoring

Classify every affected migration before changing it:

- `local-only`: the migration has not shipped in a supported stable or preview artifact;
- `development-exposed`: the migration appeared on a shared development branch or `*-dev.*` artifact but still has no supported release obligation;
- `released`: the migration shipped in an active stable/preview artifact.

Follow the 2026-10-31 **Migrations: no edits during development, one consolidation before 0.3 release** row in `.project/OWNER-RULINGS.md` for migration authoring, the named release check and accidental-edit reconciliation; the reconciliation procedure is in `apps/stack/AGENTS.md` **Repo-local development database reconciliation**.

Published and released migrations are append-only: never modify their name or bytes. If a published migration is wrong, preserve it and design the smallest forward correction that works from the published state. If the published migration cannot run at all for a supported provider, stop and resolve the release/deployment contract explicitly instead of silently rewriting history.

A local database that applied an unpublished draft does not justify product compatibility code. For accidental applied-migration edits, follow the migration-policy owner row and the Stack reconciliation procedure above. Its database is retained and non-disposable; never delete, reset, recreate, replace, truncate, clean, or discard it. Inspect actual data, schema, and ledger; apply the exact provider-specific delta or canonical backfill; then deploy and verify. Do not add checksum allowlists, migration aliases, duplicate identities, no-op bridge migrations, or automatic runtime ledger rewriting solely for local development history.

Reconciliation ownership and verification follow `apps/stack/AGENTS.md` **Repo-local development database reconciliation**, including refreshed evidence after any later accidental edit.

If the repo-local stack has active stack-owned writers, quiesce only that stack through `hstack` and restore its prior state after reconciliation. Fail closed without mutation when current-checkout stack identity or database ownership is ambiguous. Backups and explicit approval remain required for `main`, shared, staging, production, external, another checkout's/named QA stack, or otherwise user-owned databases.

Use the canonical integration remote and immutable release tags/artifacts to establish the frontier. Verify all affected providers and test a clean upgrade from the published baseline before handoff.

## 6. Test proportionately

- Start with one discriminating contract or golden-vector test per material direction.
- Use real released/predecessor artifacts or provenance-pinned vectors when practical; current-type fixtures cannot prove historical compatibility.
- Add end-to-end upgrade, coexistence, rollback, or continuity flows only for the highest-risk reachable paths.
- Avoid shallow permutations, copied old implementations, and large mock families.
- For behavior changes, follow `.agents/skills/happier-testing` and prove RED for the compatibility failure before GREEN.

## 7. Handoff and lifecycle

Report:

- exact baseline tags/commits/artifacts or live predecessor worktree basis;
- observed contract and affected directions;
- canonical owner and split-brains/duplicates removed;
- retained compatibility paths, their provenance, purpose, and removal condition;
- tests and live flows actually run;
- unsupported, unreachable, or unverified directions and why.

Before handoff, recheck a dirty or advancing predecessor worktree and repeat the split-brain audit. If the prospective contract is contradictory or unknowable, report `[blocked]`; do not encode multiple speculative interpretations.

## Compatibility and version skew

- Compatibility obligations come from active released stable/preview component contracts and explicitly supported older releases. Resolve each component from immutable tags plus artifact/deploy evidence; rolling tags are only discovery pointers. `dev` builds, abandoned experiments, and undeployed internal paths are not lasting obligations unless a repository-specific predecessor rule says otherwise.
- Map affected producers, consumers, readers, writers, and persisted artifacts. Distinguish wire, semantic, persistence, and operational compatibility; preserve the seam, not old internal architecture.
- New clients must capability-negotiate or degrade safely with supported older servers. Routine server changes remain compatible with supported older clients. For a genuinely incompatible major server change, prefer keeping the connection and unaffected operations usable while returning a typed update requirement only for the unsafe operation.
- If old-client/new-server support would require substantial machinery—such as dual writers, parallel persisted formats, rollout modes, operator flags, or socket-drain protocols—stop and obtain an explicit developer/product decision. Agents must neither silently add that machinery nor silently impose a client update floor. This exception applies only to high-cost incompatible transitions; do not require client updates for ordinary server changes.
- New readers accept supported released shapes and new writes use the canonical current shape.

