# Agent Constitution

You are an AGENT in the Edison framework. This constitution defines your mandatory behaviors.

## CRITICAL: Re-read this entire file:
- At the start of every task assignment
- After any context compaction
- When instructed by the orchestrator

---

## Core Principles (CRITICAL)

## TDD Principles (All Roles)

Test-Driven Development is NON-NEGOTIABLE for behavior-changing implementation work.

### Scope: What Requires TDD (and what does not)
- **Requires TDD**: Any change that adds/changes executable behavior (production source code, CLIs, validators, state machines, config-loading/merging logic).
- **Does not require new tests**: Content-only edits to Markdown/YAML/templates (e.g., docs, templates, example config files not consumed by runtime, UI copy/wording) *when no executable behavior changes*.
- **No bundling**: Do not hide behavior changes inside a “content-only” change. If you touched production code, you must follow TDD.

### Behavior-Change Decision Matrix (Mandatory)
Apply this matrix before writing tests:

0) **Test inventory (required before writing tests)**:
- Search for existing tests covering the touched behavior (by symbol/module name, route/command, config key, component name, error code).
- Prefer updating the most relevant existing test first.
- If the suite already covers the behavior, do **not** add a new test “for TDD compliance” — improve/repair the existing test(s) or refactor to remove duplication.
- If you find overlapping/duplicate tests, consolidate instead of stacking more tests on top.

1) **Behavior changed or added**:
- Follow strict RED-GREEN-REFACTOR.
- Add a new test only when no existing test can express the new behavior clearly.

2) **No behavior change (structural/internal only)**:
- Do not add new tests by default.
- Run relevant existing tests for regression safety.
- Update existing tests only if setup/helpers/interfaces changed.

3) **Purely mechanical changes** (renames, moves, formatting, comments, type-only hardening with no runtime effect):
- Do not add tests.
- Run targeted checks/lint/type/test commands as appropriate.

4) **Content-only changes** (docs, UI copy/wording, formatting, example config files not consumed by runtime, CSS/styling, non-executable templates):
- Do not add tests.
- If existing tests fail because they pin copy/formatting, loosen the assertions to check stable behavior instead of exact text.

If uncertain whether a change affects **runtime behavior**, treat it as behavior-changing and do RED first. If the change is clearly content-only and not consumed by runtime logic, do **not** force TDD.

### Examples (Common Cases)
- Docs/README edits, wording tweaks, i18n string updates, formatting changes: **no new tests**.
- CSS/styling/layout-only UI adjustments: **no new tests** (unless they change an actual interaction or accessibility contract).
- Updating example config files or templates not used at runtime: **no new tests**.
- Changing runtime config schema/loading/merging/validation, or behavior gated by config: **TDD required** (test behavior under config inputs; avoid pinning defaults).
- Error handling changes: test error **type/code/shape/status**; do not pin full message wording unless the message is a published contract.
- UI behavior changes (navigation, state transitions, permissions, enabled/disabled logic): test the behavior; avoid assertions that fail on copy tweaks.

### The RED-GREEN-REFACTOR Cycle
- **RED**: Write a failing test first and confirm it fails for the right reason
- **GREEN**: Add the minimum code required to make the test pass—no extras
- **REFACTOR**: Improve the code with all tests green, then rerun the full suite
- Repeat the cycle for every feature/change

### The Iron Law (Stop-the-Line)
**No production code without a failing test first.**

If implementation exists before the test:
- Revert/stash the implementation, write the test first, then implement from the test.
- If you genuinely must proceed without strict test-first ordering, get explicit approval and document the rationale + follow-up task in the implementation report (do not silently skip).

### Core Rules
- Fail first; do not skip the RED step
- Minimal green code; avoid speculative features
- Refactor with a full test run before proceeding
- Coverage targets from config: overall >= 90%, changed/new >= 100% (for behavior-changing code paths). Never add low-value/brittle tests solely to increase coverage.
- If coverage targets are declared, enforce them in runner config/CI thresholds. Do not “enforce” coverage by adding brittle assertions.
- Update tests only to reflect agreed spec/format changes, never just to "make green"
- Prefer modifying or replacing existing tests over adding overlapping tests
- Keep output clean—no console noise

### Good Tests (Heuristics)
- One behavior per test (if the test name contains "and", split it).
- Test names describe behavior + expected outcome (avoid `test1`, `works`).
- Assert on observable outcomes (return values, state changes, HTTP responses), not internal call sequences.
- Tests should be deterministic and isolated (no shared global state, no ordering reliance).
- Avoid brittle “content policing” tests (e.g., pinning default config values or exact Markdown wording/format/length).
- Avoid asserting exact user-facing copy (UI strings, error message wording) unless copy itself is the product requirement; prefer stable identifiers, error codes/types, shapes, statuses, and key substrings when necessary.
- Avoid snapshot tests that primarily lock down copy/formatting; snapshots are acceptable only when they prove a meaningful, stable structure and won’t churn on routine copy edits.
- When testing configuration, assert behavior *given a config input*; do not pin example files or default values unless the default itself is a deliberate compatibility contract.
- Avoid near-duplicate tests that assert the same behavior through different fixtures unless each fixture represents a distinct risk.
- When a new test overlaps an old one, consolidate and remove or rewrite the weaker test.

## Test Suite Selection (Fast vs Slow)

