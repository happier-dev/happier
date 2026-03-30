# Agent Constitution

This constitution defines your mandatory behaviors.

## CRITICAL: Re-read this entire file:
- At the start of every task assignment
- After any context compaction

---

## Core Principles (CRITICAL)

<default_follow_through_policy>
- If the user’s intent is clear and the next step is reversible and low-risk, proceed without asking.
- Ask permission only if the next step is:
  (a) irreversible,
  (b) has external side effects (for example sending, purchasing, deleting, or writing to production), or
  (c) requires missing sensitive information or a choice that would materially change the outcome.
- If proceeding, briefly state what you did and what remains optional.
</default_follow_through_policy>

<parallel_tool_calling>
- When multiple retrieval or lookup steps are independent, prefer parallel tool calls to reduce wall-clock time.
- Do not parallelize steps that have prerequisite dependencies or where one result determines the next action.
- After parallel retrieval, pause to synthesize the results before making more calls.
- Prefer selective parallelism: parallelize independent evidence gathering, not speculative or redundant tool use.
</parallel_tool_calling>

<completeness_contract>
- Treat the task as incomplete until all requested items are covered or explicitly marked [blocked].
- Keep an internal checklist of required deliverables.
- For lists, batches, or paginated results:
  - determine expected scope when possible,
  - track processed items or pages,
  - confirm coverage before finalizing.
- If any item is blocked by missing data, mark it [blocked] and state exactly what is missing.
</completeness_contract>

<autonomy_and_persistence>
Persist until the task is fully handled end-to-end within the current turn whenever feasible: do not stop at analysis or partial fixes; carry changes through implementation, verification, and a clear explanation of outcomes unless the user explicitly pauses or redirects you.

Unless the user explicitly asks for a plan, asks a question about the code, is brainstorming potential solutions, or some other intent that makes it clear that code should not be written, assume the user wants you to make code changes or run tools to solve the user's problem. In these cases, it's bad to output your proposed solution in a message, you should go ahead and actually implement the change. If you encounter challenges or blockers, you should attempt to resolve them yourself.
</autonomy_and_persistence>

<mandatory_critical_testing_rules>
## TDD Principles

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

### Test Maintenance When Contracts Change - CRITICAL
- Keep positive-path fixtures aligned with the real runtime contract. If behavior now depends on session state, capabilities, feature flags, permissions, or availability, update happy-path fixtures to satisfy the new contract and keep invalid/offline/inactive fixtures only in explicit negative-path tests.
- Prefer contract-focused assertions over incidental implementation details. Assert stable observable behavior and durable fields, not exact callback arity, exact call ordering, or other details that are not part of the published contract.
- Remove or narrow redundant slow coverage when a smaller direct test already proves the same behavior. Do not keep duplicate smoke/integration/e2e coverage for the same contract if the duplicate primarily adds flake risk instead of new signal.
- Reset shared state in tests that rely on dynamic imports, module-level caches, mutable globals, or reused mocks. Order-dependent tests are test bugs and must be fixed at the isolation layer.
- After fixing a targeted failing test in a shared-runtime area, rerun at least one broader lane that can expose related stale fixtures or shared-state issues. A single-file green run is not enough when multiple suites share the same contract.

### Read-First Implementation And Reuse
- Before implementing, inspect the codebase for existing logic, helpers, harnesses, builders, and patterns that already own the same responsibility.
- Prefer reusing, extending, generalizing, or extracting from the canonical implementation instead of adding similar-but-different or competing logic.
- When introducing a canonical path, migrate, fold in, or remove overlapping old logic instead of leaving parallel implementations behind.
- Keep code with its natural owner: shared primitives in shared locations, package-specific logic in the owning package.
- Prefer small focused files and coherent subfolders; extract mixed-responsibility or oversized files when that improves clarity, reuse, and long-term maintainability.
- Before handoff, review your change like a merge reviewer: look for stale logic, duplicate paths, ownership drift, missing cleanup, missing edge-case handling, and leftover compatibility layers.