Projects differ; Edison is framework- and language-agnostic. Use the project’s configured test command as the authoritative baseline:

```bash
yarn test
```

**Rule of thumb**:
- For tight iteration loops (RED/GREEN): run the *smallest relevant subset* (single test file, single package, targeted command) to iterate quickly.
- Before handoff, and whenever touching cross-cutting behavior (session/task/worktree/evidence/composition/config loading): run the project’s **full** required test run

### Test Lane Contract (Required)
- Treat `test` and `test:unit` (where defined; do not create `test:unit` unless intentionally splitting lanes) as fast lanes only; avoid heavy process/network/database orchestration in unit tests.
- Put orchestration-heavy or real-environment suites in `*.integration.test.*` / `*.integration.spec.*` (or `*.real.integration.test.*`) so they run under integration lanes.
- Use canonical lane suffixes exactly. Do not use near-miss names (for example `_integration.test.*`) that accidentally run in unit lanes.
- Keep e2e/provider/stress suites in their existing dedicated lanes under `packages/tests/suites`.
- When adding or moving integration tests, update the package test scripts/config so:
  - unit excludes integration patterns
  - integration includes integration patterns
  - CI executes both unit and integration lanes explicitly.
- If a test is flaky or slow due to real orchestration, move it to integration lane first; do not weaken assertions to force unit-lane speed.

Reconciliation with the NO MOCKS section: unit lanes should still test real behavior, but with lightweight real implementations (for example: in-memory SQLite, embedded test clients, and local file-backed stores). "Orchestration-heavy" means Dockerized dependencies, multi-process setups, external services, or real network calls that make tests slow or non-deterministic; those belong in integration lanes.

### Happier Test Lane Map (Project-Specific)
Use these as canonical top-level lanes in this repository:
- `yarn test` (fast unit lane across apps)
- `yarn test:integration` (orchestration-heavy app integration lane)
- `yarn test:e2e:core:fast` (default local core e2e loop)
- `yarn test:e2e:core:slow` (long orchestration core e2e)
- `yarn test:providers` (provider contracts; opt-in/flag-driven)
- `yarn test:db-contract:docker` (server db contract via docker)

Naming and placement rules:
- App integration tests: `*.integration.test.*`, `*.integration.spec.*`, `*.real.integration.test.*`
- Core e2e slow tests: `packages/tests/suites/core-e2e/**/*.slow.e2e.test.ts`
- Core e2e fast tests: other `packages/tests/suites/core-e2e/**/*.test.ts`
- Provider/stress suites remain under `packages/tests/suites/providers` and `packages/tests/suites/stress`

When introducing or moving a lane/pattern, update all three in the same change:
- package-level test config/scripts
- root `package.json` lane scripts
- CI workflow wiring that executes the lane

For full prerequisites/env matrix and examples, follow:
- `apps/docs/content/docs/development/testing.mdx`
- `packages/tests/README.md`

### Guardrails
- No `.skip` / `.todo` / `.only` (or equivalents) committed
- No hidden skips via conditional aliases (`const maybeIt = gate ? it : it.skip`) unless the test is an explicit opt-in external probe with a documented gate reason.
- Do not leave debugging logs in tests
- Evidence must be generated by trusted runners, not manually fabricated
- No duplicate test intent: each test must own a distinct behavior/risk

## No Internal Mocks Philosophy (All Roles)

### Core Principle
Test real internal behavior, not mocked internal behavior. Mocking internal code usually tests wiring, not behavior.

### What This Means
- **Real databases**: Use real database with test isolation strategies (SQLite, template DBs, containerized)
- **Real auth**: Use real authentication implementations
- **Real HTTP**: Test with real HTTP requests (TestClient, fetch)
- **Real files**: Use tmp_path or temporary directories
- **Real services**: Use actual service implementations

### Why No Internal Mocks
- Internal mocks reduce confidence and hide integration defects
- Real behavior tests catch actual bugs
- Integration issues are caught early
- Confidence in production behavior

### Boundary Mock Matrix (Required)
- **Allowed (system boundaries)**: third-party APIs, payment/email providers, platform/native SDK surfaces, OS/process/time/random/env adapters.
- **Not allowed (internal behavior)**: domain logic, reducers/selectors, normalization/parsing logic, permission/state machines, app orchestration helpers, store logic.
- **If a boundary mock is used**: document why the boundary is required and assert outcomes/state (not only call counts/spies).

## Quality Principles (All Roles)

### Type Safety
- No untyped escape hatches in production or tests
- `@ts-ignore` is forbidden
- `@ts-expect-error` is allowed only with a short rationale and only for the exact line that is expected to fail
- Broad `as any` casts are forbidden except in boundary fixtures/harnesses with a one-line justification
- Prefer `satisfies`, explicit interfaces, and typed fixtures over casting
- Type safety settings come from project configuration
- Do not weaken tsconfig/type rules to make tests or builds pass
- When TypeScript code changes, run the relevant package `typecheck` lane before handoff

### Code Hygiene
- No TODO/FIXME placeholders in production code
- No stray console.log or debug statements
- Remove dead code
- No commented-out code blocks

### File and Folder Naming (Required)
- Use explicit, purpose-revealing names. A reader should infer intent from path + filename without opening the file.
- Do not use vague names for production modules (`helpers`, `utils`, `misc`, `bundle`, `manager`, `stuff`) unless the folder scope already makes the purpose unambiguous and the module is genuinely broad.
- Prefer names aligned with primary export/behavior:
  - `createX.ts` for module factories
  - `normalizeX.ts` for normalization logic
  - `waitForX.ts` for wait/poll utilities
  - `startX.ts` / `runX.ts` only for true entrypoints
- Keep backend/provider-specific logic inside that backend folder. Shared cross-backend logic must live in core (`agent/*`) and remain provider-agnostic.
- Avoid compatibility shims for renames/moves by default. When restructuring, update all imports directly so the final structure is canonical.
- Split crowded folders by domain (for example: `runtime/`, `session/`, `spawn/`, `permission/`) instead of accumulating many cross-cutting files at one level.
- Keep files single-purpose. If a file starts owning multiple responsibilities, extract cohesive modules with explicit names.

### File Size and Complexity Guard (Required)
- Applies to all implementation code and tests, not tests only.
- If a file grows past ~400 lines or mixes responsibilities, split by domain/responsibility unless there is a clear reason not to.
- When touching oversized files, prefer net reduction in responsibility surface (extract helpers/modules) instead of adding more mixed logic.
- If a large file must remain large, document why and keep additions tightly scoped.

### Error Handling
- Async flows expose clear `loading` / `error` / `empty` states
- Errors are properly caught and handled
- User-facing errors are meaningful

### DRY & SOLID
- No code duplication—extract to shared utilities
- Single Responsibility Principle
- Open/Closed Principle
- Liskov Substitution Principle
- Interface Segregation Principle
- Dependency Inversion Principle

### Configuration-First
- No hardcoded values—all configurable
- No magic numbers or strings in code
- Every behavior must be configurable

## Configuration-First Principles (All Roles)

### Core Rule
NO hardcoded values. ALL configuration.

### What Must Be Configurable
- Feature flags
- Thresholds and limits
- Timeouts and intervals
- API endpoints
- Credentials (via environment)
- Behavior toggles

### Benefits
- Change behavior without code changes
- Environment-specific settings
- Audit trail for configuration
- Easier testing (override config)

## Feature gating (Canonical system, 2026-02-17)

This repo has a single canonical feature gating system. New code must use it instead of ad-hoc env checks, direct payload poking, or feature-specific inference logic.

### Canonical sources of truth
- Feature catalog (ids, descriptions, dependencies, representation): `packages/protocol/src/features/catalog.ts`
- Feature decision primitives: `packages/protocol/src/features/featureDecisionEngine.ts`, `packages/protocol/src/features/decision.ts`
- Server enabled-bit path derivation + safe reads: `packages/protocol/src/features/serverEnabledBit.ts`
- `/v1/features` schema split (gates vs details): `packages/protocol/src/features/payload/featuresResponseSchema.ts`

### Payload contract (important)
- `features` is the only place that contains feature gates. Gates are booleans under `features.<featureId path>.enabled`.
- `capabilities` contains configuration/details/diagnostics and MUST NOT be used by clients as feature gates.
- Always treat missing or malformed server enabled bits as disabled. Checks must be `readServerEnabledBit(payload, featureId) === true` (never `!== false`).

### Dependencies
- Dependencies are declared only in the protocol catalog (`packages/protocol/src/features/catalog.ts`).
- Enforce dependencies by using `applyFeatureDependencies(...)` from `packages/protocol/src/features/featureDecisionEngine.ts`.
- Do not duplicate dependency logic in call sites.

### Build policy (global feature denies)
- Build-policy evaluation lives in protocol (`packages/protocol/src/features/buildPolicy.ts`, `packages/protocol/src/features/embeddedFeaturePolicy.ts`).
- Build-policy inputs come from env:
  - `HAPPIER_BUILD_FEATURES_ALLOW`
  - `HAPPIER_BUILD_FEATURES_DENY`
  - `HAPPIER_FEATURE_POLICY_ENV` / `HAPPIER_EMBEDDED_POLICY_ENV`
- Server must apply build-policy denies centrally when assembling `/v1/features` (see `apps/server/sources/app/features/catalog/resolveServerFeaturePayload.ts`).
- Route handlers must NOT re-evaluate build policy ad hoc. If a route needs to distinguish “disabled by build policy” vs “disabled by config”, carry that as a diagnostic capability computed centrally (capabilities are allowed to explain, not to gate).

### Server implementation rules
- `/v1/features` assembly is centralized in `apps/server/sources/app/features/catalog/resolveServerFeaturePayload.ts`.
- Route gating must use the shared helper in `apps/server/sources/app/features/catalog/serverFeatureGate.ts`:
  - `createServerFeatureGatePreHandler(featureId)` or
  - `createServerFeatureGatedRouteApp(app, featureId)`
- Do not add per-route env-only bypasses for server-represented features.

### CLI implementation rules
- Resolve feature decisions via `apps/cli/src/features/featureDecisionService.ts` (and helpers it uses).
- CLI local policy belongs in `apps/cli/src/features/featureLocalPolicy.ts` (no scattered env parsing).
- For server-represented features, treat “no server snapshot” as fail-closed/unknown (the decision engine already encodes this); do not silently assume enabled.

### UI implementation rules
- Resolve feature decisions via `apps/ui/sources/sync/domains/features/featureDecisionRuntime.ts`.
- When you must read server bits directly (rare), use `readServerEnabledBit(snapshot.features, featureId) === true`.
- Do not treat missing/undefined as enabled. Prefer decisions (`FeatureDecision.state`) over raw booleans.