### Repo Testing Guardrails (Mandatory)
- Before behavior-changing edits, do a test impact inventory: identify the affected lanes, the existing tests that cover the contract, and any shared/package-local harnesses that the change can invalidate.
- If you change a runtime contract, routing contract, transport shape, feature gate behavior, or provider capability, update the affected tests in the same change. Do not defer the test updates to a later cleanup pass.
- Do not partially mock central shared modules that multiple suites depend on, especially `@/sync/domains/state/storage`. Use a shared mock factory or package-local testkit helper so new exports and contract changes fail in one place instead of many.
- Before creating a new test helper, mock family, or harness, inspect the codebase for the canonical testkit/helper for that boundary. Prefer extending, generalizing, or extracting from it over adding another ad hoc variant.
- Be especially careful with repeated high-drift boundaries. Prefer package-owned helpers over fresh inline mocks for UI boundaries such as `expo-router`, `@/text`, `@/modal`, `react-native`, and `react-native-unistyles`, and prefer existing route/DB harnesses over direct server storage mocks when those harnesses already exist.
- For `apps/ui` tests, the default testing surface is the UI-local testkit in `apps/ui/sources/dev/testkit/**`. Read `apps/ui/sources/dev/testkit/README.md` before introducing new UI mocks, fixtures, render helpers, or harnesses, and prefer imports from `@/dev/testkit` when the needed helper already exists.
- In UI unit/integration tests, do **not** introduce new inline `vi.mock(...)` families for `expo-router`, `@/text`, `@/modal`, `react-native`, `react-native-unistyles`, or `@/sync/domains/state/storage` when the canonical UI testkit already owns that boundary. If the canonical helper is missing one needed capability, extend the helper in `apps/ui/sources/dev/testkit/**` in the same change instead of hand-rolling a file-local mock shape.
- In UI tests, treat `react-native-unistyles` primarily as render/runtime plumbing, not as a behavior worth pinning in most suites. Prefer one shared/global Unistyles mock plus package-owned helper overrides only when a test truly needs custom theme/runtime behavior.
- In UI tests, delete or avoid local theme/color/style mock data when the suite does not assert a real layout, visibility, or formatting contract. Redundant per-file theme objects and style literals are drift surfaces.
- Do not assert exact theme colors, incidental opacity/background values, or raw style objects in ordinary product tests when a behavior-level assertion would protect the contract better. Keep style assertions mainly for true geometry/layout, visibility mechanics, or formatting/typography contracts.
- When a UI test still needs a local mock override, prefer the canonical testkit factory with the smallest override surface over a bespoke inline `vi.mock(...)` module shape.
- If a truly one-off local override remains necessary after checking the canonical testkit, keep it minimal, build it on top of the canonical factory where possible, and leave a short comment explaining why the shared helper could not express the case yet. Do not introduce a second reusable local helper family for that boundary.
- Prefer typed fixtures/builders from the owning testkit over repeated inline object literals when the same state/config/session/theme shape appears across multiple tests. For UI-local reuse, add/extend fixtures under `apps/ui/sources/dev/testkit/fixtures/**`; for cross-repo reuse, use `packages/tests/src/testkit/**`.
- Keep helpers near the owning package unless the primitive is truly cross-package shared: UI helpers in `apps/ui`, CLI helpers in `apps/cli`, server helpers in `apps/server`, cross-repo primitives in `packages/tests/src/testkit`.
- UI e2e must assert stable user contracts: wait for enabled controls, click the real submit/confirm affordance, and use stable `testID` selectors. Do not rely on settings-dependent gestures like Enter-to-send unless the test explicitly configures that setting first.
- After fixing a shared-area test or harness failure, rerun one broader related lane before handoff. A narrow green run is only enough for the RED/GREEN loop, not for final validation.
- Keep at most one active rerun for the same lane/spec. Duplicate runners create process leaks, artifact noise, and false flake signals.

## Test Suite Selection (Fast vs Slow)

**Rule of thumb**:
- For tight iteration loops (RED/GREEN): run the *smallest relevant subset* (single test file, single package, targeted command) to iterate quickly.
- Before handoff, and whenever touching cross-cutting behavior: run the project’s **full** required test run AND typechecks

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
- `yarn test:e2e:ui` (UI/browser e2e via Playwright; exercises real UI + server + CLI/daemon flows)
- `yarn test:providers` (provider contracts; opt-in/flag-driven)
- `yarn test:db-contract:docker` (server db contract via docker)

Naming and placement rules:
- App integration tests: `*.integration.test.*`, `*.integration.spec.*`, `*.real.integration.test.*`
- Core e2e slow tests: `packages/tests/suites/core-e2e/**/*.slow.e2e.test.ts`
- Core e2e fast tests: other `packages/tests/suites/core-e2e/**/*.test.ts`
- UI Playwright e2e: `packages/tests/suites/ui-e2e/**/*.spec.ts`
- Provider/stress suites remain under `packages/tests/suites/providers` and `packages/tests/suites/stress`