### Voice (Happier Voice) special note
- `voice.happierVoice` is a first-class SERVER feature gate and must be explicitly provided by the server.
- Fail closed: if the server snapshot is missing/unavailable, or if `features.voice.happierVoice.enabled` is not `true`, Happier Voice must be treated as disabled.
- Do not infer `voice.happierVoice` from `features.voice`, from any `capabilities.voice` fields, or from local env.

### Test gating by feature id (no registry)
- Feature-scoped tests must include `.feat.<featureId>.` in the filename, for example:
  - `something.feat.connectedServices.quotas.slow.e2e.test.ts`
- Vitest automatically excludes denied feature tests using `scripts/testing/featureTestGating.ts` (dependency closure included).
- Use `HAPPIER_TEST_FEATURES_DENY` (in addition to `HAPPIER_BUILD_FEATURES_DENY`) when you need to disable a feature’s tests in CI without changing the embedded policy.

## Encryption storage modes (E2EE vs plaintext storage)

This repo supports both encrypted-at-rest (E2EE-style) and plaintext-at-rest session storage. Treat this as a **storage-mode** choice; it is **not** the same thing as transport security (TLS) or authentication (key-challenge login still exists).

### Concepts (authoritative contracts)
- **Server storage policy**: `required_e2ee | optional | plaintext_only` (server config; surfaced via `/v1/features`).
- **Account encryption mode**: `e2ee | plain` (affects *new* sessions by default).
- **Session encryption mode**: `e2ee | plain` (fixed at session creation; avoids mixed-mode transcripts).
- **Message content envelope** (server storage + API contract):
  - `{ t: 'encrypted', c: string }` (ciphertext base64)
  - `{ t: 'plain', v: unknown }` (raw transcript record)
- Pending queue v2 uses the same envelope (`content`) alongside the legacy `ciphertext` shape.

### Implementation rules (do not regress)
- Always enforce **mode/content-kind compatibility** at write choke points (HTTP + sockets + pending):
  - `e2ee` session ⇒ accept encrypted content only
  - `plain` session ⇒ accept plain content only
- Sharing:
  - For `plain` sessions: sharing must work without `encryptedDataKey` (server-managed access).
  - For `e2ee` sessions: sharing/public-share must require a valid `encryptedDataKey` envelope.
- Do not add client-side “guessing” (e.g. assuming encrypted). Parse the envelope and branch behavior explicitly.
- All gating must use the canonical feature system:
  - feature ids: `encryption.plaintextStorage`, `encryption.accountOptOut`
  - do not gate client behavior on raw env vars or `capabilities` fields.

### Core E2E expectations (keep fast lane small)
Do **not** duplicate the entire core-e2e suite across both modes. Instead:
- Keep the existing suite exercising default encrypted behavior.
- Add **targeted** plaintext-specific E2E tests for each mode-sensitive workflow you touch.
- Add **targeted** encrypted regressions when contracts change (e.g. “must require encryptedDataKey in e2ee”).

Plaintext storage E2E tests live under `packages/tests/suites/core-e2e/` and are feature-gated via filename markers:
- `encryption.plaintextStorage.*.feat.encryption.plaintextStorage.*.e2e.test.ts`
- Sharing plaintext coverage additionally includes `.feat.sharing.public.`, `.feat.sharing.session.`, `.feat.sharing.pendingQueueV2.`, etc.

Testkit notes:
- Social friends setup helpers: `packages/tests/src/testkit/socialFriends.ts`
- Pending queue v2 testkit currently models encrypted-only rows; plaintext pending E2E should use direct `fetchJson` unless/until the helper is generalized.

## UI App Structure Rules (Happier UI)

Applies to `apps/ui/sources`.

### Root Density Rule
- Keep `components/`, `hooks/`, `utils/`, and `sync/` roots thin.
- Prefer domain subfolders for real implementations.
- Root-level files in these folders should be true domain entry points only.

### Canonical Domain Layout
- `components/ui/*` for reusable visual primitives and shared UI building blocks.
- `components/sessions/*` for session-specific composition and transcript UI.
- `components/sessions/sharing/*` for session sharing dialogs and selectors.
- `components/settings/*` for settings-domain view composition.
- `components/zen/*` for Zen task UI composition, navigation, and screens.
- `hooks/server/*`, `hooks/inbox/*`, `hooks/search/*`, `hooks/session/*`, `hooks/auth/*`, `hooks/machine/*`, `hooks/ui/*`.
- `utils/worktree/*`, `utils/timing/*`, `utils/platform/*`, `utils/path/*`, `utils/errors/*`, `utils/strings/*`, `utils/sessions/*`, `utils/auth/*`, `utils/system/*`, `utils/tools/*`, `utils/url/*`.
- `sync/api/*`, `sync/runtime/*`, plus `sync/domains/*`, plus existing `sync/engine/*`, `sync/store/*`, `sync/reducer/*`, etc.
- `sync/api/{account,artifacts,capabilities,session,social,types,voice}/*` for protocol-layer clients grouped by external API surface.
- `sync/domains/permissions/*`, `sync/domains/profiles/*`, `sync/domains/pending/*`, `sync/domains/models/*`, `sync/domains/messages/*`, `sync/domains/server/*`, `sync/domains/settings/*`, `sync/domains/state/*`, `sync/domains/session/*`, `sync/domains/todos/*`, `sync/domains/input/*`, `sync/domains/purchases/*`, `sync/domains/social/*`, `sync/domains/artifacts/*`.
- `sync/engine/{account,artifacts,machines,overrides,pending,purchases,sessions,socket,social,settings,todos}/*` for effectful sync runtime flows grouped by concern.
- `sync/encryption/*` for cryptographic primitives and settings/share encryption helpers.
- `agents/prompt/*` for agent/system prompt composition.
- `components/tools/catalog/*`, `components/tools/renderers/*`, `components/tools/normalization/*`, `components/tools/shell/*`, `components/tools/legacy/*`.
- `components/tools/shell/{views,presentation,permissions}/*`:
  `views` = orchestration-level tool shells (`ToolView`, `ToolFullView`), `presentation` = display-only shell blocks (`ToolHeader`, `ToolSectionView`, status/error/diff UI), `permissions` = permission action footer and tests.
- `components/tools/renderers/{core,fileOps,workflow,web,system}/*`:
  `core` = registry/types/test helpers, `fileOps` = filesystem renderers, `workflow` = plan/task/question/todo renderers, `web` = web fetch/search renderers, `system` = shell/mcp/system renderers.

### Sync Placement Boundaries (Mandatory)
- `sync/` root may contain only cross-domain runtime layers and folders (`api`, `domains`, `runtime`, `engine`, `store`, `reducer`, `git`, `http`, `encryption`, `ops`) plus explicit wiring entrypoints.
- Do not add domain-owned feature modules directly under `sync/` root; place them under `sync/domains/<domain>/`.
- `sync/api/*`: request/response adapters and protocol mapping only (includes capabilities protocol parsing).
- `sync/api/account/*`: account-level API calls (username, usage, kv, vendor tokens).
- `sync/api/artifacts/*`: artifact CRUD API client.
- `sync/api/capabilities/*`: capabilities/feature negotiation and capability protocol mapping.
- `sync/api/session/*`: session transport APIs (changes, push, socket request helpers).
- `sync/api/social/*`: feed/friends/sharing transport APIs.
- `sync/api/types/*`: API schema contracts shared by transport clients.
- `sync/api/voice/*`: voice API transport.
- `sync/domains/permissions/*`: permission types/defaults/options/override/apply logic.
- `sync/domains/profiles/*`: profile definitions, grouping, compatibility, and mutations.
- `sync/domains/pending/*`: pending queue, pending navigation state, terminal pending connect flow.
- `sync/domains/models/*`: model mode/options/override logic.
- `sync/domains/messages/*`: message metadata, message type contracts, send-meta shaping, and unread derivation.
- `sync/domains/server/*`: active server runtime/snapshot/config/profile selection, server targeting, and server switch helpers.
- `sync/domains/settings/*`: settings schema/selection/normalization plus local settings, debug settings, terminal options, and secret binding pruning.
- `sync/domains/state/*`: persistence/storage state contracts and serialization boundaries.
- `sync/domains/session/*`: session lifecycle helpers, session view/payload derivation, and session-specific console mode derivation.
- `sync/domains/todos/*`: Zen todo sync/state operations and task-session linking.
- `sync/domains/input/*`: prompt-adjacent file/command suggestion helpers used by agent input and autocomplete.
- `sync/domains/purchases/*`: purchase payload parsing and RevenueCat adapters/types.
- `sync/domains/social/*`: feed/friend/sharing type contracts and social-domain sync payload shaping.
- `sync/domains/artifacts/*`: artifact payload contracts and artifact-domain type shaping.
- `sync/runtime/*`: small cross-cutting runtime helpers (time, rpc error shaping, lightweight sequencing helpers) that are not domain-owned.
- `sync/runtime/orchestration/*`: sync coordination pipelines (connection switching, reconnect catch-up, planner/applier orchestration, project-scoped runtime coordination).
- `sync/encryption/*`: secret encryption/decryption/sealing and share-key crypto helpers.
- `agents/prompt/*`: system prompt composition and prompt policy assembly.
- `sync/engine/*`: orchestration and effectful runtime flows.
- `sync/engine/account/*`: account bootstrap/push token registration flows.
- `sync/engine/artifacts/*`: artifact fetch/socket apply + crypto coordination.
- `sync/engine/machines/*`: machine fetch/socket apply flows.
- `sync/engine/overrides/*`: ACP/model/permission override publish flows.
- `sync/engine/pending/*`: pending queue V2 orchestration.
- `sync/engine/purchases/*`: purchase sync/runtime triggers.
- `sync/engine/sessions/*`: session fetch/snapshot/socket message update orchestration.
- `sync/engine/socket/*`: socket transport parsing/reconnect/container handling.
- `sync/engine/social/*`: feed + relationship socket/fetch orchestration.
- `sync/engine/settings/*`: settings fetch/apply/seal orchestration.
- `sync/engine/todos/*`: todo domain sync orchestration.
- `sync/store/*`: state domains/selectors/normalization and persistence-facing state shape.
- `sync/store/*` may depend on `sync/domains/*`, but domain modules must not depend on `sync/store/*`.
- `sync/ops/*`: orchestration-facing operation entrypoints (spawn/session/machine actions) that compose domain + runtime helpers.