UI e2e authoring rules (Playwright + Expo web):
- Prefer stable selectors via React Native `testID` (queried in Playwright with `getByTestId(...)`); avoid selecting by visible copy.
- Treat `testID`s used by UI e2e as an API surface: avoid renames/removals unless you update the corresponding spec in the same PR.
- When adding `testID`s to shared RN components, ensure the web implementation forwards them to the DOM (typically `data-testid`) so Playwright can reliably locate elements.
- Keep UI e2e scenarios high-signal (onboarding, auth/terminal connect, session creation) and avoid duplicating core CLI-only e2e intent.
- If you change a flow that has a UI e2e, update the spec in `packages/tests/suites/ui-e2e/` in the same PR.
- UI e2e artifacts (screenshots/videos/diagnostics) are written under `packages/tests/.project/logs/e2e/ui-playwright/`.
- UI e2e runtime process logs (server/ui-web/daemon) are written under `.project/logs/e2e/*ui-e2e*/`.

Manual QA note (Expo web hot reload):
- If concurrent agents are making frequent changes, Expo web Fast Refresh can make manual QA hard because the page reloads on save.
- You can disable web Fast Refresh/HMR **per browser tab** (session-scoped) by opening the UI with `?happier_hmr=0` (re-enable with `?happier_hmr=1`).
- This opt-out is **web-only** and **dev-only**; it does not affect production builds or native (iOS/Android).

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

## No Internal Mocks Philosophy

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
</mandatory_critical_testing_rules>
<mandatory_critical_quality_principles>
## Quality Principles - CRITICAL

### Type Safety
- No untyped escape hatches in production or tests
- `@ts-ignore` is forbidden
- `@ts-expect-error` is allowed only with a short rationale and only for the exact line that is expected to fail
- Broad `as any` casts are forbidden except in boundary fixtures/harnesses with a one-line justification
- Prefer `satisfies`, explicit interfaces, and typed fixtures over casting
- Type safety settings come from project configuration
- Do not weaken tsconfig/type rules to make tests or builds pass
- When TypeScript code changes, run the relevant package `typecheck` lane before handoff - CRITICAL
- Project-specific expectation for this repo:
  - run the canonical touched-package typecheck/build lane, not just tests
  - examples:
    - `yarn workspace @happier-dev/protocol typecheck` (or the package’s canonical build/type-enforcing lane)
    - `yarn workspace @happier-dev/agents typecheck` (or canonical build/type-enforcing lane)
    - `yarn workspace @happier-dev/cli typecheck`
    - `yarn workspace @happier-dev/tests typecheck`
    - for UI/server packages, use the canonical package lane that enforces types if no dedicated `typecheck` script exists
  - before final handoff, rerun all relevant touched-package typecheck lanes after the last refactor pass

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
- Keep backend/provider-specific logic inside that backend/provider folder. Shared cross-provider logic must live in core and remain provider-agnostic.
- **Provider folder ownership (enforced)**:
  - `apps/cli` uses `apps/cli/src/backends/<providerId>` for executable provider wiring (CLI historical naming).
  - Internal workspaces use `src/providers/<providerId>` (e.g. `packages/*/src/providers/<providerId>`).
  - UI uses `apps/ui/sources/agents/providers/<providerId>`.
  - `backends/` is **reserved** for `apps/cli` only — do not introduce new `backends/**` folders in `packages/*` or `apps/ui`.
  - **Protocol layout invariant**: provider-specific executable logic/policy/defaults must live under `packages/protocol/src/providers/<providerId>/**` (avoid scattering provider folders inside other protocol domains).
  - **Protocol structure rule**: never add `packages/protocol/src/**/providers/<providerId>/**` or `packages/protocol/src/**/backends/<providerId>/**`. Keep a single `packages/protocol/src/providers/<providerId>/**` tree and re-export provider wire/schema from there when domain code needs it.
- Avoid compatibility shims for renames/moves by default. When restructuring, update all imports directly so the final structure is canonical.
- Split crowded folders by domain (for example: `runtime/`, `session/`, `spawn/`, `permission/`) instead of accumulating many cross-cutting files at one level.
- Keep files single-purpose. If a file starts owning multiple responsibilities, extract cohesive modules with explicit names.

### Registry / Catalog Pattern (Required)
- Before introducing a new registry, metadata map, field contract, or control-definition system, inspect the nearest existing patterns in the same package first and follow them.
- Prefer one canonical typed definition map or catalog plus small derived-artifact helpers over multiple parallel “registry”, “descriptors”, “ids”, and “schema” files that can drift.
- In protocol packages, follow the existing `define...(...)` + `build...Artifacts(...)` style used by established catalogs/registries when introducing new field or metadata systems.
- In UI packages, prefer one explicit registry file plus focused `resolve...` helpers and a `definitions/` folder over large “manager” modules or multiple competing registries.
- Do not create a second “metadata registry” beside an existing canonical field/catalog contract. New ids, schemas, descriptors, defaults, and visibility/editability metadata should be derived from the same source of truth whenever possible.
- When refactoring old ad hoc logic into a catalog/registry, preserve the external contract first and move the internal resolution logic behind the new registry rather than replacing user-facing behavior and architecture at the same time.
- When the app already has a central registry + core resolution path for a domain (for example backends, providers, source control, installables, session provider behavior), shared/core code must call that registry/core resolution path instead of branching on provider/vendor/source names directly.
- Do not bake provider-specific or backend-specific branching into generalized core, shared reducers, shared screen logic, shared sync logic, or shared registries-of-registries when an existing adapter hook/registry contract already exists.
- If a new provider-specific behavior is needed, extend the canonical registry entry shape or adapter hook surface and implement it in the provider-owned module. Then make shared/core code consume that hook/result.
- The source of truth must stay singular:
  - canonical catalog/registry declares support/capabilities/adapter hooks
  - shared/core code resolves through that catalog/registry
  - provider/source-specific code stays in provider/source-owned folders
- When you see existing code bypassing the registry and branching in core, treat that as architectural debt to remove during the refactor rather than copying the same pattern into new code.

### Backend / Provider Extension Architecture (Required)
- Reuse the existing catalog-and-provider-hook architecture; do not invent side registries when the backend catalog/registry already exists.
- Declarative provider support belongs in centralized catalogs only:
  - shared/provider-agnostic support facts in `packages/agents/*`
  - CLI executable backend wiring in `apps/cli/src/backends/catalog.ts` + `apps/cli/src/backends/<provider>/index.ts`
  - UI provider composition in `apps/ui/sources/agents/registry/*` + `apps/ui/sources/agents/providers/<provider>/*`
- Executable provider-specific behavior MUST stay inside the provider folder (`apps/cli/src/backends/<provider>/...`, `apps/ui/sources/agents/providers/<provider>/...`).
- Core/shared layers MUST stay provider-agnostic. Do not add provider-name branching (`codex`, `claude`, `opencode`, etc.) in core orchestration when the behavior can be obtained through the existing catalog/registry hook surface.
- When a new cross-provider feature needs provider-specific behavior, extend the existing catalog/entry type with a new hook/field and implement that hook in each provider's `index.ts`/provider module; do not add a new ad-hoc registry in unrelated core code.
- Before adding provider-specific logic anywhere outside a provider folder, stop and check whether it belongs as:
  - declarative capability/support in `packages/agents`
  - executable hook in backend/UI provider entrypoints
  - provider-agnostic orchestration in shared core that calls those hooks
- For UI, follow the same rule: generic screens/components/sync logic must consume provider behavior through the registry/core abstractions, while provider-only behavior lives in `sources/agents/providers/<provider>/core.ts`, `uiBehavior.ts`, and nearby provider-owned modules.
- **Internal packages follow the same rule** (no provider policy in core):
  - `packages/agents`: provider-specific executable logic belongs in `packages/agents/src/providers/<providerId>/**` (not scattered across unrelated modules).
  - `packages/protocol`: provider-specific *wire/schema* may live in protocol when it is part of the shared API contract, but provider-specific *executable behavior/policy/defaults* must live under `packages/protocol/src/providers/<providerId>/**` (or be moved up to `packages/agents` / server / UI as the owning layer).
  - `packages/protocol`: use a single `src/providers/<providerId>/**` tree rather than scattering provider-specific folders inside each domain (avoid `src/**/backends/<providerId>/**` and avoid `src/**/providers/<providerId>/**` nesting).
  - Avoid provider-specific defaults in protocol (e.g. “default backend is claude”); keep protocol provider-agnostic and let higher layers choose defaults via catalogs/profiles.

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
</mandatory_critical_quality_principles>

<feature_gating>
## Feature gating

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

### Default enablement policy (experimental UI toggles)
When a feature is intended to be **user-opt-in via the UI Experimental Features toggles**:
- **Server-represented gate should default to allow** so the server does not reject it by default.
  - Otherwise the UI may hide the toggle entirely (the UI hides server-represented toggles that are hard-disabled by the selected server snapshot).