### Naming and File Markers
- One concept per file; avoid mixed-responsibility modules.
- Co-locate tests with implementation using `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `*.spec.tsx`.
- Underscore-prefixed markers are allowed only for intentional structural internals (for example: `_registry.ts`, `_types.ts`, `_shared.ts`).
- Do not use underscore-prefixed names for regular feature modules.
- Do not use `-` prefixed feature folders (`-zen`, `-session`) in `apps/ui/sources`.
- Do not use singular `components/session/*`; use `components/sessions/*`.

### Import and Migration Rules
- Prefer canonical alias imports (`@/components/...`, `@/hooks/...`, `@/utils/...`, `@/sync/...`) over fragile long relative paths.
- During moves, bulk-update imports in the same change.
- Do not commit compatibility wrappers after canonical import rewrites are complete.
- Use `components/tools/{catalog,renderers,normalization,shell,legacy}` canonical paths. Do not import from legacy locations (`components/tools/views`, `components/tools/knownTools`, `components/tools/utils`).
- Use `components/tools/renderers/{core,fileOps,workflow,web,system}` canonical renderer paths; do not create flat renderer files at `components/tools/renderers/` root.
- Use canonical sync aliases after domainization (for example: `@/sync/domains/messages/*`, `@/sync/domains/server/*`, `@/sync/domains/settings/*`, `@/sync/domains/session/*`, `@/sync/domains/purchases/*`, `@/sync/domains/social/*`, `@/sync/domains/artifacts/*`, `@/sync/runtime/orchestration/*`, `@/sync/api/capabilitiesProtocol`, `@/sync/encryption/*`, `@/agents/prompt/*`).

---

## Git Safety (Non-Negotiable)
- **Never switch branches in the primary checkout.** LLMs MUST NOT run `git checkout` / `git switch` in the primary worktree.
- **Branch creation/deletion is restricted.** Only create/delete branches if requested explicitely to do so.
- **NEVER use `git reset`, `git restore`, `git clean`, `git checkout -- <file>`, or any other destructive commands without user approval.** If you see unrelated changes/work to what you expect, NEVER discard them without explicit user confirmation. Many agents/LLMs may be working on the same task concurrently, so "unrelated" changes is expected and you should NEVER discard them, except via explicit user instruction.

- Do **not** create ad-hoc summary/report/status files.
- Before marking work complete, ensure there are no stray `*_SUMMARY.md` / `*_ANALYSIS.md` files or similar; delete unapproved summaries.

---

## Internal Packages & CLI Packaging (CRITICAL)

This repo has several **private workspace packages** (for example `packages/protocol`, `packages/agents`, `packages/cli-common`, `packages/release-runtime`) that are *not* published independently, but **must ship inside** published npm packages (currently: `apps/cli`, `apps/stack`, `packages/relay-server`).

### How internal workspace shipping works
- Published artifacts with bundled workspaces run `prepack`, which executes a `scripts/bundleWorkspaceDeps.mjs`:
  - `apps/cli/scripts/bundleWorkspaceDeps.mjs`
  - `apps/stack/scripts/bundleWorkspaceDeps.mjs`
  - `packages/relay-server/scripts/bundleWorkspaceDeps.mjs`
- `bundleWorkspaceDeps.mjs`:
  1) Copies each internal workspace’s `dist/` into `<host>/node_modules/@happier-dev/<pkg>/dist`
  2) Writes a **sanitized** `package.json` for each bundled workspace under `<host>/node_modules/@happier-dev/<pkg>/package.json`
  3) Vendors each bundled workspace’s **external runtime dependency tree** into:
     - `<host>/node_modules/@happier-dev/<pkg>/node_modules/**`
     via `vendorBundledPackageRuntimeDependencies` in `packages/cli-common/src/workspaces/index.ts`

### Dependency ownership rules (single source of truth)
When you add a dependency, add it to the **package that imports it**:
- If `packages/protocol` imports a library, add it to `packages/protocol/package.json#dependencies`.
- If `apps/cli` imports a library directly, add it to `apps/cli/package.json#dependencies`.
- **Do not** “mirror” protocol-only deps into `apps/cli/package.json` just because the CLI bundles protocol.
  - Bundled workspaces are *not installed* by npm as independent packages, so their dependencies will not be installed automatically.
  - Our bundler handles this by vendoring the dependency tree into the bundled workspace’s `node_modules` based on that workspace’s `package.json`.

### Adding a new internal workspace package to the CLI
If you introduce a new `packages/<name>` that must ship with the CLI:
- Add it to `apps/cli/package.json#bundledDependencies` and `apps/cli/package.json#dependencies` (workspace version `"0.0.0"`).
- Add it to the `bundles` list in `apps/cli/scripts/bundleWorkspaceDeps.mjs`.
- Update/extend `apps/cli/scripts/__tests__/bundleWorkspaceDeps.test.ts` and `apps/cli/scripts/__tests__/publishBundledDependencies.test.ts`.

### Bundling internal dependency closure (IMPORTANT)
`vendorBundledPackageRuntimeDependencies(...)` **only** vendors **external** deps (it intentionally ignores `@happier-dev/*`).

If a bundled workspace imports another internal workspace at runtime, the host package must also bundle that internal dependency.
- Example: `@happier-dev/cli-common/providers` imports `@happier-dev/agents` which depends on `@happier-dev/protocol`, so `apps/stack` must bundle `@happier-dev/{cli-common,agents,protocol}` (not just `cli-common`).

### “Missing dist / invalid exports” failures (Metro/Node)
Internal packages use `package.json#exports` pointing at `dist/**`. If `dist` is missing, consumers may fail with messages like:
- “invalid package.json configuration… exports … dist/<file>.js does not exist”

Fixes/guardrails:
- Build the workspace: `yarn workspace @happier-dev/protocol build` (or the relevant package).
- Stack builds call `ensureWorkspacePackagesBuiltForComponent` (`apps/stack/scripts/utils/proc/pm.mjs`) before running Expo/Metro to fail fast and/or build missing internal workspace outputs.

### Packaging sanity checks (do these when touching bundling/deps)
- Run the `apps/cli` script tests around bundling.
- Validate the tarball contents:
  - `cd apps/cli && node scripts/bundleWorkspaceDeps.mjs && npm pack`
  - Ensure protocol deps appear under `package/node_modules/@happier-dev/protocol/node_modules/**` (not duplicated at `package/node_modules/**` unless `apps/cli` imports them directly).

## principles

Default to human-readable CLI output.

- Prefer plain text/Markdown output when reading command results inside an LLM conversation.
- Use `--json` only when you need structured output for tools/scripts or when explicitly requested.

## agent

Agents should default to non-JSON output while implementing; only use `--json` when required by a specific workflow step or when the orchestrator requests structured output.

---

## TDD Execution (Agents)

### Mandatory Workflow

#### 1. RED Phase: Write Tests First
Write tests BEFORE any implementation code. Tests MUST fail initially.
If the change is truly content-only (Markdown/YAML/templates/UI) and no executable behavior is changed, do not add tests that pin content; just run the relevant existing checks. If the change does not make sense to be tested because it is too trivial and tests for this would be "tests just for the sake of writing tests" and that would be over-engineered, do not add tests. If tests already exists for the change you are applying, update the existing tests.

**Verify RED Phase**:
```bash
yarn test
# Expected: Test FAILS for the right reason (feature/behavior missing)
```

**Evidence note:** failing RED runs are not “evidence”. Evidence capture is for *passing* command outputs that validators will trust.

**RED Phase Checklist**:
- [ ] Test written BEFORE implementation
- [ ] Test fails when run (not skipped)
- [ ] Failure is an assertion/expectation failure (not a syntax/runtime error)
- [ ] Failure message is clear and points to missing behavior (not test bugs)
- [ ] Test covers the specific functionality
- [ ] If the test passes immediately, stop: tighten/adjust the test until it fails correctly (otherwise it may not be testing what you think)
- [ ] Existing related tests were reviewed first to avoid adding a duplicate

#### 2. GREEN Phase: Minimal Implementation
Write the MINIMUM code needed to make the test pass.

**Verify GREEN Phase**:
```bash
yarn test
# Expected: Test PASSES
```

**GREEN Phase Checklist**:
- [ ] Implementation makes test pass
- [ ] No extra code beyond what's needed
- [ ] Test passes consistently
- [ ] Other relevant tests still pass (no regressions introduced)

#### 3. REFACTOR Phase: Clean Up
Improve code quality while keeping tests passing.

**Verify REFACTOR Phase**:
```bash
yarn test
# Expected: ALL tests still PASS
```

**REFACTOR Phase Checklist**:
- [ ] Code is cleaner/more readable
- [ ] Error handling added
- [ ] Validation added
- [ ] ALL tests still pass

### Common Testing Anti-Patterns (Avoid)
- Testing mock/spies/call counts as "proof" instead of asserting outcomes.
- Mocking internal modules/classes/functions instead of testing the real internal behavior.
- Adding test-only methods/flags to production code to make tests easier.
- Mocking/stubbing without understanding what real side effects the test depends on.
- Boundary mocks that don't match the real schema/shape (partial mocks that silently diverge).
- Adding new tests for behavior that is already sufficiently covered instead of improving existing tests.
- Asserting exact full user-facing copy for behavior tests when codes/keys/shapes would validate behavior more robustly.

### Gate Checks (Before You Proceed)
**Before adding any production method to "help tests":**
- Is it used by production code (not just tests)? If not, put it in test utilities/fixtures instead.
- Does this class actually own the resource lifecycle being "cleaned up"? If not, it's the wrong place.

**Before adding any mock/double (even at boundaries):**
- What side effects does the real dependency have, and does the test rely on them?
- Can you run once with the real implementation to observe what's actually needed?
- If mocking a boundary response, mirror the full response shape/schema (not just fields the test touches).

### What NOT To Do
**NEVER**:
- Implement before writing tests
- "I'll add tests later" - NO!
- Skip test verification (RED phase must fail)
- Mock internal behavior to make tests easier
- Add duplicate tests when an existing test can be updated to cover the behavior
- Leave skipped/focused/disabled tests in committed code
- Commit with failing tests

### Performance Targets
| Test Type | Target Time | Description |
|-----------|-------------|-------------|
| Unit tests | <100ms each | Pure logic, no external dependencies |
| Integration tests | <1000ms each | Multiple components working together |
| API/Service tests | <100ms each | Service layer with real dependencies |
| UI/Component tests | <200ms each | Rendering and interaction tests |
| End-to-End tests | <5000ms each | Full user journey tests |

---

## Context7 Knowledge Refresh (CRITICAL)

Use Context7 MCP to refresh your knowledge **before** implementing or validating when work touches any configured post-training package.

## Rules

### RULE.CONTEXT.CWAM_REASSURANCE: Context window anxiety management (CWAM)
Keep working methodically and protect context:
- Prefer small, deterministic steps over rushing.
- Avoid pasting large logs; summarize and reference artifacts by path.
- If approaching limits, follow the project's compaction/recovery guidance.

### RULE.CONTINUATION.NO_IDLE_UNTIL_COMPLETE: Do not stop early; continue until the session is complete
When continuation is enabled and work remains:
- Continue iterating until Edison reports the session complete.
- Use the loop driver: `edison session next <session-id>`
- Do not stop early when work remains.

### RULE.GIT.NO_DESTRUCTIVE_DEFAULT: CRITICAL: NEVER “clean up” unrelated diffs with destructive git
Never revert, reset, or “clean up” unrelated/uncommitted changes unless the user explicitly asks.

In multi-LLM sessions it is normal to see unrelated diffs from other in-flight work. Do not:
- run `git reset`, `git restore`, `git clean`, `git checkout -- <path>`, `git switch`, etc.
- delete or revert “unwanted modifications” on your own initiative

If you believe a change is truly accidental, escalate and ask before taking any destructive action.

### RULE.CONTEXT.BUDGET_MINIMIZE: Preserve context budget – load only what's needed
Preserve context budget:
- Load only the minimum files/sections necessary for the current decision.
- Prefer diffs + focused snippets over whole files.

### RULE.CONTEXT.NO_BIG_FILES: Do not load big files unless necessary
Avoid loading huge inputs:
- Do not paste logs/build artefacts/large generated files into prompts.
- Extract only the minimal relevant excerpt and reference the full artifact by path.

### RULE.CONTEXT.SNIPPET_ONLY: Share snippets not whole files in prompts
Share snippets, not entire files:
- Provide the minimal relevant function/component/section with small surrounding context.
- Combine multiple small snippets when cross-references are required instead of dumping a full file.

### RULE.EXECUTION.NONINTERACTIVE: Avoid interactive commands in non-interactive environments
When running shell commands in non-interactive environments (LLMs, agents):
- Avoid interactive commands that can hang (vim, vi, nano, less, more, top, htop).
- Prefer non-interactive flags (--yes, --no-pager, --quiet, -y).
- Use environment variables to disable interactive behavior (CI=1, PAGER=cat, GIT_PAGER=cat).
- Wrap potentially hanging commands with `timeout`.
- Use `git --no-pager log` instead of `git log`.
- Use `cat` instead of `less` for viewing files.
- If an interactive command is necessary, request explicit user approval first.

## CRITICAL RULES REMINDER

CRITICAL: NEVER “clean up” unrelated diffs with destructive git
Never revert, reset, or “clean up” unrelated/uncommitted changes unless the user explicitly asks.

In multi-LLM sessions it is normal to see unrelated diffs from other in-flight work. Do not:
- run `git reset`, `git restore`, `git clean`, `git checkout -- <path>`, `git switch`, etc.
- delete or revert “unwanted modifications” on your own initiative

If you believe a change is truly accidental, escalate and ask before taking any destructive action.

CRITICAL: Do not add “content policing” tests
Never add tests (or assertions inside otherwise-good tests) whose primary purpose is to lock down wording/copy, whitespace, Markdown formatting, or docs/example config files. If a content-only change breaks an existing test, fix the test to assert stable behavior instead of exact strings.

CRITICAL: Always do a test inventory before adding tests
Before writing any new test, search for existing coverage and update/consolidate it. Do not stack new tests on top of overlapping tests just to satisfy the TDD rule.

CRITICAL: Extend/update/refine existing tests before creating new tests
ONLY add tests that add distinct behavior/risk coverage.

CRITICAL: Mock only system boundaries, never internal behavior
Boundary mocks are allowed for external/platform interfaces. Internal domain logic, parsers, reducers, store logic, and orchestration helpers must be tested with real implementations.

CRITICAL: Keep TypeScript strict everywhere
`@ts-ignore` is forbidden. `@ts-expect-error` and `as any` require narrow scope and explicit rationale.

CRITICAL: Enforce file size and responsibility boundaries
If a file is large or multi-purpose, split it by domain/responsibility instead of expanding a monolith.

## Encryption Opt-Out / Plaintext Session Storage (2026-02)

Sessions can be stored in two modes, controlled by `Session.encryptionMode`:
- `e2ee`: message/pending content is `{ t: 'encrypted', c: <base64> }` and must be decrypted client-side.
- `plain`: message/pending content is `{ t: 'plain', v: <RawRecord> }` and must *not* be decrypted client-side.

Server policy is advertised in `/v1/features`:
- gate: `features.encryption.plaintextStorage.enabled` / `features.encryption.accountOptOut.enabled`
- details: `capabilities.encryption.storagePolicy` (`required_e2ee | optional | plaintext_only`)

Implementation rule of thumb:
- Never assume `content.t === 'encrypted'`; always branch on the envelope.
- In `plain` sessions, bypass encrypt/decrypt for `metadata`, `agentState`, messages, and pending rows.

Core e2e coverage lives under `packages/tests/suites/core-e2e/` and includes plaintext roundtrip scenarios (including public share + pending queue v2).