- **Client/UI should default to disabled** (toggle off by default) so the user must explicitly opt in.
- Prefer using **build policy denies** (`HAPPIER_BUILD_FEATURES_DENY` / embedded policy) to remove/ship-deny features in certain builds, rather than defaulting server env gates to disabled.
- Exceptions: security/compliance-sensitive features may still default fail-closed on the server; document the exception in the feature’s server env reader and tests.

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
- UI design tokens:
  - Colors must come from `apps/ui/sources/theme.ts` via Unistyles `theme.colors.*` (avoid hardcoded hex in UI code).
  - Text must be rendered via `apps/ui/sources/components/ui/text/Text.tsx` so the user-selected in-app font size scales correctly (and stacks with OS Dynamic Type).
  - All user-visible strings (including accessibility labels/placeholders) must use `t(...)` and be added to all locales under `apps/ui/sources/text/translations/`.

### Test gating by feature id (no registry)
- Feature-scoped tests must include `.feat.<featureId>.` in the filename, for example:
  - `something.feat.connectedServices.quotas.slow.e2e.test.ts`
- Vitest automatically excludes denied feature tests using `scripts/testing/featureTestGating.ts` (dependency closure included).
- Use `HAPPIER_TEST_FEATURES_DENY` (in addition to `HAPPIER_BUILD_FEATURES_DENY`) when you need to disable a feature’s tests in CI without changing the embedded policy.
</feature_gating>
<encryption_storage_modes>
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
</encryption_storage_modes>
<ui_app_critical_rules>
## UI App Critical Rules (Happier UI) - `apps/ui/`

Applies to `apps/ui/sources`.

### Structure

#### Root Density Rule
- Keep `components/`, `hooks/`, `utils/`, and `sync/` roots thin.
- Prefer domain subfolders for real implementations.
- Root-level files in these folders should be true domain entry points only.

#### Sync Placement Boundaries (Mandatory)
- `sync/` root may contain only cross-domain runtime layers and folders (`api`, `domains`, `runtime`, `engine`, `store`, `reducer`, `git`, `http`, `encryption`, `ops`) plus explicit wiring entrypoints.
- Do not add domain-owned feature modules directly under `sync/` root; place them under `sync/domains/<domain>/`.
- `sync/api/*`: request/response adapters and protocol mapping only (includes capabilities protocol parsing).
- `sync/runtime/*`: small cross-cutting runtime helpers (time, rpc error shaping, lightweight sequencing helpers) that are not domain-owned.
- `sync/encryption/*`: secret encryption/decryption/sealing and share-key crypto helpers.
- `sync/engine/*`: orchestration and effectful runtime flows.
- `sync/store/*`: state domains/selectors/normalization and persistence-facing state shape.
- `sync/store/*` may depend on `sync/domains/*`, but domain modules must not depend on `sync/store/*`.
- `sync/ops/*`: orchestration-facing operation entrypoints (spawn/session/machine actions) that compose domain + runtime helpers.

#### Naming and File Markers
- One concept per file; avoid mixed-responsibility modules.
- Co-locate tests with implementation using `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `*.spec.tsx`.
- Underscore-prefixed markers are allowed only for intentional structural internals (for example: `_registry.ts`, `_types.ts`, `_shared.ts`).
- Do not use underscore-prefixed names for regular feature modules.
- Do not use `-` prefixed feature folders (`-zen`, `-session`) in `apps/ui/sources`.
- Do not use singular `components/session/*`; use `components/sessions/*`.

#### Import and Migration Rules
- Prefer canonical alias imports (`@/components/...`, `@/hooks/...`, `@/utils/...`, `@/sync/...`) over fragile long relative paths.
- During moves, bulk-update imports in the same change.
- Do not commit compatibility wrappers after canonical import rewrites are complete.

#### Development Guidelines

- Use **4 spaces** for indentation
- Use **yarn** instead of npm for package management
- Path alias `@/*` maps to `./sources/*`
- TypeScript strict mode is enabled - ensure all code is properly typed
- Follow existing component patterns when creating new UI components
- Real-time sync is orchestrated by the `Sync` singleton in `sources/sync/sync.ts`, with domain logic extracted into `sources/sync/engine/*`
- Store all temporary scripts and any test outside of unit tests in sources/trash folder
- When setting screen parameters ALWAYS set them in _layout.tsx if possible this avoids layout shifts
- **Never use Alert module from React Native, always use @sources/modal/index.ts instead**
- **Always apply layout width constraints** from `@/components/layout` to full-screen ScrollViews and content containers for responsive design across device sizes
- Always run `yarn typecheck` after all changes to ensure type safety

#### Theme, Typography, and i18n (Required)

- **No hardcoded colors**: do not introduce raw hex/rgb colors (e.g. `#000`, `#fff`) for UI styling. Use `useUnistyles()` theme tokens (`theme.colors.*`) or existing themed styles so light/dark/adaptive themes stay correct.
- **Icons must be themed**: icon `color` and background/tint props must come from theme tokens (avoid `black`/`white`).
- **Text must respect UI font scaling**:
  - Prefer `@/components/ui/text/Text` and `@/components/ui/text/TextInput` over `react-native` `Text`/`TextInput`.
  - Avoid hardcoded font sizes in new UI code. If you must set a base size, ensure it scales via `uiFontScale` (and stacks with OS Dynamic Type on native).
  - For embedded editors, use `resolveCodeEditorFontMetrics(...)` and propagate scale to Monaco/CodeMirror surfaces.
- **All user-facing copy must be translated**: use `t('...')` for UI strings, add keys to all supported locale files under `sources/text/translations/`, and avoid hardcoding English in components.

#### Important Rules for i18n
- **Never hardcode strings** in JSX - always use `t('key')`
- **Dev pages exception** - Development/debug pages can skip i18n
- **Check common first** - Before adding new keys, check if a suitable translation exists in `common`
- **Context matters** - Consider where the string appears to choose the right section
- **Update all languages** - New strings must be added to every language file
- **Use centralized language names** - Import language names from `_all.ts` instead of translation keys
- **Always re-read translations** - When new strings are added, always re-read the translation files to understand the existing structure and patterns before adding new keys
- **Use translations for common strings** - Always use the translation function `t()` for any user-visible string that is translatable, especially common UI elements like buttons, labels, and messages
- **Use the i18n-translator agent** - When adding new translatable strings or verifying existing translations, use the i18n-translator agent to ensure consistency across all language files
- **Beware of technical terms** - When translating technical terms, consider:
  - Keep universally understood terms like "CLI", "API", "URL", "JSON" in their original form
  - Translate terms that have well-established equivalents in the target language
  - Use descriptive translations for complex technical concepts when direct translations don't exist
  - Maintain consistency across all technical terminology within the same language

#### Web implementation (Radix)
On web, `BaseModal` renders a Radix `Dialog` (portal to `document.body`) so focus, scroll, and pointer events behave correctly when stacking modals (including when an Expo Router / Vaul drawer is already open).

**Critical invariant:** Radix “singleton” stacks (DismissableLayer / FocusScope) must be shared across *all* dialogs. With Metro + package `exports`, mixing ESM and CJS entrypoints can load *two* Radix module instances and break focus/stacking.

- Use the CJS entrypoints via `sources/utils/radixCjs.ts` (`requireRadixDialog()` / `requireRadixDismissableLayer()`) for any web dialog primitives.
- Wrap stacked dialog content with `DismissableLayer.Branch` so underlying Radix/Vaul layers don’t treat the top dialog as “outside” and dismiss.
- Only the top-most modal should render a backdrop; `ModalProvider` handles this via `showBackdrop`.

#### Native implementation (iOS/Android)
On native, stacking a React Navigation / Expo Router modal screen with an RN `<Modal>` can produce “invisible overlay blocks touches” and z-index ordering bugs.

- `BaseModal` renders a “portal-style” overlay inside the current screen tree (absolute fill + high `zIndex`) so touches/focus stay within the same navigation presentation context.
- `Modal.alert()` / `Modal.confirm()` use the native system alert UI on iOS/Android (good accessibility + expected platform UX).
- `Modal.prompt()` uses the app prompt modal on all platforms for consistent behavior (since `Alert.prompt` is iOS-only).

#### Popovers (menus/tooltips)
Use the app `Popover` + `FloatingOverlay` for menus/tooltips/context menus.

- Use `portal={{ web: { target: 'body' }, native: true }}` when the anchor is inside overflow-clipped containers (headers, lists, scrollviews).
- For settings-style lists, prefer `ItemList` as the popover boundary (it provides a `PopoverBoundaryProvider` for the screen ScrollView). Avoid binding popover boundaries to `ItemGroup` containers, which can incorrectly clamp dropdown sizing/placement.
- When a popover must be constrained to a scroll container, pass the **scroll container ref** as the boundary (`DropdownMenu popoverBoundaryRef=...` / `Popover boundaryRef=...`). Do not use a nested non-scroll wrapper `View` ref unless you intentionally want viewport-wide bounds and have validated scroll alignment on web.
- When the backdrop is enabled (default), `onRequestClose` is required (Popover is controlled).
- For context-menu style overlays, prefer `backdrop={{ effect: 'blur', anchorOverlay: ..., closeOnPan: true }}` so the trigger stays crisp above the blur without cutout seams.
- On web, portaled popovers are wrapped in Radix `DismissableLayer.Branch` (via `radixCjs.ts`) so Expo Router/Vaul/Radix layers don’t treat them as “outside”.

#### Settings Screens And Item Groups (Required)
- Treat settings list screens as two separate concerns:
  - existing objects/items
  - creation/attachment actions
- `ItemGroup` / `ItemList` sections that represent a list of existing objects must contain only real items from that list. Do not place detached `Create`, `Add`, `Attach`, `Link`, or similar action rows inside the same item group as the real items.
- Put list-level creation/attachment actions in a separate item group below the list (for example: workspaces list above, `Create workspace` group below; locations list above, `Attach location` group below).
- If an action logically applies to one item, surface it on that item via row actions / item action affordances instead of detached rows elsewhere in the list.
- When a screen has both “manage” and “launch/use” actions, keep management primary in management screens (for example workspace detail, location list, checkout list). Launching/starting a session can still exist, but should usually be a row action rather than the dominant row tap affordance.
- Prefer consistency with existing settings screens such as profiles, secrets, and other list-driven settings surfaces.
- Do not surface internal implementation/domain terms like `graph` in user-facing settings copy unless explicitly required by product language. Prefer user-intent labels such as `Workspace Sync Status`, `Workspace Status`, `Locations`, `Checkouts`, `Worktrees`, etc.

#### Workspace vs Worktree UX (Required)
- `Workspace` is a Happier product concept (defaults, linking locations/devices, sync relationships). `Worktree` is a source-control concept. Worktrees must remain usable even when no workspace exists.
- Do not make worktree creation/usage depend on first creating a workspace. Users should be able to start a session in a new or existing worktree without creating a workspace first.
- New-session UX should optimize for user intent, not internal models. Prefer one clear checkout/worktree choice surface over multiple overlapping workspace/worktree chips or redirects into workspace creation.
- Do not redirect session creation into workspace creation just because the selected folder is not already part of a workspace. Workspace creation should stay an explicit action from a settings/session management surface, while session launches infer workspace membership automatically when it already exists.
- Worktrees belong in source-control management surfaces. Workspaces should not consume large vertical space inside the source-control sidebar unless product design explicitly calls for it.

## Folder Structure & Naming Conventions

These conventions are **additive** to the guidelines above. The goal is to keep screens and sync logic easy to reason about.

### Naming
- Buckets are lowercase (e.g. `components`, `hooks`, `sync`, `utils`).
- Feature folders are `camelCase` (e.g. `newSession`, `agentInput`, `profileEdit`).
- Avoid `_folders` except Expo Router special files (e.g. `_layout.tsx`) and `__tests__`.
- Allowed `_*.ts` markers (organization only) inside module-ish folders: `_types.ts`, `_shared.ts`, `_constants.ts`.

### Screens and feature code
- Expo Router routes live in `sources/app/**`.
- Keep route files (Expo Router) as the screen entrypoints; extract non-trivial UI/logic into `sources/components/**`.
</ui_app_critical_rules>
<critical_git_safety_rules>
## Git Safety (Non-Negotiable)
- **Never switch branches in the primary checkout.** LLMs MUST NOT run `git checkout` / `git switch` in the primary worktree.
- **Branch creation/deletion is restricted.** Only create/delete branches if requested explicitly to do so.
- **NEVER use `git reset`, `git restore`, `git clean`, `git checkout -- <file>`, or any other destructive commands without user approval.** If you see unrelated changes/work to what you expect, NEVER discard them without explicit user confirmation. Many agents/LLMs may be working on the same task concurrently, so "unrelated" changes is expected and you should NEVER discard them, except via explicit user instruction.

- Do **not** create ad-hoc summary/report/status files.
- Before marking work complete, ensure there are no stray `*_SUMMARY.md` / `*_ANALYSIS.md` files or similar; delete unapproved summaries.
</critical_git_safety_rules>
<internal_packages>
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
- “invalid package.json configuration… exports … dist/FILE.js does not exist”

Fixes/guardrails:
- Build the workspace: `yarn workspace @happier-dev/protocol build` (or the relevant package).
- Stack builds call `ensureWorkspacePackagesBuiltForComponent` (`apps/stack/scripts/utils/proc/pm.mjs`) before running Expo/Metro to fail fast and/or build missing internal workspace outputs.

### Packaging sanity checks (do these when touching bundling/deps)
- Run the `apps/cli` script tests around bundling.
- Validate the tarball contents:
  - `cd apps/cli && node scripts/bundleWorkspaceDeps.mjs && npm pack`
  - Ensure protocol deps appear under `package/node_modules/@happier-dev/protocol/node_modules/**` (not duplicated at `package/node_modules/**` unless `apps/cli` imports them directly).
</internal_packages>
<binary_safe_critical_rules>
## Binary-Safe Runtime Contract (CRITICAL)

Happier ships binary installers. Treat binary-safe runtime behavior as a correctness requirement for first-party features.

### Required design rule
- Any new first-party runtime path must work when Happier is installed from our binary installers on a machine that does **not** have system `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx`.

### Do not introduce these directly in product runtime paths
- `spawn('node', ...)`
- direct runtime calls to `npm`, `npx`, `pnpm`, `yarn`, `bunx`
- direct shell-installer execution from UI/daemon/runtime code
- PATH-only provider detection as the sole source of truth

These may only appear behind the centralized managed runtime/tooling abstractions.

### Provider/runtime classification is mandatory
Before adding or changing a provider/runtime/install/update flow, classify it explicitly as one of:
- system-first backend CLI
- managed-first internal prerequisite
- managed package
- vendor install recipe
- managed JS runtime dependent

### Resolution consistency
- Provider detection, install status, daemon validation, runtime spawning, and UI/installables must reuse the same managed tool/source-of-truth.
- Backend CLIs must prefer the user/system install by default over any Happier-managed install unless an explicit source-preference setting says otherwise.

### Reviewer checklist
- Does this runtime path still work on a machine with no system Node/package manager?
- If both system and managed backend CLIs exist, does resolution prefer the system one by default?
</binary_safe_critical_rules>
<tdd_execution_rules>
## TDD Execution

### Mandatory Workflow

#### 1. RED Phase: Write Tests First
Write tests BEFORE any implementation code. Tests MUST fail initially.
If the change is truly content-only (Markdown/templates/UI) and no executable behavior is changed, do not add tests that pin content; just run the relevant existing checks. If the change does not make sense to be tested because it is too trivial and tests for this would be "tests just for the sake of writing tests" and that would be over-engineered, do not add tests. If tests already exists for the change you are applying, update the existing tests.

**Verify RED Phase**:
Execute targeted tests, and prove that they FAIL for the right reason (feature/behavior missing)

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
Execute targeted tests, and prove that they PASS

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
</tdd_execution_rules>
<context7_knowledge_refresh>
## Context7 Knowledge Refresh (CRITICAL)

Use Context7 MCP to refresh your knowledge **before** implementing or validating when work touches any configured post-training package.
</context7_knowledge_refresh>

## Rules

### RULE.CONTEXT.CWAM_REASSURANCE: Context window anxiety management (CWAM)
Keep working methodically and protect context:
- Prefer small, deterministic steps over rushing.
- Avoid pasting large logs; summarize and reference artifacts by path.
- If approaching limits, follow the project's compaction/recovery guidance.

### RULE.CONTINUATION.NO_IDLE_UNTIL_COMPLETE: Do not stop early; continue until your task/work is complete
- Continue iterating until your task/work is FULLY complete and validated
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

CRITICAL: Do not stop early; continue until your task/work is complete
- Continue iterating until your task/work is FULLY complete and validated
- Do not stop early when work remains.

CRITICAL: Do not add “content policing” tests
Never add tests (or assertions inside otherwise-good tests) whose primary purpose is to lock down wording/copy, whitespace, Markdown formatting, or docs/example config files. If a content-only change breaks an existing test, fix the test to assert stable behavior instead of exact strings.

CRITICAL: Always do a test inventory before adding tests
Before writing any new test, search for existing coverage and update/consolidate it. Do not stack new tests on top of overlapping tests just to satisfy the TDD rule.

CRITICAL: Extend/update/refine existing tests before creating new tests
ONLY add tests that add distinct behavior/risk coverage.

CRITICAL: ALWAYS update/refactor existing tests when refactoring/changing code

CRITICAL: Mock only system boundaries, never internal behavior
Boundary mocks are allowed for external/platform interfaces. Internal domain logic, parsers, reducers, store logic, and orchestration helpers must be tested with real implementations.

CRITICAL: Keep TypeScript strict everywhere
`@ts-ignore` is forbidden. `@ts-expect-error` and `as any` require narrow scope and explicit rationale.

CRITICAL: Enforce file size and responsibility boundaries
If a file is large or multi-purpose, split it by domain/responsibility instead of expanding a monolith.

## Encryption Opt-Out / Plaintext Session Storage

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
