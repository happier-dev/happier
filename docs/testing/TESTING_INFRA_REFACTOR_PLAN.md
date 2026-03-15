# Happier — Testing Infrastructure Refactor Plan (Architecture + Execution)

Date: 2026-02-27  
Inputs: `/Users/leeroy/Documents/Development/happier/dev/docs/testing/TESTING_INFRA_AUDIT_TRACKER.md`

This plan is intentionally concrete and file-oriented. It is designed to:
- eliminate **dead/unwired tests**
- reduce brittleness (“string/log policing”) while preserving (or increasing) confidence
- remove duplication by extracting shared testkit/infra primitives
- improve speed by moving expensive work out of tight lanes and by sharding orchestration-heavy suites
- unify lane discovery so “where does this test run?” is obvious and enforceable

**Quick navigation**
- Architecture + phases: sections `0–3`
- Suite backlog: section `4`
- Acceptance criteria: section `5`
- Open questions: section `6`
- Mechanical execution protocol: section `7`
- Full file inventory: Appendix A
- Hotspot index (mechanical flags): Appendix B
- Verbatim tracker extracts (duplication candidates, lane maps, unwired inventory): Appendix C

---

## 0) How we proceed (incremental, low-risk)

The tracker is large. The safest way to refactor without losing confidence is:

1) **Lock the current lane contract** (what runs where) and add “no dead tests” enforcement first.  
2) **Extract shared infra** (env, temp dirs, ports, process tree, JSONL tailing, fetch stubs).  
3) **De-brittle** by replacing fragile assertions with stable, observable contracts (status codes, structured payloads, typed invariants).  
4) **Speed work** (sharding, prebuild caching, avoid builds inside unit tests).  
5) **Delete/merge duplicates** only after we have replacement coverage (migration-friendly).

We do this in phased PRs (“vertical slices”) with measurable acceptance criteria per phase.

### 0.1 Execution checklist (progress tracker)

Use this section as the single place to track progress end-to-end:
- When you start a step, leave it unchecked and add a short note like `(in progress; PR TBD)`.
- When you finish a step, flip it to `[x]` and add the PR number(s) / commit SHA(s).
- Do not mark a phase complete until all its steps are complete.

**Phases & steps**
- [ ] Phase 1 — Correctness first: eliminate dead/unwired tests
  - [ ] 1A Website contract → Release Contracts lane
  - [ ] 1B CLI `prepack-script.test.mjs` → Release Contracts lane
  - [ ] 1C Make `packages/tests/src/testkit/**` tests run (or re-home/delete)
  - [ ] 1D Ensure `packages/release-runtime` node:test lane runs in CI
  - [ ] 1E Ensure `packages/agents` Vitest suite runs in PR CI
  - [ ] 1F Ensure node:test “infra packages” run in PR CI (`packages/cli-common`, `packages/release-runtime`, `packages/relay-server`)
  - [ ] 1G Resolve `uiWeb.baseUrl.spec.ts` allowlist drift (core fast vs core)
- [ ] Phase 2 — Add enforcement: “No dead tests” and “No hidden skips”
  - [ ] 2A Add `test:wiring` validator + wire into CI
  - [ ] 2B Replace silent early-returns with explicit `skip`/fail policy (tmux)
- [ ] Phase 3 — Shared platform primitives (within `packages/tests/src/testkit/*`)
  - [ ] 3A Extract/standardize runner-agnostic primitives (env/tempdir/pathbin/wait/jsonl/text)
  - [ ] 3B Add runner adapters (Vitest/node:test) where needed
- [ ] Phase 4 — De-brittle (reduce string/log policing, keep confidence)
  - [ ] 4A Fetch mocking standardization (stop pinning `Response` internals)
  - [ ] 4B Replace “log substring required” with structured outcomes where possible
  - [ ] 4C UI hook perf contracts: keep small set + shared rerender-count harness; remove identity policing elsewhere
  - [ ] 4D Export-smoke tests → real behavior or consolidated surface checks
  - [ ] 4E Server rate-limit specs → consolidate/table-drive + add enforcement tests
- [ ] Phase 5 — De-dup via extraction + table-driven tests
  - [ ] 5A Unify dotenv parsing semantics (stack vs pipeline)
  - [ ] 5B Windows spawn shim tests → one harness
  - [ ] 5C Provider scenarios: single source of truth
  - [ ] 5D Encrypted RPC helpers in core-e2e → one testkit primitive
  - [ ] 5E Core-e2e update “finders” → unify in `updates.ts`
  - [ ] 5F Reduce “call-forwarding” tests with huge dependency mocks
- [ ] Phase 6 — Speed & flake reduction (without losing coverage)
  - [ ] 6A Stop building inside “unit” test execution
  - [ ] 6B Shard heavy suites (core-e2e slow, ui-e2e) instead of weakening them
  - [ ] 6C Naming enforcement to keep slow tests out of fast lanes
- [ ] Phase 7 — Simplify and unify lane configs
  - [ ] 7A Factor `packages/tests` Vitest configs through one base builder
  - [ ] 7B Align docs with reality (CI vs docs drift)
  - [ ] 7C Remove misleading `apps/ui` Vitest e2e globs (E2E is Playwright-only)
  - [ ] 7D Add `packages/protocol` test typecheck (CI-only)

**Suite-level waypoints (optional but recommended)**
- [ ] `packages/tests` core-e2e: wiring + de-brittle + speed work complete (see section 4)
- [ ] `packages/tests` ui-e2e (Playwright): selectors/testIDs + DB assertions policy + sharding complete (see section 4)
- [ ] `apps/ui` unit/integration: hook perf contracts + defaults policing cleanup + harness extractions complete (see section 4)
- [ ] `apps/cli` unit/integration: “no build in unit” + win32 shim harness + cache/probe table-driving complete (see section 4)
- [ ] `apps/server` integration/dbcontract: canonical harness + template reset strategy complete (see section 4)
- [ ] `scripts/release` + `scripts/pipeline` contracts: table-driven publishers + shared CLI helpers complete (see section 4)

---

## 1) What we know about the current testing infrastructure (from the tracker)

### Runners & suites

- **Vitest unit/integration**:
  - `packages/protocol`
  - `packages/agents` (via repo-root `vitest.config.ts`)
  - `apps/ui` (unit + integration)
  - `apps/cli` (unit + integration + slow)
  - `apps/server` (unit + integration + db-contract)

- **node:test**:
  - `apps/stack` (unit + integration scripts)
  - `packages/relay-server`, `packages/cli-common`, `packages/release-runtime`
  - `scripts/release/**` + `scripts/pipeline/**` via `yarn test:release:contracts`

- **packages/tests** (integration/e2e):
  - Vitest: `core-e2e`, `providers`, `stress` (wrapped by `scripts/run-vitest-with-heartbeat.mjs`)
  - Playwright: `suites/ui-e2e/**/*.spec.ts`

### Canonical gating & discovery

- Feature gating: filename marker `*.feat.<featureId>.*`
  - canonical implementation: `scripts/testing/featureTestGating.ts`
  - env inputs: `HAPPIER_BUILD_FEATURES_ALLOW`, `HAPPIER_BUILD_FEATURES_DENY`, `HAPPIER_TEST_FEATURES_DENY`, plus embedded-policy envs.

- `packages/tests` discovery is intentionally strict:
  - `suites/core-e2e/**/*.test.ts` + an allowlist of `src/testkit/*.spec.ts` (risk: unit-ish tests elsewhere become dead/unwired)
  - `suites/providers/**/*.test.ts`
  - `suites/stress/**/*.test.ts`
  - Playwright: `suites/ui-e2e/**/*.spec.ts`

### Known correctness gaps (dead/unwired tests)

These are already explicitly identified in the tracker and must be addressed first:

- `/Users/leeroy/Documents/Development/happier/dev/packages/agents/src/**/*.spec.ts` (suite: `packages/agents`)  
  **Unwired in default PR CI**: CI workflows do not invoke `yarn workspace @happier-dev/agents test` (no references found under `.github/workflows/*`). These tests only run when someone runs root `yarn test:unit` (which CI does not appear to run as a single lane) or runs the workspace test directly.

- `/Users/leeroy/Documents/Development/happier/dev/apps/website/tests/index.release.test.js`  
  **Unwired**: no lane/CI runs `node --test apps/website/tests/*.test.js`.

- `/Users/leeroy/Documents/Development/happier/dev/apps/cli/scripts/prepack-script.test.mjs`  
  **Unwired**: node:test file inside a Vitest-owned package; no lane includes it.

- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/harness/harnessEnv.test.ts`  
  **Unwired** by current `packages/tests` include globs.

- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts`  
  **Unwired** by current `packages/tests` include globs.

- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts`  
  **Unwired** by current `packages/tests` include globs.

- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts`  
  **Partially unwired**: present on disk and included by `packages/tests/vitest.core.config.ts`, but the tracker notes it is **not** included by `packages/tests/vitest.core.fast.config.ts` (so it does not run in the default CI “core fast” job). Decide whether it should (a) be promoted into the fast allowlist, (b) be moved into `vitest.core.slow`, or (c) remain “core-only” and ensure CI actually runs core (not only fast+slow split).

- `packages/release-runtime/tests/*.test.mjs`  
  Tracker notes these run only in that package’s node:test lane and appear **unwired in CI** (not part of default gates).

### Cross-suite duplication hotspots

The tracker’s “Cross-suite duplication candidates” section enumerates many repeated patterns. The highest ROI categories:
- fetch mocking (`Response` + stub global fetch) repeated across protocol/server/ui/tests
- dotenv parsing duplicated: `apps/stack/scripts/utils/env/dotenv.mjs` vs `scripts/pipeline/env/parse-dotenv.mjs`
- testID sanitizing duplicated across UI + UI-e2e specs
- Windows spawn shim tests duplicated across CLI `.win32*Shim` tests
- duplicated JSONL tailing/log polling/process-tree termination helpers
- duplicated provider scenario catalogs with some files appearing unwired/unimported
- repeated “call-forwarding” tests with huge dependency mocks (low-signal, high maintenance)
- repeated “rateLimit config exists” route-registration specs (low-signal duplication)

### Known brittleness themes to address

- **String/log policing** where it’s not a stable contract:
  - asserting exact log lines (instead of structured outcomes)
  - pinning long “help/copy” strings that are not compatibility contracts
  - pinning external tool stderr fragments too widely

- **Identity/memoization policing** (UI hooks) that pins implementation strategy rather than behavior.

### Known speed hotspots

- `apps/cli` unit lane can trigger a build in `globalSetup` (`apps/cli/src/test-setup.ts`), which is expensive for “unit”.
- `packages/tests` core-e2e runner wrapper forces `--no-file-parallelism`, which favors determinism but increases wall-clock time.
- Playwright UI-e2e is orchestration-heavy and must be treated as a dedicated “slow but high signal” lane; we should shard it rather than make it flakier.

---

## 2) North-star architecture (what “good” looks like)

### 2.1 Hard invariants

1) **No dead tests**: every test-like file is either:
   - executed by a configured lane (unit/integration/e2e/providers/stress/contracts), or
   - explicitly marked as intentionally unwired (rare) and excluded by a documented rule.

2) **Behavior-first assertions**:
   - Prefer observable contracts: return values, state changes, HTTP responses, persisted rows, emitted events.
   - Mock only boundaries (OS/time/random/env/network/3p).
   - When logs/strings are asserted: assert stable tokens/ids or minimal substrings that represent a public contract.

3) **One source of truth** for shared semantics:
   - feature gating (already centralized)
   - dotenv parsing semantics
   - JSONL tailing + polling
   - process tree termination
   - env override + restore
   - “reserve port” helpers
   - common provider scenario catalog

4) **Lane budgets and ownership**:
   - Unit lanes: fast, deterministic, minimal orchestration.
   - Integration lanes: real-ish IO allowed, but bounded and isolated.
   - E2E lanes: orchestration-heavy, sharded, and allowed to be slow.
   - Contracts lane: file/workflow/script invariants; should be fast and deterministic.

### 2.2 Proposed shared “testing platform” layering (inside `packages/tests`)

To remove duplication without creating tangled cross-app dependencies, we standardize on:

- **Runner-agnostic primitives** (no Vitest/Playwright imports):
  - env overrides + restore
  - temp dir + temp PATH bin
  - polling/wait helpers
  - JSONL tailing
  - port reservation
  - process-tree kill
  - stripAnsi

- **Runner adapters** layered on top:
  - Vitest adapter (`vi` integration, global restore hooks)
  - node:test adapter (test context integration)
  - Playwright adapter (test steps, artifacts)

**Concrete packaging proposal (locked):** the “platform” is the existing set of `packages/tests` testkit primitives:
- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/process/*`
- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/network/*`
- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/timing*` (file + folder)
- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/env.ts`
- plus add narrowly-scoped domain folders only when needed (first candidate: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/fs/*`).

This avoids creating a new top-level `_platform/` tree while still giving us a single canonical place to put runner-agnostic infra.

Notes / constraints:
- `packages/tests` is TypeScript-first; Vitest/Playwright can import TS directly, but **node:test `.mjs` contract tests under `scripts/` can’t** without a build step. For node:test suites, keep a tiny JS mirror in `/Users/leeroy/Documents/Development/happier/dev/scripts/testing/nodeTest/*` where needed.
- If other workspaces import from `@happier-dev/tests`, enforce “test-only” usage (no production imports) via a simple lint/validator rule in Phase 2.

---

## 3) Refactor plan (phased, file-oriented)

### Phase 1 — Correctness first: eliminate dead/unwired tests

**Goal:** after this phase, “if it exists, it runs” (or it is explicitly migrated/deleted).

#### 1A) Consolidate website contract into the Contracts lane (recommended)

Rationale: the website test is a release/docs contract and overlaps with existing installer contract enforcement under `scripts/release/**`.

Planned changes:
- ADD: `/Users/leeroy/Documents/Development/happier/dev/scripts/release/website_index_release_html.contract.test.mjs`
  - port the assertions from `apps/website/tests/index.release.test.js`
  - keep assertions minimal and stable:
    - anchor existence (`#self-host`, `#get-started`)
    - installer endpoints present (`/install`, `/self-host`) without pinning full curl line copy unless it’s a public doc contract
- DELETE (or deprecate): `/Users/leeroy/Documents/Development/happier/dev/apps/website/tests/index.release.test.js`
- OPTIONAL: remove/empty `/Users/leeroy/Documents/Development/happier/dev/apps/website/tests/` if no longer used.

Wiring:
- `yarn test:release:contracts` already runs `node --test scripts/release/*.test.mjs scripts/release/*/*.test.mjs scripts/pipeline/**/*.test.mjs`
  - so the new contract test becomes automatically wired.

Related fixture file (no behavior change; keep):
- `/Users/leeroy/Documents/Development/happier/dev/apps/website/index.release.html` (contract target)

#### 1B) Fix `apps/cli/scripts/prepack-script.test.mjs` wiring by moving it to Contracts

Rationale: it’s a packaging contract; Contracts lane is already designed for this.

Planned changes:
- ADD: `/Users/leeroy/Documents/Development/happier/dev/scripts/release/cli_prepack_files.contract.test.mjs`
  - either (a) move assertions wholesale, or (b) merge into an existing CLI packaging contract test if one exists
- DELETE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/scripts/prepack-script.test.mjs`

#### 1C) Make `packages/tests/src/testkit/**` unit tests actually run

Pick one coherent strategy (recommended: a dedicated “testkit unit” lane):

Planned changes:
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/vitest.testkit.config.ts`
  - includes: `src/testkit/**/*.test.ts`, `src/testkit/**/*.spec.ts`
  - excludes: anything orchestration-heavy by folder (e.g. `src/testkit/process/**` only if it’s safe), or by suffix (require `*.unit.*` if needed)
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/package.json`
  - new script: `test:testkit`: `node scripts/run-vitest-with-heartbeat.mjs --config vitest.testkit.config.ts`
- ADD: `/Users/leeroy/Documents/Development/happier/dev/package.json`
  - new root lane: `test:testkit` → `yarn workspace @happier-dev/tests test:testkit`
  - add `test:testkit` to CI fast gate (or at least PR gate)
- UPDATE CI: `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml`
  - add a job (or step in existing `packages/tests` job group) to run `yarn test:testkit`

Direct beneficiaries (currently dead/unwired):
- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/harness/harnessEnv.test.ts`
- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts`
- `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts`

#### 1D) Ensure `packages/release-runtime` tests are executed in CI

Pick one:
- Option A (recommended): include in root unit gate.
- Option B: include in Contracts lane (less ideal; they’re crypto/download correctness, not “workflow contracts”).

Planned changes (Option A):
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/package.json` `test:unit`
  - append: `yarn --cwd packages/release-runtime test`
- UPDATE CI: `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml`
  - ensure the unit job includes that package (or runs root `yarn test:unit` if that’s the canonical CI entrypoint).

Acceptance criteria for Phase 1:
- A “test wiring validator” (Phase 2) reports zero dead tests.
- CI executes website contract + CLI prepack contract + testkit unit lane + release-runtime tests.

---

### Phase 2 — Add enforcement: “No dead tests” and “No hidden skips”

**Goal:** prevent regressions where new tests are added but not wired, and prevent silent “green without running”.

#### 2A) Add a repo-wide “test wiring validator” script

Planned new file(s):
- ADD: `/Users/leeroy/Documents/Development/happier/dev/scripts/testing/validateTestWiring.mjs`
  - scans for test-like files by patterns:
    - `**/*.{test,spec}.?(c|m)[jt]s?(x)`
    - `**/*.integration.{test,spec}.*`, `**/*.dbcontract.spec.*`, `**/*.slow.e2e.test.*`, `**/*.spec.ts` (Playwright)
  - compares against lane discovery rules (source-of-truth is `package.json` scripts + vitest/playwright configs)
  - fails if any test-like file is not selected by any lane unless it matches an explicit allowlist of “intentionally unwired” patterns.
  - additionally enforces “test-only” imports from `@happier-dev/tests`:
    - fail if any non-test file under `apps/**/src/**`, `apps/**/sources/**`, or `packages/**/src/**` imports `@happier-dev/tests` (or deep paths under it)
    - allow imports only from `**/*.{test,spec}.**` and from known test runner entrypoints (e.g. `vitestSetup.ts`, `test-setup.ts`) when explicitly intended.

Wiring:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/package.json`
  - add `test:wiring` script: `node scripts/testing/validateTestWiring.mjs`
- UPDATE CI: `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml`
  - run `yarn -s test:wiring` early (fast fail).

#### 2B) Make “dependency missing” skips explicit

Known problematic pattern (from duplication candidates):
- tmux tests that `return` early inside `it(...)` (reports green but never ran)

Planned changes:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts`
  - replace early `return` with:
    - `it.skip(...)` with a clear reason, or
    - a harness `withTmuxAvailable()` that **fails in CI** (if tmux is required there) and **skips locally** with an explicit marker.

---

### Phase 3 — Extract shared test platform primitives (de-dup + reliability)

**Goal:** remove repeated boilerplate and unify semantics (env restore, polling, JSONL parsing, process termination).

#### 3A) Formalize `packages/tests/src/testkit/*` as the shared “platform” (runner-agnostic primitives)

Planned new files:
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/fs/withTempDir.ts`
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/fs/withTempPathBin.ts`
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/text/stripAnsi.ts`
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/jsonl/tailJsonl.ts`
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/wait/waitFor.ts`

Planned updates to existing platform entrypoints:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/env.ts`
  - add `withEnvOverrides(...)` (canonical save/restore pattern; supports partial overrides and deletion)
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/network/reserveAvailablePort.ts`
  - keep as canonical; delete any shadow copies elsewhere
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/process/processTree.ts`
  - keep as canonical; converge `packages/tests/scripts/processTree.mjs` onto it (or a shared core)

Then migrate duplicates to use it:

Port reservation duplication:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/process/uiWeb.ts` (use canonical reserve helper)

stripAnsi duplication:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/process/uiWeb.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/ui/text.mjs` (either delegate or standardize on one impl)
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/backends/claude/cli/command.settingsFlag.test.ts` (use shared)

JSONL/log polling duplication:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/toolTraceJsonl.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/fakeClaude.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/waitForRegexInFile.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/harness/index.ts` (readJsonlEvents)

Process-tree termination duplication:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/scripts/processTree.mjs`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/process/processTree.ts`
  - converge on one implementation and have both scripts and TS harness use the same core.

Env override duplication:
- UPDATE many files currently saving/restoring `process.env` manually (notably providers harness tests):
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/providers/harness.inFlightSteer.*.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/providers/harness.tokenTelemetry.acpStub.e2e.test.ts`
  - plus other suites matching this pattern

Optional follow-on (cross-workspace adoption):
- UPDATE other workspaces’ *test code* to import from `@happier-dev/tests/src/testkit/*` (devDependency only), where it removes large duplication:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/**/*.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/**/*.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/**/*.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/**/*.test.mjs` (for these, prefer the node-test JS mirrors rather than TS imports)

#### 3B) Runner-specific adapters (thin)

Vitest adapter helpers (live close to suites; keep `packages/tests/src/testkit/*` runner-agnostic):
- ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/vitest/withStubbedFetch.ts`
- ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/testkit/vitest/withPlatform.ts`
- ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/dev/testkit/vitest/withStubbedFetch.ts`

node:test adapter helpers (for scripts/stack/release contracts; keep JS mirrors where TS imports are impractical):
- ADD: `/Users/leeroy/Documents/Development/happier/dev/scripts/testing/nodeTest/withStubbedFetch.mjs`
- ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/test/withTempPathBin.mjs` (or reuse a JS mirror from `/Users/leeroy/Documents/Development/happier/dev/scripts/testing/nodeTest/*` where shared)

---

### Phase 4 — De-brittle tests (reduce string/log policing, keep confidence)

**Goal:** replace fragile “implementation-copy” assertions with stable, high-signal contracts.

#### 4A) Standardize fetch mocking and stop pinning Response internals

Planned changes:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.submit.test.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.similarIssues.test.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/providers/github/*.spec.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/engine/*/*.test.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/providers/daemon.stop.failureContext.test.ts`

Refactor rule:
- Assert on *inputs/outputs* (URL, method, parsed body, returned typed value), not on exact `Response` object shapes or header casing unless it’s a compatibility contract.

#### 4B) Replace “log string required” assertions with structured outcomes where possible

Examples called out in the tracker:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/featureNegotiation.buildPolicy.enforcement.slow.e2e.test.ts`
  - replace “wait for log substring” with:
    - a structured capability/feature endpoint check, or
    - a deterministic API behavior check (route present/absent), or
    - a structured diagnostic artifact emitted by the daemon (preferred long term).

General rule:
- If the only surface is logs, assert on a stable token (error code / event type) and centralize the token list in one place.

#### 4C) Reduce brittle “identity/memoization” policing in UI hook tests

Locked policy: performance matters, but “identity everywhere” is not the default contract.
- Keep a **small, explicit “hook perf contract” set** for 1–3 performance-critical hooks (document which hooks + why).
  - These tests may assert referential stability *only for the documented contract hooks* and only for “no-op” state changes that should not invalidate results.
  - Prefer asserting “no unnecessary rerender” via a deterministic counter (shared harness) over pinning React warning copy.
- For all other hooks: remove identity assertions; test observable behavior only (returned values, derived subsets, compatibility under store updates).

Hook perf contract candidates (initial; confirm during implementation):
- `useMessagesByIds`
- `useSessionMessages`
- `useUserMessageHistory` (history navigation is sensitive to extra recomputation)

Shared harness extraction:
- ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/react/renderHookWithRerenderCount.tsx`
  - one canonical way to seed the real storage store, render a hook, trigger a controlled store update, and count rerenders deterministically.

Planned file targets:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/store/hooks.useMessagesByIds.test.tsx`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/store/hooks.useSessionMessages.test.tsx`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/hooks/session/useUserMessageHistory.navigatorStability.test.tsx`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/hooks/session/useUserMessageHistory.sessionMessagesSelector.test.ts`
- plus other hook tests referenced by the tracker’s duplication bullet.

#### 4D) Replace scattered export-smoke tests with real behavior or single surface checks

Planned changes:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.fallback.test.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.reporter.test.ts`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/http/client.runtimeFetch.test.ts`

Rule:
- If goal is “public export exists”, do one table-driven export surface test per package.
- Otherwise, delete existence-only asserts and replace with behavior tests.

#### 4E) Server route “rateLimit exists” specs → consolidate or replace with enforcement tests

Planned changes (pattern-wide):
- UPDATE many files under `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/**/**/*.rateLimit.spec.ts`
  - consolidate into one table-driven spec that asserts stable rate-limit invariants for a list of routes, and keep unique cases separate.
  - where possible, add a small number of behavior-level tests (429 enforcement) rather than “config exists”.

---

### Phase 5 — Reduce duplication by extraction & table-driven testing

This phase implements the “Cross-suite duplication candidates” as concrete refactors.

#### 5A) Unify dotenv parsing semantics

Planned changes:
- CHOOSE canonical parser: `/Users/leeroy/Documents/Development/happier/dev/scripts/pipeline/env/parse-dotenv.mjs`
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/env/dotenv.mjs`
  - either delegate to canonical parser or share tokenizer + stack-specific policy layer (`~` expansion, etc).

Acceptance:
- one semantics definition; tests cover multiline quoting + expansion policy; both stack and pipeline use it.

#### 5B) Windows spawn shim tests → one harness

Planned changes:
- ADD harness: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/testkit/vitest/win32ShimHarness.ts`
- UPDATE existing `.win32CmdShim.test.ts` / `.win32NpmShim.test.ts` files to use harness:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/backends/claude/utils/mcpConfigMerge.test.ts` (and other `.win32*` tests listed in tracker)
  - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/capabilities/deps/codexAcp.win32NpmShim.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/capabilities/deps/codexMcpResume.win32NpmShim.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/capabilities/snapshots/cliSnapshot.win32CmdShim.test.ts`
  - etc (replace repeated platform override + spawn stubs).

#### 5C) Provider scenarios: enforce single source of truth

Planned changes:
- CONFIRM canonical: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts`
- DELETE or MERGE dead/unwired scenario arrays:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts`
- UPDATE docs referencing old scenario sources:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/README.md`

#### 5D) Encrypted RPC call helpers in core-e2e → one testkit primitive

Planned changes:
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/encryptedRpc.ts`
  - exports: `encryptedRpcCall({ target, id, method, req, schema, timeoutMs })`
- UPDATE call sites:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/executionRuns.*.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/ephemeralTasks.*.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/memory.*.test.ts`

#### 5E) Core-e2e update “finders” → unify in `updates.ts`

Planned changes:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/updates.ts`
  - add typed finders (update kind/body filters, sessionId normalization)
- UPDATE call sites:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/reconnect.*.test.ts`

#### 5F) Reduce “call-forwarding” tests with huge dependency mocks

Targets explicitly called out:
- Protocol action executor tests:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/actions/actionExecutor.*.test.ts`
  - extract typed deps builder + table-driven cases; assert outcomes rather than call plumbing.

- UI tests that mock deep internals to assert a component calls a hook:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/__tests__/app/**`
  - refocus to user-observable outcomes and reduce internal mocks.

---

### Phase 6 — Speed & flake reduction (without losing coverage)

#### 6A) Stop building inside “unit” test execution

Current issue:
- `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/test-setup.ts` can run `yarn build` as part of unit tests.

Plan:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/package.json`
  - split tests into:
    - `test:unit:ts` (pure TS, no dist dependency)
    - `test:unit:dist` (requires build; fewer files)
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/vitest.config.ts`
  - ensure dist-dependent tests are named/patterned distinctly (e.g. `*.dist.test.ts`) and excluded from the pure unit lane.
- UPDATE CI: `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml`
  - run build once, then run dist-dependent tests with `HAPPIER_CLI_TEST_SKIP_BUILD=1`.

#### 6B) Shard the heavy suites rather than weakening them

- Playwright UI-e2e:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/playwright.ui.config.mjs`
    - introduce sharding in CI (Playwright supports `--shard`), keep local default simple.
  - UPDATE CI: `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml`
    - run UI-e2e in N shards, merge reports/artifacts.

- `packages/tests` core-e2e:
  - keep `--no-file-parallelism` if it’s essential for determinism, but shard by test file sets across jobs.

#### 6C) Remove “slow in fast lane” risks via naming enforcement

Add a validator rule (in `validateTestWiring.mjs`):
- any file under `packages/tests/suites/core-e2e/` that uses heavy orchestration must be:
  - `*.slow.e2e.test.ts` (slow lane), or
  - explicitly allowlisted as safe in fast lane (rare).

---

### Phase 7 — Simplify and unify lane configs

#### 7A) Factor `packages/tests` Vitest configs through one base builder

Planned changes:
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/vitest/_baseConfig.ts`
- UPDATE:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/vitest.core.config.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/vitest.core.fast.config.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/vitest.core.slow.config.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/vitest.providers.config.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/vitest.stress.config.ts`

#### 7B) Align docs with reality (CI vs docs drift)

Tracker notes docs claim pglite coverage but CI appears sqlite-only for default gates.

Planned changes:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/docs/content/docs/development/testing.mdx`
  - reflect the actual CI DB providers, or
- UPDATE CI: `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml`
  - add explicit pglite coverage if desired.

#### 7C) Remove misleading `apps/ui` Vitest e2e globs (E2E is Playwright-only)

Rationale: `apps/ui` Vitest configs currently include a `sources/**/*.e2e.test.{ts,tsx}` glob, but there are no matching files. Keeping the glob invites future drift (adding “e2e” tests that are not Playwright E2E).

Planned changes:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/vitest.config.ts`
  - remove `sources/**/*.e2e.test.{ts,tsx}` from the include list
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/vitest.integration.config.ts`
  - remove `sources/**/*.e2e.test.{ts,tsx}` from the include list
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/scripts/testing/validateTestWiring.mjs`
  - add a rule: any `apps/ui/sources/**/*.e2e.test.*` is disallowed (recommend `packages/tests/suites/ui-e2e/**/*.spec.ts` instead)

#### 7D) Add `packages/protocol` test typecheck (CI-only)

Rationale: `packages/protocol` currently runs `tsc` on production sources but does not typecheck `src/**/*.{test,spec}.ts`. Vitest catches many errors, but an explicit typecheck improves refactor safety for tests.

Planned changes:
- ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/tsconfig.tests.json`
  - includes `src/**/*.{test,spec}.ts` and references the main tsconfig options
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/package.json`
  - add a `test:typecheck` script (CI-only)
- UPDATE CI: `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml`
  - run `yarn workspace @happier-dev/protocol test:typecheck` in PR CI (or fold into an existing “typecheck” job), but do not add it to default local `yarn test` unless we later decide it’s fast enough.

---

## 4) Suite-by-suite refactor backlog (tracker-driven, concrete)

This section converts the audit tracker into a suite-oriented execution plan.
It is intentionally redundant with the phase plan above: phases describe *ordering*; suites describe *scope/ownership*.

### Website — `apps/website` (currently unwired)

Primary problem: the suite is a release/docs contract but has **no lane**; it is dead/unwired.

Planned changes:
- ADD: `/Users/leeroy/Documents/Development/happier/dev/scripts/release/website_index_release_html.contract.test.mjs`
  - Move the contract checks here so `yarn test:release:contracts` wires it automatically.
  - De-brittle: assert on anchors + presence of installer endpoints without pinning full curl lines unless those strings are a published compatibility contract.
- DELETE: `/Users/leeroy/Documents/Development/happier/dev/apps/website/tests/index.release.test.js`
- KEEP as fixture/contract target: `/Users/leeroy/Documents/Development/happier/dev/apps/website/index.release.html`

Open question:
- Do we want *any* tests to run under `apps/website` directly? If yes, add a dedicated `website:contracts` lane; if no, keep all website contracts in release contracts.

### Release Contracts — `scripts/release/**` + `scripts/pipeline/**` (node:test)

This lane is high-value and intentionally “contract heavy”, but it is also the single largest concentration of:
- regex-based YAML/script pinning
- copy/command string pinning
- duplicated “contract skeletons” across many files

The goal is **not** to “make contracts vague”; it’s to:
- encode contracts as structured assertions (parse YAML, parse JSON, parse shell sections where feasible)
- table-drive repeated patterns
- keep only the truly stable/public invariants pinned

Key consolidation epics (from tracker) + concrete file targets:

1) Table-drive “publisher version tags + invalid minisign key” contracts
- UPDATE (replace 4 near-identical tests with one table-driven file + helper):
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/publish_cli_binaries_version_tags.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/publish_hstack_binaries_version_tags.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/publish_server_runtime_version_tags.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/publish_ui_web_version_tags.contract.test.mjs`
- ADD:
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/_contractHelpers/publishVersionTags.ts` (JS or `.mjs` helper; node:test compatible)
  - (or keep helper in same file if preferred; but central helper reduces drift)

2) Consolidate duplicated publisher scripts into a parameterized harness
- UPDATE (thin wrappers):
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/pipeline/release/publish-cli-binaries.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/pipeline/release/publish-hstack-binaries.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/pipeline/release/publish-server-runtime.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/pipeline/release/publish-ui-web.mjs`
- ADD:
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/pipeline/release/_publisher/publishProduct.mjs`
    - shared skeleton: minisign bootstrap + key preflight, optional contracts gate, optional installer sync check, build artifacts, publish manifests, verify, publish rolling + version tags
    - product-specific hooks injected as callbacks/config
- De-brittle: reduce reliance on exact stdout strings in the scripts; return structured status objects where possible.

3) Replace regex-heavy workflow assertions with structured YAML checks where possible
Targets (high brittleness):
- UPDATE many workflow contract tests under:
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/*.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/*.contract.test.mjs`
- ADD helper:
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/_contractHelpers/loadWorkflowYaml.mjs`
    - parse YAML once and assert on structured keys/steps (avoid regex pins that break on formatting-only changes)
- Concrete file list (from tracker; migrate these to structured YAML assertions first):
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/build_tauri_release_tags.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/build_tauri_workflow.production_signing_gate.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/build_ui_mobile_local_passes_apple_api_private_key.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/build_ui_mobile_local_uses_ui_mobile_release.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/deploy_workflow.inputs_contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/deploy_workflow_push_caller.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/deploy_workflow_uses_trigger_webhooks_script.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/docker_publish.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/promote_branch.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/promote_docs_deploy_branch.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/promote_server_deploy_branch.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/promote_server_runtime_release.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/promote_ui_deploy_branch.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/promote_ui_mobile_tags.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/promote_website_deploy_branch.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/publish_github_release.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/publish_server_runtime.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/publish_ui_web.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/release_dev_to_main_workflow.inputs_contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/release_titles.workflow.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/tests_workflow.binary_smoke_timeout.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/tests_workflow.daemon_e2e_lane.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/tests_workflow.installers_preview_smoke.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/tests_workflow.installers_smoke.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/tests_workflow.self_host_daemon.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/workflow_node_version_policy.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/workflow_pipeline_prereqs.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/workflow_secret_hardening.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/workflows_node_script_paths.contract.test.mjs`

4) Installer contract tests: keep the contract, reduce copy pinning
Targets:
- UPDATE tests asserting verbose/debug behavior and tar filtering:
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_verbose_mode.contract.test.mjs`
- UPDATE scripts under contract:
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers/install.sh`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers/self-host.sh`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers/install.ps1`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers/self-host.ps1`
- Plan: keep behavioral invariants pinned (flags, env support, debug implies verbose, tmp dir retention), but avoid pinning exact help formatting/copy beyond small stable tokens.
- Concrete file list (from tracker; prioritize de-brittling “string policing” tests first):
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_asset_lookup_robustness.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_cli_actions.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_cli_etxtbsy_atomic_swap.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_daemon_autostart.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_default_channel_preview.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_minisign_bootstrap_arch.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_no_github_token.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_path_update_guidance.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_published_sync.test.mjs` (also absorbs `apps/website` public scripts parity)
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_security.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_self_host_actions.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_self_host_channel_flag.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_self_host_runtime_smoke.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_self_host_tar_noise_and_guidance.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_sync.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_verbose_mode.contract.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/scripts/release/installers_windows_default_channel_preview.test.mjs`

Open questions:
- Which workflow “step strings” are truly contracts vs incidental implementation? If a workflow is refactored but still calls the same pipeline command, our tests should accept it.
- Do we want to keep all workflow contracts in node:test, or move some to a dedicated “CI wiring schema” module that can be validated structurally?

### Unit — `packages/release-runtime` (node:test; currently not in default CI gates)

Primary problems:
- tests are good (boundary-mocked fetch; real crypto), but the suite appears **unwired in CI**
- minisign verification fixtures overlap with relay-server minisign verification tests

Planned changes:
- UPDATE CI wiring:
  - `/Users/leeroy/Documents/Development/happier/dev/package.json` (ensure `yarn --cwd packages/release-runtime test` is executed by `yarn test:unit` or equivalent CI gate)
  - `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml` (ensure it runs)
- De-dup minisign fixtures:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/release-runtime/tests/minisign.test.mjs`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/release-runtime/tests/verifiedDownload.test.mjs`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/src/minisign.verify.test.mjs`
  - ADD (in release-runtime, since relay-server depends on it): `/Users/leeroy/Documents/Development/happier/dev/packages/release-runtime/src/testFixtures/minisignFixtures.mjs` (or `.js` in dist) with a stable “generate keypair + sign checksums text” helper
 - Make the suite’s contract surface explicit (and keep it stable):
   - KEEP as canonical tests:
     - `/Users/leeroy/Documents/Development/happier/dev/packages/release-runtime/tests/assets.test.mjs` (release asset naming + selection)
     - `/Users/leeroy/Documents/Development/happier/dev/packages/release-runtime/tests/extractPlan.test.mjs` (archive extraction planning contract)
     - `/Users/leeroy/Documents/Development/happier/dev/packages/release-runtime/tests/github.test.mjs` (GitHub release fetch contract; uses fetch stubs)
     - `/Users/leeroy/Documents/Development/happier/dev/packages/release-runtime/tests/minisign.test.mjs` (minisign verify guardrails)
     - `/Users/leeroy/Documents/Development/happier/dev/packages/release-runtime/tests/verifiedDownload.test.mjs` (end-to-end verified download with real crypto)
   - OPTIONAL: extract a tiny node:test-friendly fetch stub helper for consistent error shapes:
     - ADD: `/Users/leeroy/Documents/Development/happier/dev/scripts/testing/nodeTest/fetchStub.mjs`
     - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/release-runtime/tests/github.test.mjs`

Open question:
- Should relay-server keep its own minisign tests, or should it rely on release-runtime tests + a thin “integration smoke” only?

### Unit — `packages/cli-common` (node:test; appears unwired in CI)

Primary problems:
- suite appears **unwired/dead in CI**, but it’s shared infra and should be tested regularly
- suite always rebuilds via `tsc` before node:test, which may be expensive if added to fast gates

Planned changes:
- Wire into default gates:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/package.json` `test:unit` to include `yarn --cwd packages/cli-common test` (or introduce `test:infra` lane and run it in CI fast gate)
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml` accordingly
- Speed improvement (optional):
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/package.json`
    - allow `HAPPIER_CLI_COMMON_TEST_SKIP_BUILD=1` to skip rebuild when CI already built `dist/`
  - ADD a contract test ensuring `dist/` is present when skipping build
 - De-dup and de-brittle within the suite (file-oriented):
   - KEEP (already high-signal, low brittleness; just migrate any shared fixtures once extracted):
     - `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/exports.test.mjs` (exports surface/packaging smoke)
     - `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/workspaces.test.mjs` (repo-root discovery)
     - `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/tailscale.serveStatus.test.mjs` (tailscale serve-status parsing)
   - UPDATE (extract shared Windows cmd/npm shim harness; avoid repeated platform/env mutation boilerplate):
     - `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/providers.test.mjs`
     - `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/update.test.mjs`
     - ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/_harness/win32CmdNpmShims.mjs` (node:test-friendly, no TS build requirement)
   - UPDATE (extract shared “fake repo + dep-a → dep-b node_modules graph” scaffold):
     - `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/vendorBundledPackageRuntimeDependencies.test.mjs`
     - (and later) `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/scripts/bundleWorkspaceDeps.test.mjs`
     - ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/_harness/fakeRepoNodeModulesGraph.mjs`
   - UPDATE (service planning/apply tests: remove string/arg-order pinning where it’s not a contract; prefer structured plans):
     - `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/service.test.mjs`
     - ADD: `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/_harness/servicePlanAssertions.mjs` (assert on typed plan shape: units/paths/commands)
   - EITHER keep or de-brittle link strings depending on contract strictness:
     - `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/links.test.mjs`
       - Option A: keep exact strings (treat as public deep-link contract)
       - Option B: assert on parsed URL components (scheme, host, query keys) and allow minor formatting changes

### Unit/Integration — `packages/relay-server` (node:test)

The suite is already included in root `yarn test:unit` (per tracker), but has duplication overlaps:
- minisign tests overlap with release-runtime (handled above)
- “bundle workspace deps / vendor deps” overlaps with other packages (handled under platform extraction)

Planned changes:
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/scripts/bundleWorkspaceDeps.test.mjs` (when we extract the shared fake repo/node_modules graph builder)
- UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/src/minisign.verify.test.mjs` (use shared fixture builders from release-runtime)
 - Consider PR CI coverage:
   - If we want these unit/packaging contracts to run on every PR, UPDATE:
     - `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml` to run `yarn --cwd packages/relay-server test`
   - If we only want them on release jobs, document that intent explicitly in this plan and in CI docs.
 - Concrete file list (so we can refactor deterministically):
   - `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/scripts/bundleWorkspaceDeps.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/src/checksums.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/src/minisign.verify.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/src/releaseAssets.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/src/runnerConfig.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/packages/relay-server/src/target.test.mjs`

### Unit/Integration — `apps/stack` (node:test; large)

Primary problems (from tracker):
- huge amount of repeated boilerplate: temp PATH bins, temp git fixtures, polling loops, port reservation, process ownership/termination utilities
- substantial brittleness pinned to exact command strings, stdout shapes, and platform-specific behavior

Refactor approach:
- Keep `apps/stack` test runner as node:test, but standardize helpers under:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/test/*`
  - and mirror a small subset in `/Users/leeroy/Documents/Development/happier/dev/scripts/testing/nodeTest/*` if shared outside stack.

Concrete helper extraction (from tracker duplication bullets):
- ADD:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/test/withTempPathBin.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/test/withTempDir.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/test/waitFor.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/test/withTempGitFixture.mjs`
- UPDATE (use these helpers broadly across `apps/stack/scripts/**/*.test.mjs`):
  - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/git/{default_branch,dev_checkout,fast_forward_to_remote}.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/expo/*.test.mjs`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/proc/*.test.mjs`
  - plus other stack tests matching those patterns
 - Make the “integration” suffix boundary enforceable (reduce accidental parallelism for side-effectful tests):
   - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/test_integration.mjs`
     - add a guard: any file matching `*.real.integration.test.mjs` must run with `--test-concurrency=1` (already intent), and CI must never run them with a broader glob without that flag.
 - Concrete list: `apps/stack` integration + real-integration tests (refactor targets for harness extraction + de-brittle work):
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/auth_copy_from_pglite_lock_in_use.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/auth_copy_from_runCapture.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/auth_status_server_validation.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/daemon_invalid_auth_reseed_stack_name.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/daemon_start_verification.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/exit_cleanup_kills_detached_children_on_crash.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/mobile_run_ios_passes_port.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/monorepo_port.apply.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/monorepo_port.conflicts.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/monorepo_port.validation.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/pglite_lock.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/release_binary_smoke.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/self_host_binary_smoke.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/self_host_daemon.real.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/self_host_launchd.real.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/self_host_schtasks.real.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/self_host_systemd.real.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stack_archive_cmd.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stack_daemon_cmd.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stack_happy_cmd.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stack_resume_cmd.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stack_shorthand_cmd.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stack_stop_sweeps_legacy_infra_without_kind.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stack_stop_sweeps_when_runtime_missing.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stack_stop_sweeps_when_runtime_stale.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stopStackWithEnv_kills_ephemeral_runtime_pids_without_env_markers.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stopStackWithEnv_no_autosweep_when_runtime_missing.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/stopStackWithEnv_sweeps_repo_local_stack_by_stackName_when_runtime_missing.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/swiftbar_render_monorepo_wt_actions.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/tui_stopStackForTuiExit_no_autosweep.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/proc/pm_spawn.integration.test.mjs`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/worktrees_archive_cmd.integration.test.mjs`

Open question:
- Should we keep these helpers stack-local, or should we migrate node:test-compatible helpers into `/Users/leeroy/Documents/Development/happier/dev/scripts/testing/nodeTest/*` for reuse by release contracts too?

### UI E2E — `packages/tests` (Playwright)

Primary problems:
- high brittleness from:
  - `getByText(...)` copy assertions (localization/copy churn)
  - reliance on server-light sqlite schema + `sqlite3` CLI on PATH in several specs
  - deep-link routing and multi-process orchestration pinned to exact timings

De-brittle priorities (concrete targets from tracker):
- UPDATE (remove copy assertions; prefer stable testIDs and structured API checks):
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/encryptionOptOut.publicShare.plaintext.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/auth.terminalConnect.daemon.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/auth.pairing.addPhone.desktopQrMobileScan.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/encryptionOptOut.modeSwitch.readBoth.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/session.fork.fromMessage.spec.ts`
- UPDATE (remove sqlite3 CLI dependency where feasible):
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/auth.mtls.autoRedirect.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/auth.mtls.terminalConnect.daemon.spec.ts` (verify: no sqlite3 usage; align selectors with shared helpers)
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/auth.oauth.keyed.github.restore.lostAccess.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/auth.oauth.keyless.autoRedirect.github.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/auth.oauth.provisioningChoice.optional.plain.github.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/auth.terminalConnect.daemon.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/permissionPrompts.composerCard.jumpToTool.spec.ts` (ensure no copy assertions; use testIDs)
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/root.serverOverride.reachability.noManualRetry.spec.ts` (ensure readiness checks use structured probes, not timeouts)
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/session.fork.fromMessage.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/session.panes.urlSync.backForward.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/session.transcript.catchup.reconnect.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/session.transcript.catchup.smallReconnect.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/settings.systemStatus.diagnosis.spec.ts` (prefer stable diagnostic tokens, not copy)

Shared helper work:
- ADD (Playwright-side helpers to avoid copy pinning):
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/uiE2e/selectors.ts` (stable selectors by testID; no text)
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/uiE2e/assertions.ts` (small, stable assertions)
- UPDATE existing Playwright harness where it reimplements testID sanitizing:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/session.sourceControl.reviewScroll.spec.ts` (use canonical sanitizer; remove local regex)

Speed improvements:
- Shard Playwright in CI:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/tests.yml`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/playwright.ui.config.mjs`

Open question:
- Do we accept schema-level DB assertions in UI-e2e? If yes, replace sqlite3 CLI dependency with a Node sqlite client packaged as a devDependency of `@happier-dev/tests`. If no, remove DB assertions and rely on HTTP endpoints + UI state.

### `packages/tests` — Core E2E (Vitest fast/slow)

Primary problems:
- duplicated encrypted RPC call helpers across many tests
- duplicated update “finder” patterns and event-shape probing (flake risk)
- duplicated JSONL tailing + polling across testkit modules
- some tests hardcode `apps/cli/node_modules/*` paths (brittle)
- tmux tests may silently “pass without executing”

Concrete refactors:
- ADD:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/encryptedRpc.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/jsonl.ts` (canonical JSONL tail + parse)
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/acpSdkPaths.ts` (resolve ACP/MCP SDK entry paths without hardcoding `apps/cli/node_modules/*`)
- UPDATE:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/executionRuns.*.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/ephemeralTasks.*.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/memory.*.test.ts`
  - to use `encryptedRpcCall(...)`
- UPDATE:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/updates.ts` (add typed finders)
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/reconnect.*.test.ts`
- UPDATE tmux tests to never silently return:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts`

- UPDATE tests currently hardcoding `apps/cli/node_modules/*` SDK paths to use `acpSdkPaths.ts`:
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/codex.acp.inFlightSteer.pendingQueue.slow.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/opencode.acp.modelOverride.slow.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/opencode.acp.slashCommandsExtraction.slow.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/core-e2e/permissions.metadataUpdate.midTurn.slow.e2e.test.ts`

### `packages/tests` — Providers (Vitest)

Primary problems:
- scenario catalogs duplicated, with dead/unwired scenario files
- env save/restore boilerplate repeated (leak risk)
- token ledger summary logic duplicated between scripts and harness
- “real probe” tests are wired but effectively opt-in and can silently do nothing

Concrete refactors:
- Canonical scenario catalog:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts`
  - DELETE or MERGE:
    - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts`
  - UPDATE docs:
    - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/README.md`
- Env override helper:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/env.ts` (add `withEnvOverrides(...)`)
  - UPDATE provider harness tests to use it (instead of manual env snapshots)
- Token ledger:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/providers/harness/tokenLedger.ts`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/scripts/provider-token-ledger-summary.mjs`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/scripts/run-providers-parallel.mjs`
  - to share one canonical “ledger aggregation” module
- Make opt-in probes explicit in output:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/providers/claude.agentTeams.toolNames.realProbe.test.ts`
    - emit an explicit `test.skip` with reason when env is unset, rather than defining zero tests (so CI report shows it was skipped intentionally).

### Stress — `packages/tests` (Vitest)

Primary problems:
- duplicates core-e2e harness patterns (server-light, sockets, polling)

Plan:
- After platform primitive extraction + JSONL/polling consolidation, migrate stress harness usage to the canonical helpers to reduce drift.
- Concrete file list (current stress suite inventory):
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/stress/reconnect.chaos.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/stress/reconnect.repeat.test.ts`

### Integration — `apps/server` (Vitest)

Primary problems:
- many specs are brittle + slow because they duplicate:
  - temp dir + env replacement/restore
  - Prisma migrations / DB bootstrap
  - Fastify app boot patterns
- many tests pin route strings and internal DB table details

Concrete refactor:
- ADD a single integration harness:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/dev/testkit/integration/serverIntegrationHarness.ts`
    - provisions temp dirs, runs migrations once per suite/file (where safe), provides typed `withServerApp({ envOverrides, dbProvider })`
    - provides stable helpers for “create auth + seed rows + request”
- UPDATE and/or wrap the existing canonical sqlite harness (avoid inventing a second bootstrap path):
  - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/testkit/lightSqliteHarness.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts`
  - Goal: `serverIntegrationHarness.ts` should delegate to `lightSqliteHarness` (and optionally a future “template DB” path) rather than duplicating env + migration + cleanup logic.
- UPDATE high-cost integration specs to use harness:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/auth/authRoutes.*.integration.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.*.integration.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.encryption.*.integration.spec.ts`
 - Full current integration-spec inventory (migrate in batches; each file should stop hand-rolling env/tempdir/migrations and delegate to the harness):
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.encryption.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.encryption.keylessRejectE2ee.feat.e2ee.keylessAccounts.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.encryption.migrate.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.identityVisibility.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.profile.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.settingsV2.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.v2usage.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountUsername.feat.social.friends.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/artifacts/artifactsRoutes.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/auth/authRoutes.accountAuth.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/auth/authRoutes.mtls.feat.auth.mtls.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/auth/authRoutes.pairingAuth.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/auth/authRoutes.policy.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/auth/authRoutes.terminalAuth.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/automations/automationDaemonRoutes.feat.automations.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/changes/changesRoutes.automation.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV2.feat.connectedServices.quotas.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV3.plaintext.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV2.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV3.plaintext.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthCallback.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.keyless.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthParams.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.githubCallback.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.githubCallback.oauthStateAuthFlow.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.githubUsernameFlow.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.oidcAllowlist.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.oidcAuthFlow.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.oidcRefreshToken.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.oidcUserInfo.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.vendorTokenDelete.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/connect/connectRoutes.vendorTokens.presence.feat.connectedServices.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/features/featuresRoutes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/machines/machinesRoutes.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/machines/machinesRoutes.claimExisting.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/machines/machinesRoutes.revoke.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/machines/machinesRoutes.updateExisting.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/push/pushRoutes.clientServerUrl.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/session/pendingRoutes.delete.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/session/pendingRoutes.enqueue.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/session/pendingRoutes.materialize.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/share/publicShareRoutes.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/share/publicShareRoutes.plaintext.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/user/friendsGithubGate.feat.social.friends.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/user/userRoutes.badges.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/socket.authPolicy.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/socket.redisAdapter.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/socket/artifactUpdateHandler.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/socket/machineUpdateHandler.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/socket/rpcHandler.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/socket/sessionUpdateHandler.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/socket/sessionUpdateHandler.sessionState.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/socket/sessionUpdateHandler.versionMismatch.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/utils/enableAuthentication.authPolicy.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/utils/enableMonitoring.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/utils/logRedaction.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/auth.oauthState.ttl.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/enforceLoginEligibility.accountDisabled.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/providers/github/githubConnect.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/providers/github/githubConnect.identityCollision.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/providers/github/githubConnect.tokenStorage.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/providers/github/githubDisconnect.changes.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/providers/github/githubLoginEligibility.upstreamFailure.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/providers/oidc/oidcIdentityProvider.connect.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/auth/providers/oidc/oidcOffboardingRefresh.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/automations/automationClaimService.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/automations/automationCrudService.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/automations/automationRunService.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/events/eventRouter.sessionRoomIsolation.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/presence/presenceRedisQueue.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/session/pending/pendingMessageService.sharedSession.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/startServer.dbProvider.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/startServer.lightShutdownOrder.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/startServer.redisOptional.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/startServer.voiceLeaseCleanup.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/storage/prisma.pglite.integration.spec.ts`
   - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts`

De-brittle guidelines:
- prefer asserting on response codes + structured JSON shape, not on DB table names or internal cursor math unless it’s the public contract.

Open question:
- Should integration lane always run migrations per file for isolation, or can we introduce a “template DB” per worker to speed up?

### DB Contract — `apps/server` (Vitest)

This lane is already well-scoped and high-signal: it validates cross-provider portability invariants using a *real* DB (Postgres/MySQL) and Prisma.

Planned changes:
- KEEP the suite narrow and portability-only (do not duplicate app integration tests here).
- If we need a shared provider parser, extract it once and reuse:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/storage/dbcontract/portability.dbcontract.spec.ts`
  - ADD (optional): `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/storage/dbcontract/resolveDbContractProviderFromEnv.ts`
    - shared with integration harness (if applicable), so provider selection is consistent across lanes.
- Mitigate long-lived DB bloat in repeated runs (only if it becomes a real problem):
  - Option A: keep randomUUID uniqueness (current) and accept bloat (simple).
  - Option B: add a `beforeAll`/`afterAll` cleanup for the specific rows created (requires stable tagging).

Concrete file list (from tracker):
- `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/storage/dbcontract/portability.dbcontract.spec.ts`
- `/Users/leeroy/Documents/Development/happier/dev/apps/server/vitest.dbcontract.config.ts`

### Unit — `apps/server` (Vitest)

Primary problems:
- many duplicated “rateLimit config exists” specs
- repeated “feature gate default + env override” micro-specs across represented features
- repeated `*.changes.spec.ts` emission harness patterns

Concrete refactors:
- Consolidate rateLimit specs:
  - UPDATE these route-registration specs (collapse into 1–3 table-driven specs + keep only truly custom cases):
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/account/accountRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/artifacts/artifactsRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/changes/changesRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/features/featuresRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/feed/feedRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/kv/kvRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/machines/machinesRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/auth/registerPairingAuthRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/session/pendingRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/session/sessionRoutes.listing.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/session/sessionRoutes.messages.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/session/sessionRoutes.messagesByLocalId.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/share/shareRoutes.rateLimit.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.rateLimit.spec.ts`
  - ADD:
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/dev/testkit/rateLimit/assertRateLimitRegistered.ts`
  - GOAL:
    - keep “config exists” checks only where rate-limit registration is the contract; add a small number of enforcement tests (429) for the highest-risk routes instead of duplicating config asserts everywhere.
- Consolidate “feature gate default/env override” patterns:
  - UPDATE feature-gate micro-specs (table-drive defaults + env overrides + build-policy deny once):
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/authFeature.feat.auth.methods.connectAction.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/authFeature.feat.auth.methods.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/authFeature.feat.auth.mtls.autoRedirect.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/authFeature.feat.auth.oauthKeyless.autoRedirect.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/authFeature.feat.auth.ui.recoveryKeyReminder.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/attachmentsUploadsFeature.feat.attachments.uploads.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/automationsFeature.feat.automations.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/bugReportsFeature.feat.bugReports.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/connectedServicesFeature.feat.connectedServices.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/friendsFeature.feat.social.friends.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/updatesFeature.feat.updates.ota.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/voiceFeature.feat.voice.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/catalog/serverFeatureGate.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/features/catalog/resolveServerFeaturePayload.spec.ts`
  - ADD shared helper to evaluate gate parsing + build policy deny once
- Consolidate change-emission harness:
  - ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/dev/testkit/changes/assertChangeEmitted.ts`
  - UPDATE:
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/social/friends.changes.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/social/usernameUpdate.changes.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/kv/kvMutate.changes.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/session/sessionDelete.changes.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/feed/feedPost.changes.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/server/sources/app/api/routes/share/shareRoutes.changes.spec.ts`

### Unit/Integration/Slow — `apps/cli` (Vitest)

Primary problems:
- duplicated Windows shim tests
- duplicated ACP fake agent harness + subprocess polling
- duplicated “trailing JSON after preamble” tests across profiles
- unit lane speed hotspot: `apps/cli/src/test-setup.ts` can build dist

Concrete refactors:
- Windows shim harness:
  - ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/testkit/vitest/win32ShimHarness.ts`
  - UPDATE these tests to use the harness:
    - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/agent/reviews/engines/coderabbit/CodeRabbitReviewBackend.win32CmdShim.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/capabilities/deps/codexAcp.win32NpmShim.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/capabilities/deps/codexMcpResume.win32NpmShim.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/capabilities/probes/acpProbe.win32CmdShim.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/capabilities/snapshots/cliSnapshot.win32CmdShim.test.ts`
- ACP harness:
  - ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/testkit/vitest/acpHarness.ts`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/agent/acp/**/__tests__/*.test.ts`
- Parse trailing JSON once:
  - ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/agent/executionRuns/runtime/parseTrailingStrictJson.ts` (or equivalent)
  - UPDATE:
    - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/agent/executionRuns/profiles/delegate/DelegateProfile.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/agent/executionRuns/profiles/plan/PlanProfile.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/agent/executionRuns/profiles/review/ReviewProfile.test.ts`
- Remove build from unit loop:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/test-setup.ts`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/vitest.config.ts`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/package.json`
  - so pure unit tests don’t require dist; dist-dependent tests move to integration/slow lane.
- Fix feature-gated excludes to respect merged dotenv env (avoid CI/local drift for `.feat.<featureId>.` files):
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/vitest.config.ts`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/cli/vitest.integration.config.ts`
  - Goal: `resolveVitestFeatureTestExcludeGlobs(...)` should receive the same env object as the rest of the config (`{...process.env, ...testEnv}`), not raw `process.env`.

### Unit/Integration — `apps/ui` (Vitest; very large)

Primary problems:
- heavy global mocking in `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/vitestSetup.ts` + per-file re-mocking (drift)
- large clusters of low-signal wiring tests (mock-the-world scaffolds)
- repeated mega fixtures and defaults policing
- repeated harness patterns (ChatList, SettingsView, SCM snapshots, connected services quotas, server-scoped ops, socket update harness)

Concrete refactor epics (file targets from tracker):
- Unify MMKV stubbing strategy:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/vitestSetup.ts`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/domains/state/persistence.test.ts`
- Consolidate settings defaults policing:
  - UPDATE:
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/domains/settings/settings.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/domains/settings/settings.providerPlugins.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/domains/settings/localSettings.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/domains/settings/voiceSettings.spec.ts`
  - Goal: reduce to 1–2 canonical “defaults invariants” tests; move the rest to migration/validation behavior tests.
- Extract typed fixture builders (reduce `as any` and giant inline objects):
  - ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/fixtures/scmFixtures.ts`
  - UPDATE:
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/scm/scmRepositoryService.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/scm/scmStatusFiles.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/scm/registry/scmUiBackendRegistry.test.ts`
- Reduce low-signal “server-scoped routing” duplication:
  - ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/serverScopedOpHarness.ts`
  - UPDATE:
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/__tests__/sessionArchive.serverScope.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/__tests__/sessionDelete.serverScope.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/__tests__/sessionStop.serverScope.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/sessions.serverScoped.test.ts`
    - plus other `apps/ui/sources/sync/ops/machines.*.test.ts` files following that pattern
- Split reducer monolith + extract builders:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducer.spec.ts`
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/phase0-skipping.spec.ts`
  - ADD builders:
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/fixtures/messages.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/fixtures/tools.ts`

Concrete high-churn file clusters (explicit lists from the tracker) + what changes:

1) Transcript/ChatList clusters (extract one harness; remove timing/impl-detail pinning)
- ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/chatListHarness.tsx`
  - provides: deterministic transcript fixtures, controlled “virtualized list” stubs, stable “scroll to bottom/pinned” helpers, and structured assertions (“rendered messages in order”, “auto-follow toggles when pinned”).
- UPDATE (migrate each to use the harness; remove identity/time/pixel policing unless explicitly a contract):
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.autoFollowWhenPinned.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.pinOnContentChange.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.unpinnedNoWheel.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.forkedTranscript.dividerAndOrigin.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.forwardPrefetch.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.initialScrollBehavior.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.jumpToBottom.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.nullSession.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.thinkingExpansionControlled.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.turnGroupingMode.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/transcript/ChatList.turnThinkingExpansionWiring.test.tsx`

2) Settings view clusters (extract one harness; stop copy policing)
- ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/settingsViewHarness.tsx`
  - provides: stable state seeds for machines/servers/runs, stable selectors via testIDs, and helpers for “open settings → navigate to panel → assert panel state”.
- UPDATE:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/settings/SettingsView.addYourPhone.web.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/settings/SettingsView.connectTerminal.native.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/settings/SettingsView.multiServerMachines.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/settings/SettingsView.runsEntry.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/settings/SettingsView.serversEntry.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/settings/connectedServices/ConnectedServicesSettingsView.quotas.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/settings/memory/MemorySettingsView.rpc.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/settings/session/TranscriptRenderingAdvancedSettingsView.performance.test.tsx`

3) Server-scoped context clusters (extract shared context builder; remove duplicated local-cache fiddling)
- ADD (if the earlier `serverScopedOpHarness.ts` doesn’t fully cover it): `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/serverScopedContextHarness.ts`
  - provides: one canonical way to build “server scoped auth/context”, seed local cache, and assert which server is used without pinning internal call sequences.
- UPDATE:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/app/(app)/new/pick/machine.serverScope.spec.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/auth/storage/tokenStorage.serverScopeMismatch.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/auth/storage/tokenStorage.serverScoped.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/machines/InstallableDepInstaller.serverScope.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/sessions/shell/SessionItem.serverScopeMutation.test.tsx`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/api/session/apiSocket.request.serverScopedAuth.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/__tests__/sessionArchive.serverScope.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/__tests__/sessionDelete.serverScope.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/__tests__/sessionStop.serverScope.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/capabilities.serverScoped.integration.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/machines.serverScoped.integration.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/sessions.serverScoped.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc.retry.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage.test.ts`

4) Socket engine clusters (reduce timing flake; centralize socket test harness)
- ADD: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/socketHarness.ts`
  - provides: deterministic fake socket server/client, explicit “apply update” helpers, and stable assertions on state transitions without waiting on real timers.
- UPDATE:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/engine/socket/socket.automationUpdates.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/engine/socket/socket.cursorIsolation.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/engine/socket/socket.newMachineUpdates.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/engine/socket/socket.scmInvalidation.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/engine/socket/socketEmitWithAckFallback.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/engine/socket/socketParse.test.ts`

5) Reducer clusters (split by responsibility; reduce duplication; keep high-signal edge cases)
- ADD builders (already above): `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/fixtures/messages.ts`, `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testkit/fixtures/tools.ts`
- UPDATE (make each test assert on stable “event → state” invariants; avoid incidental ordering/logging):
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/activityUpdateAccumulator.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/helpers/thinkingText.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/messageToEvent.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/permissionPlaceholder.toolResultOverride.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/phase0-skipping.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/phases/agentStatePermissions.execpolicyAmendment.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/phases/agentStatePermissions.requestKind.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducer.seq.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducer.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducer.streamingMerge.agentIdReuse.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducer.streamingMerge.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducer.streamingMerge.thinkingCursor.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducer.streamingMerge.thinkingInterleaved.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducer.streamingMerge.toolBoundary.test.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducerTracer.dedupe.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducerTracer.orphans.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducerTracer.sidechainLinking.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/reducerTracer.taskMapping.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/sidechains.providerAgnostic.spec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/reducer/userAndText.streaming.providerAgnostic.spec.ts`

6) In-app `*.appspec.ts` tests (currently unenforced by CI; risk of “tests that don’t run”)
- The tracker flags a custom in-app test runner:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/dev/testRunner.ts`
  - used by `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/app/(app)/dev/tests.tsx` to run tests inside the UI runtime.
- Current appspec inventory:
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/encryption/aes.appspec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/encryption/base64.appspec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/encryption/deriveKey.appspec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/encryption/hmac_sha512.appspec.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/encryption/encryptor.appspec.ts`
- Plan options (pick one and make it explicit):
  - Option A (recommended): migrate appspec cases into Vitest (`*.test.ts`) so they run in CI, then delete/retire the custom runner.
  - Option B: wire an explicit CI lane that runs the in-app runner (harder: requires building/running the UI runtime headlessly).
  - Option C: keep appspec strictly “dev-only” and document that they are not a CI contract (but then treat them as informal and avoid relying on them for correctness).

7) SCM-heavy UI integration tests (git/sapling harnesses) — reduce duplication + speed up
- The tracker notes the integration lane is dominated by real `git` / `sl` orchestration with large, overlapping coverage at multiple layers (ops-level + hook-level).
- Goals:
  - Pick one canonical integration layer per “SCM contract” (stage/patch, commit history paging, remote ops, status/diff normalization).
  - Downgrade the other layer to smaller unit tests focused on request shaping + state updates (avoid duplicating real-SCM work).
  - Consolidate harnesses + ensure deterministic teardown.
- Key harnesses to standardize around (from tracker):
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/__tests__/gitRepoHarness.ts`
  - `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/sync/ops/__tests__/saplingRepoHarness.ts`
  - (and their init/fixture tests)
- Open constraint to resolve: sapling harness assumes POSIX `/dev/null` and requires `sl` availability; decide whether sapling runs in default CI, a dedicated nightly lane, or is dev-only.

Open question:
- What is our canonical “UI integration” meaning, given integration config still runs with heavy native stubs? Do we want a third lane for “web-real integration” with fewer stubs?

### Unit — `packages/agents` / `packages/protocol` (Vitest)

Primary problems:
- protocol: call-forwarding tests with huge deps mocks (action executor) and repeated fetch stubs
- agents: provider install specs duplicated across packages

Concrete refactors:
- Fetch stubbing helper (Vitest):
  - ADD (protocol-local): `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/testkit/withStubbedFetch.ts`
  - UPDATE:
    - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.submit.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.similarIssues.test.ts`
- Action executor tests:
  - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/actions/actionExecutor.*.test.ts`
    - extract typed deps builder; table-drive dispatch maps; assert outcomes rather than wiring.
- Provider install specs:
  - UPDATE canonical: `/Users/leeroy/Documents/Development/happier/dev/packages/agents/src/providers/cliInstallSpecs.spec.ts`
  - UPDATE consumers:
    - `/Users/leeroy/Documents/Development/happier/dev/packages/cli-common/tests/providers.test.mjs`
    - `/Users/leeroy/Documents/Development/happier/dev/apps/stack/scripts/utils/cli/prereqs.mjs`
  - Goal: single source of truth for install hint data; consumer tests become “forwarding smokes”.

Concrete file inventory (so refactors are explicit and bounded):
- `packages/protocol` targets:
  - Fetch stub consolidation:
    - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.submit.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.similarIssues.test.ts`
    - (evaluate also) `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.fallback.test.ts`
    - (evaluate also) `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.reporter.test.ts`
    - (evaluate also) `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/bugReports.serverDiagnostics.test.ts`
  - Action executor wiring → table-driven outcome tests:
    - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/actions/actionExecutor.inventory.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/actions/actionExecutor.memory.test.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/actions/actionExecutor.reviewStart.test.ts`
  - Do not “de-brittle” away intentional schema constraints:
    - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/actions/actionInputElevenLabsToolSchema.test.ts` (pins constraints required by upstream)
    - `/Users/leeroy/Documents/Development/happier/dev/packages/protocol/src/actions/actionInputJsonSchema.test.ts` (pins schema shape rules)
- `packages/agents` targets:
  - Canonical provider install spec surface:
    - `/Users/leeroy/Documents/Development/happier/dev/packages/agents/src/providers/cliInstallSpecs.spec.ts`
  - Keep prompt/spec tests stable (avoid exact-copy pinning; assert on stable sections/tokens):
    - `/Users/leeroy/Documents/Development/happier/dev/packages/agents/src/sessionControls/publish.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/packages/agents/src/sessions/replay/happierReplayPrompt.spec.ts`
    - `/Users/leeroy/Documents/Development/happier/dev/packages/agents/src/voice/voiceAgentPrompt.spec.ts`

Additional critical nuance from the tracker (suite wiring + typing):
- `packages/protocol` runs a `pretest` build (`generator + tsc`) before `vitest run`, but its `tsconfig.json` excludes `src/**/*.test.ts` / `src/**/*.spec.ts`, so **tests are not typechecked by `tsc`**.
  - Option A (recommended): add a lightweight “test typecheck” path (e.g. `tsc -p tsconfig.tests.json`) that includes tests, and decide whether it runs in CI only or locally too.
  - Option B: accept that Vitest/TS runtime compilation is the primary guard for test typing and keep `tsc` focused on production build only (but then treat failures as potentially later).
- `packages/agents` does **not** run a pretest build by default; type drift may be caught only by separate build/typecheck lanes.
  - Decide whether we want uniform “build/typecheck before tests” behavior across internal packages, or whether this divergence is intentional for speed.

---

## 5) Acceptance metrics (how we know this worked)

### Correctness
- `yarn -s test:wiring` passes (0 dead/unwired test-like files).
- CI summary explicitly reports:
  - number of tests executed per lane
  - number of tests excluded by feature gating
  - number of tests skipped due to missing dependencies (and why)

### Robustness
- Reduced assertion brittleness:
  - fewer exact-copy assertions
  - fewer “log substring required” checks (replaced by structured outcomes)
  - stable identifiers preferred (error codes, status, schema shapes)

### Speed
- `yarn test:unit` target wall-clock reduced (goal set after baseline measurement).
- UI-e2e and core-e2e are sharded; single-job timeouts reduced.

### Maintainability
- Shared helpers exist and are adopted:
  - env overrides
  - fetch stubs
  - wait/poll
  - JSONL tailing
  - process tree termination
  - reserve port

---

## 6) Decisions locked (2026-02-27) + remaining open questions

### Locked decisions

1) Shared test “platform” location and naming:
   - Locked: the platform is the existing `packages/tests/src/testkit/*` primitives (not a new `_platform/` tree).
   - First expansion candidate: add `/Users/leeroy/Documents/Development/happier/dev/packages/tests/src/testkit/fs/*` and keep helpers narrowly-scoped by domain.

2) Website contract tests:
   - Locked: consolidate into the Release Contracts lane (no standalone website lane).

3) UI hook memoization/performance policy (“identity is a contract”):
   - Locked: keep performance regression coverage, but **do not** treat referential identity as a default contract across all hooks.
   - Keep only a small, explicit “hook perf contract” set for a few critical hooks; everything else should assert observable behavior.

4) Default CI coverage for pglite:
   - Locked: keep pglite out of default PR CI; update docs to match the actual lanes (and keep pglite coverage as opt-in / dedicated lane).

5) UI E2E DB assertions:
   - Locked: DB assertions are allowed when they provide high-signal end-to-end confidence, but we remove the `sqlite3` CLI dependency by using a Node sqlite client (via `packages/tests` testkit).

6) Server integration DB strategy:
   - Locked: Option B (template DB / reset strategy), implemented in staged steps:
     - Stage 1: migrate integration specs onto the canonical sqlite harness API
     - Stage 2: add template/reset under the harness
     - Stage 3: adjust parallelism/sharding once correctness is stable

7) Canonical `toTestIdSafeValue` ownership:
   - Locked: Option A — keep canonical implementation in `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/utils/ui/toTestIdSafeValue.ts` and import it from Playwright/UI-e2e.

8) PR CI coverage for node:test “infra packages”:
   - Locked: Option A — run `packages/cli-common`, `packages/release-runtime`, and `packages/relay-server` in PR CI fast gate.

9) CI vs local lane mirroring + feature-gating drift:
   - Locked: Option A — enforce single CI entrypoints per lane and fail CI if the lane map drifts (backed by `test:wiring` validator).

10) `apps/ui` “in-app” test runner (`*.appspec.ts`) policy:
   - Locked: Option A — migrate appspec tests into Vitest; retire the custom runner from being authoritative.

11) `packages/agents` PR CI:
   - Locked: Option A — explicitly run the `packages/agents` Vitest suite in PR CI.

12) `apps/ui` E2E test location & discovery:
   - Locked: **UI end-user-flow E2E** is Playwright-only and lives under:
     - `/Users/leeroy/Documents/Development/happier/dev/packages/tests/suites/ui-e2e/**/*.spec.ts`
   - There are currently **no** `apps/ui/sources/**/*.e2e.test.{ts,tsx}` files (the glob exists in configs but matches nothing).
   - Plan changes to avoid future confusion/drift:
     - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/vitest.config.ts` (remove `sources/**/*.e2e.test.{ts,tsx}` from includes)
     - UPDATE: `/Users/leeroy/Documents/Development/happier/dev/apps/ui/vitest.integration.config.ts` (remove `sources/**/*.e2e.test.{ts,tsx}` from includes)
     - UPDATE docs to make it obvious where UI-e2e lives and how to run it from a UI developer workflow (so it’s harder for humans/LLMs to miss).
     - Enforcement: `test:wiring` validator should flag any newly-added `apps/ui/sources/**/*.e2e.test.*` and recommend Playwright location instead.

13) `packages/protocol` test typechecking:
   - Locked: add a `tsc` path that includes `src/**/*.{test,spec}.ts` and run it in **CI only** (keep local iteration speed).

### Remaining open questions

None required to begin implementation. Any future design forks should be recorded here *before* execution diverges.

## 7) Mechanical per-file execution protocol (so nothing is missed)

This section is the “bridge” between the tracker’s per-file analyses and implementation PRs. It is intentionally procedural.

### 7.1 How we slice the work (PR structure)

Refactors should be shipped as a sequence of narrow PRs with clear acceptance criteria:

1) **Wiring PRs (stop dead tests):** only lane wiring + moves to fix discovery; no assertion edits beyond required renames.  
2) **Platform extraction PRs:** introduce shared primitives (env/tempdir/poll/jsonl/process-tree/ports/fetch stubs); migrate a small set of representative call sites.  
3) **De-brittle PRs:** convert copy/log policing → stable contracts; keep behavior coverage.  
4) **Speed PRs:** move slow tests to slow lanes, add sharding/caching, eliminate “build inside unit”.  
5) **De-dup PRs:** consolidate table-driven specs, remove duplicates only when replacement coverage exists.

Each PR should include a “migrated file list” in the PR description and match a single phase/epic from this plan.

### 7.2 Per-file decision checklist (apply to every file in Appendix A)

For each file path in Appendix A:

1) **Lane ownership:** confirm which lane(s) execute it (unit/integration/slow/e2e/providers/stress/contracts/db-contract).  
2) **Wiring:** if the tracker says `UNWIRED`, decide one:
   - move to the correct lane (rename/suffix or relocate), or
   - rewire a lane/config include, or
   - delete if it is duplicate and the canonical coverage already exists.
3) **Mock policy:** remove internal mocks when feasible; keep only boundary mocks (OS/time/env/3p).
4) **Assertion quality:** if brittle, replace with stable observable outcomes (schemas, status codes, state transitions, typed invariants).
5) **Duplication:** if the tracker flags duplication, extract a shared helper/harness and migrate at least 2+ call sites before deleting duplicates.
6) **Speed:** if slow/flaky, move to slower lane or shard; never “fix flake” by weakening correctness.

### 7.3 Flag-to-action mapping (Appendix B)

Appendix B provides mechanical flags per suite. Use them to drive work queues:

- `UNWIRED` → Phase 1: rewire/move/delete; then add enforcement (`scripts/testing/validateTestWiring.mjs`).
- `BRITTLE_HIGH` → Phase 4: de-brittle: remove copy policing/log policing unless it’s a deliberate public contract.
- `SLOW_HIGH` → Phase 6: move to slow lane, shard, or reduce orchestration in “unit” lanes.
- `DUPLICATION` → Phase 3/5: extract shared `packages/tests/src/testkit/*` primitives / suite harnesses / table-driven specs.


---

## Appendix A — Full audited inventory (repo-relative paths)

Source: `docs/testing/TESTING_INFRA_AUDIT_TRACKER.md` (all backticked checkbox entries).

All paths below are relative to `/Users/leeroy/Documents/Development/happier/dev`.

### Cross-suite duplication candidates (see Appendix C)

This inventory is intentionally summarized here; the full “verbatim” findings live in Appendix C and should be promoted into Phase 3/5 work items as we execute.

```text
fetch mocking harness (Response/json helpers + restore discipline)
dotenv parsing semantics (stack vs pipeline)
testID sanitizer (`toTestIdSafeValue`) reuse
UI hook perf harness (reduce repeated referential-stability boilerplate)
Windows spawn shim harness (win32 cmd/npm wrappers)
bundleWorkspaceDeps fake-repo + node_modules graph builder
publisher version tags contract tests (table-drive)
pipeline “mini CLI helpers” (bool parsing / GITHUB_OUTPUT / exec wrappers)
process-tree termination helpers (one canonical implementation)
JSONL tailing + “wait for regex in file” polling helpers (one canonical set)
PATH-bin temp stubs helper (`withTempPathBin`)
sqlite3 CLI dependency in UI-e2e (replace with Node sqlite client)
```

### Global entrypoints (count: 0)

```text
```

### CI entrypoints (grep) (count: 0)

```text
```

### Shared gating & infrastructure (count: 0)

```text
```

### Shared infra reviews (completed) (count: 29)

```text
apps/cli/src/test-setup.ts
apps/cli/src/vitestSetup.ts
apps/cli/vitest.config.ts
apps/cli/vitest.integration.config.ts
apps/cli/vitest.slow.config.ts
apps/server/vitest.config.ts
apps/server/vitest.dbcontract.config.ts
apps/server/vitest.integration.config.ts
apps/stack/scripts/test_ci.mjs
apps/stack/scripts/test_integration.mjs
apps/stack/scripts/utils/test/collect_test_files.mjs
apps/ui/sources/dev/vitestSetup.ts
apps/ui/vitest.config.ts
apps/ui/vitest.integration.config.ts
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
vitest.config.ts
```

### Unassigned test-like files (inventory gap) (count: 4)

```text
apps/cli/scripts/prepack-script.test.mjs
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
```

### CI wiring review (completed) (count: 15)

```text
.github/workflows/cli-smoke-test.yml
.github/workflows/deploy-on-deploy-branch.yml
.github/workflows/extended-db-tests.yml
.github/workflows/issue-triage-manual.yml
.github/workflows/issue-triage.yml
.github/workflows/providers-contracts.yml
.github/workflows/release-actor-guard.yml
.github/workflows/release-npm.yml
.github/workflows/release-verify.yml
.github/workflows/roadmap-add-to-project.yml
.github/workflows/roadmap-bootstrap-labels.yml
.github/workflows/stress-tests.yml
.github/workflows/tests-dispatch.yml
.github/workflows/tests.yml
apps/stack/.github/workflows/typecheck.yml
```

### Unit — packages/protocol (Vitest) (count: 114)

```text
.github/feature-policy/preview.json
.github/feature-policy/production.json
packages/protocol/package.json
packages/protocol/scripts/generate-embedded-feature-policies.mjs
packages/protocol/src/account/encryptionMode.test.ts
packages/protocol/src/account/profile.connectedServicesV2.test.ts
packages/protocol/src/account/settings/accountSettings.test.ts
packages/protocol/src/account/settings/accountSettingsStoredContentEnvelope.test.ts
packages/protocol/src/actions/actionDraftSeed.test.ts
packages/protocol/src/actions/actionExecutor.inventory.test.ts
packages/protocol/src/actions/actionExecutor.memory.test.ts
packages/protocol/src/actions/actionExecutor.reviewStart.test.ts
packages/protocol/src/actions/actionIds.test.ts
packages/protocol/src/actions/actionInputElevenLabsToolSchema.test.ts
packages/protocol/src/actions/actionInputHintsRuntime.test.ts
packages/protocol/src/actions/actionInputJsonSchema.test.ts
packages/protocol/src/actions/actionSettings.test.ts
packages/protocol/src/actions/actionSpecs.test.ts
packages/protocol/src/bugReports.fallback.test.ts
packages/protocol/src/bugReports.reporter.test.ts
packages/protocol/src/bugReports.serverDiagnostics.test.ts
packages/protocol/src/bugReports.similarIssues.test.ts
packages/protocol/src/bugReports.submit.test.ts
packages/protocol/src/changes.automation.test.ts
packages/protocol/src/common/asyncTtlCache.test.ts
packages/protocol/src/common/probedResourceCache.test.ts
packages/protocol/src/connect/buildConnectedServiceCredentialRecord.test.ts
packages/protocol/src/connect/connectedServiceErrors.test.ts
packages/protocol/src/connect/connectedServiceQuotaSnapshot.test.ts
packages/protocol/src/connect/connectedServiceSchemas.test.ts
packages/protocol/src/crypto/accountScopedCipher.test.ts
packages/protocol/src/crypto/base64.test.ts
packages/protocol/src/crypto/boxBundle.test.ts
packages/protocol/src/crypto/encryptedDataKeyEnvelopeV1.test.ts
packages/protocol/src/crypto/terminalProvisioningV2.test.ts
packages/protocol/src/daemonExecutionRuns.test.ts
packages/protocol/src/diagnostics/doctorSnapshot.test.ts
packages/protocol/src/encryption/storagePolicyDecisions.test.ts
packages/protocol/src/env/parseBooleanEnv.test.ts
packages/protocol/src/esmImportCycle.test.ts
packages/protocol/src/executionRuns.streaming.test.ts
packages/protocol/src/executionRuns.test.ts
packages/protocol/src/features.payload.test.ts
packages/protocol/src/features/buildPolicy.test.ts
packages/protocol/src/features/catalog.test.ts
packages/protocol/src/features/decision.test.ts
packages/protocol/src/features/embeddedFeaturePolicies.generated.ts
packages/protocol/src/features/embeddedFeaturePolicy.test.ts
packages/protocol/src/features/featureDecisionEngine.test.ts
packages/protocol/src/features/payload/capabilities/capabilitiesSchema.server.test.ts
packages/protocol/src/features/payload/capabilities/encryptionCapabilities.test.ts
packages/protocol/src/features/serverEnabledBit.test.ts
packages/protocol/src/index.exports.test.ts
packages/protocol/src/installables.test.ts
packages/protocol/src/memory/memorySearch.test.ts
packages/protocol/src/memory/memorySettings.test.ts
packages/protocol/src/memory/memoryWindow.test.ts
packages/protocol/src/reviews/reviewEngines.test.ts
packages/protocol/src/reviews/reviewStart.test.ts
packages/protocol/src/rpc.daemonExecutionRuns.test.ts
packages/protocol/src/rpc.executionRuns.test.ts
packages/protocol/src/rpc.memory.test.ts
packages/protocol/src/rpc.scm.test.ts
packages/protocol/src/rpc.sessionReplay.test.ts
packages/protocol/src/rpcErrors.test.ts
packages/protocol/src/scm.contract.test.ts
packages/protocol/src/scmCapabilities.test.ts
packages/protocol/src/scmPathScope.test.ts
packages/protocol/src/scmPolicy.test.ts
packages/protocol/src/serverControl/contract.test.ts
packages/protocol/src/sessionContinueWithReplay.test.ts
packages/protocol/src/sessionControl/baselines.test.ts
packages/protocol/src/sessionControl/contract.test.ts
packages/protocol/src/sessionMessages/sessionMessageMeta.test.ts
packages/protocol/src/sessionMessages/sessionStoredMessageContent.test.ts
packages/protocol/src/sessionMetadata/metadataOverridesV1.test.ts
packages/protocol/src/sessionMetadata/terminalMetadata.test.ts
packages/protocol/src/social/friends.userProfileSchema.test.ts
packages/protocol/src/storage/storedJsonContentEnvelope.test.ts
packages/protocol/src/structuredMessages/sessionSummaryShardV1.test.ts
packages/protocol/src/structuredMessages/sessionSynopsisV1.test.ts
packages/protocol/src/structuredMessages/voiceAgentTurnV1.test.ts
packages/protocol/src/tools/v2/meta.backcompat.spec.ts
packages/protocol/src/updates.automation.test.ts
packages/protocol/src/updates.sharing.test.ts
packages/protocol/src/voiceActions.test.ts
packages/protocol/tsconfig.json
packages/tests/baselines/session-control/auth_status.ok.json
packages/tests/baselines/session-control/server_add.ok.json
packages/tests/baselines/session-control/server_current.ok.json
packages/tests/baselines/session-control/server_list.ok.json
packages/tests/baselines/session-control/server_remove.ok.json
packages/tests/baselines/session-control/server_set.ok.json
packages/tests/baselines/session-control/server_test.ok.json
packages/tests/baselines/session-control/server_use.ok.json
packages/tests/baselines/session-control/session_actions_describe.ok.json
packages/tests/baselines/session-control/session_actions_list.ok.json
packages/tests/baselines/session-control/session_create.ok.json
packages/tests/baselines/session-control/session_history.ok.json
packages/tests/baselines/session-control/session_list.ok.json
packages/tests/baselines/session-control/session_run_action.ok.json
packages/tests/baselines/session-control/session_run_get.ok.json
packages/tests/baselines/session-control/session_run_list.ok.json
packages/tests/baselines/session-control/session_run_send.ok.json
packages/tests/baselines/session-control/session_run_start.ok.json
packages/tests/baselines/session-control/session_run_stop.ok.json
packages/tests/baselines/session-control/session_run_stream_cancel.ok.json
packages/tests/baselines/session-control/session_run_stream_read.ok.json
packages/tests/baselines/session-control/session_run_stream_start.ok.json
packages/tests/baselines/session-control/session_run_wait.ok.json
packages/tests/baselines/session-control/session_send.ok.json
packages/tests/baselines/session-control/session_status.ok.json
packages/tests/baselines/session-control/session_stop.ok.json
packages/tests/baselines/session-control/session_wait.ok.json
```

### Unit — packages/agents (Vitest via repo-root vitest.config.ts) (count: 7)

```text
packages/agents/package.json
packages/agents/src/providers/cliInstallSpecs.spec.ts
packages/agents/src/sessionControls/publish.spec.ts
packages/agents/src/sessions/replay/happierReplayPrompt.spec.ts
packages/agents/src/voice/voiceAgentPrompt.spec.ts
scripts/testing/featureTestGating.ts
vitest.config.ts
```

### Unit — apps/ui (Vitest) (count: 1159)

```text
apps/ui/app.config.js
apps/ui/babel.config.js
apps/ui/metro.config.js
apps/ui/package.json
apps/ui/public/vendor/kokoro/kokoroTtsWorker.js
apps/ui/sources/__tests__/app/_layout.test.ts
apps/ui/sources/__tests__/app/home.externalAuthStart.spec.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.capabilitiesRequestStability.test.ts
apps/ui/sources/__tests__/app/machine/machineDetails.executionRuns.test.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.revokeMachine.test.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.serverIdSwitch.test.tsx
apps/ui/sources/__tests__/app/new/index.blockingGuidance.test.tsx
apps/ui/sources/__tests__/app/new/pick/machine.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.stackOptionsStability.test.ts
apps/ui/sources/__tests__/app/new/pick/path.test.ts
apps/ui/sources/__tests__/app/new/pick/profile-edit.headerButtons.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.secretRequirementNavigation.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.setOptionsLoop.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.stackOptionsStability.test.ts
apps/ui/sources/__tests__/app/new/pick/testHarness.ts
apps/ui/sources/__tests__/app/settings/profiles.nativeNavigation.test.ts
apps/ui/sources/__tests__/app/share/publicShareViewer.plaintext.test.tsx
apps/ui/sources/__tests__/config/appConfig.easDefaults.test.ts
apps/ui/sources/__tests__/config/fixtures/app.local.fixture.cjs
apps/ui/sources/__tests__/install/ensureNohoistPeerLinks.test.ts
apps/ui/sources/__tests__/install/resolveUiPostinstallTasks.test.ts
apps/ui/sources/__tests__/install/shouldRunPostinstall.test.ts
apps/ui/sources/__tests__/voice/settings/localDirectSection.unhandledRejection.test.tsx
apps/ui/sources/agents/catalog/advancedModes.test.ts
apps/ui/sources/agents/catalog/agentPickerOptions.test.ts
apps/ui/sources/agents/catalog/catalog.test.ts
apps/ui/sources/agents/catalog/enabled.test.ts
apps/ui/sources/agents/catalog/providerDetailsInfo.test.ts
apps/ui/sources/agents/catalog/resolve.test.ts
apps/ui/sources/agents/prompt/systemPrompt.test.ts
apps/ui/sources/agents/providers/_registry/providerSettingsRegistry.test.ts
apps/ui/sources/agents/providers/claude/core.test.ts
apps/ui/sources/agents/providers/pi/thinking.test.ts
apps/ui/sources/agents/registry/registryCore.test.ts
apps/ui/sources/agents/registry/registryUiBehavior.newSession.test.ts
apps/ui/sources/agents/registry/registryUiBehavior.payload.test.ts
apps/ui/sources/agents/registry/registryUiBehavior.resume.test.ts
apps/ui/sources/agents/registry/registryUiBehavior.testHelpers.ts
apps/ui/sources/agents/runtime/acpRuntimeResume.test.ts
apps/ui/sources/agents/runtime/cliWarnings.test.ts
apps/ui/sources/agents/runtime/resumeCapabilities.test.ts
apps/ui/sources/app/(app)/account.legacyRedirect.spec.tsx
apps/ui/sources/app/(app)/changelog.featureGate.test.tsx
apps/ui/sources/app/(app)/friends/index.redirect.test.tsx
apps/ui/sources/app/(app)/friends/search.request-status.test.tsx
apps/ui/sources/app/(app)/index.autoRedirect.spec.tsx
apps/ui/sources/app/(app)/index.autoRedirect.web.spec.tsx
apps/ui/sources/app/(app)/index.pendingTerminalIntent.spec.tsx
apps/ui/sources/app/(app)/index.signupMethods.spec.tsx
apps/ui/sources/app/(app)/index.testHelpers.ts
apps/ui/sources/app/(app)/mtls.restoreRequired.spec.tsx
apps/ui/sources/app/(app)/new/pick/machine.serverScope.spec.tsx
apps/ui/sources/app/(app)/new/pick/server.headerOptions.test.tsx
apps/ui/sources/app/(app)/new/pick/server.targeting.spec.tsx
apps/ui/sources/app/(app)/oauth/oauthReturn.keyless.spec.tsx
apps/ui/sources/app/(app)/oauth/oauthReturn.providerAlreadyLinked.spec.tsx
apps/ui/sources/app/(app)/oauth/oauthReturn.provisioningChoice.spec.tsx
apps/ui/sources/app/(app)/restore/index.mobile.featureDisabled.spec.tsx
apps/ui/sources/app/(app)/restore/index.mobile.spec.tsx
apps/ui/sources/app/(app)/restore/index.spec.tsx
apps/ui/sources/app/(app)/restore/index.webDesktop.spec.tsx
apps/ui/sources/app/(app)/restore/index.webPhone.spec.tsx
apps/ui/sources/app/(app)/restore/lost-access.spec.tsx
apps/ui/sources/app/(app)/restore/manual.spec.tsx
apps/ui/sources/app/(app)/rootLayout.friendsHeaderRight.test.tsx
apps/ui/sources/app/(app)/rootLayout.notifications.spec.tsx
apps/ui/sources/app/(app)/rootLayout.serverOverride.spec.tsx
apps/ui/sources/app/(app)/rootLayout.voiceGate.spec.tsx
apps/ui/sources/app/(app)/runs.test.tsx
apps/ui/sources/app/(app)/scan/account.spec.tsx
apps/ui/sources/app/(app)/scan/terminal.spec.tsx
apps/ui/sources/app/(app)/search.memoryRpc.test.tsx
apps/ui/sources/app/(app)/server.savedServers.spec.tsx
apps/ui/sources/app/(app)/server.webActions.spec.tsx
apps/ui/sources/app/(app)/session/[id]/commit.test.tsx
apps/ui/sources/app/(app)/session/[id]/file.screen.sessionPath.test.tsx
apps/ui/sources/app/(app)/session/[id]/files.test.tsx
apps/ui/sources/app/(app)/session/[id]/log.test.tsx
apps/ui/sources/app/(app)/session/[id]/runs.test.tsx
apps/ui/sources/app/(app)/session/[id]/runs/[runId].test.tsx
apps/ui/sources/app/(app)/session/[id]/runs/new.guidancePreview.test.tsx
apps/ui/sources/app/(app)/session/[id]/runs/new.test.tsx
apps/ui/sources/app/(app)/session/[id]/sharing.permission.test.tsx
apps/ui/sources/app/(app)/session/sessionIdParamParsing.spec.tsx
apps/ui/sources/app/(app)/settings/account.addYourPhoneGrouping.test.tsx
apps/ui/sources/app/(app)/settings/account.encryptionModeToggle.test.tsx
apps/ui/sources/app/(app)/settings/account.secretKeyCopy.test.tsx
apps/ui/sources/app/(app)/settings/account.testHelpers.ts
apps/ui/sources/app/(app)/settings/account.username.test.tsx
apps/ui/sources/app/(app)/settings/appearance.sessionList.spec.tsx
apps/ui/sources/app/(app)/settings/features.gating.spec.tsx
apps/ui/sources/app/(app)/settings/features.webSessionSettingsMove.test.tsx
apps/ui/sources/app/(app)/settings/memory.enableSwitch.test.tsx
apps/ui/sources/app/(app)/settings/providers/providerSettingsScreen.test.tsx
apps/ui/sources/app/(app)/settings/session.actionsEntry.test.tsx
apps/ui/sources/app/(app)/settings/session.permissionsEntry.test.tsx
apps/ui/sources/app/(app)/settings/session.subAgentGate.test.tsx
apps/ui/sources/app/(app)/settings/session.thinkingDisplayMode.test.tsx
apps/ui/sources/app/(app)/settings/session.toolRenderingEntry.test.tsx
apps/ui/sources/app/(app)/settings/session.webFeaturesMoved.test.tsx
apps/ui/sources/app/(app)/settings/sessionI18n.test.ts
apps/ui/sources/app/(app)/settings/voice.deviceTtsTest.spec.tsx
apps/ui/sources/app/(app)/settings/voice.support.spec.tsx
apps/ui/sources/app/(app)/terminal/connect.hashParamsOrder.spec.tsx
apps/ui/sources/app/(app)/terminal/connect.unauthRedirect.spec.tsx
apps/ui/sources/app/(app)/terminal/index.authButtons.spec.tsx
apps/ui/sources/app/(app)/terminal/index.legacyFallback.spec.tsx
apps/ui/sources/app/(app)/terminal/index.unauthRedirect.spec.tsx
apps/ui/sources/app/_layout.init.spec.tsx
apps/ui/sources/auth/context/AuthContext.login.test.tsx
apps/ui/sources/auth/encryption/createEncryptionFromAuthCredentials.test.ts
apps/ui/sources/auth/flows/approve.test.ts
apps/ui/sources/auth/flows/buildDataKeyCredentialsForToken.test.ts
apps/ui/sources/auth/flows/getToken.keyChallengeGate.test.ts
apps/ui/sources/auth/flows/qrWait.v2Fallback.test.ts
apps/ui/sources/auth/oauth/contentKeyBinding.test.ts
apps/ui/sources/auth/pairing/pairingUrl.test.ts
apps/ui/sources/auth/providers/externalAuthUrl.test.ts
apps/ui/sources/auth/providers/externalOAuthProvider.test.ts
apps/ui/sources/auth/providers/github/index.spec.ts
apps/ui/sources/auth/providers/github/oauth.auth.spec.tsx
apps/ui/sources/auth/providers/github/oauth.connect.spec.tsx
apps/ui/sources/auth/providers/github/test/oauthReturnHarness.ts
apps/ui/sources/auth/providers/registry.fallback.spec.ts
apps/ui/sources/auth/recovery/secretKeyBackup.robustness.spec.ts
apps/ui/sources/auth/recovery/secretKeyBackup.spec.ts
apps/ui/sources/auth/recovery/secretKeyBackup.testHelpers.ts
apps/ui/sources/auth/recovery/secretKeyBackup.validation.spec.ts
apps/ui/sources/auth/routing/authRouting.test.ts
apps/ui/sources/auth/storage/tokenStorage.pendingExternalAuth.test.ts
apps/ui/sources/auth/storage/tokenStorage.pendingExternalConnect.test.ts
apps/ui/sources/auth/storage/tokenStorage.recoveryKeyReminderDismissed.test.ts
apps/ui/sources/auth/storage/tokenStorage.serverScopeMismatch.test.ts
apps/ui/sources/auth/storage/tokenStorage.serverScoped.test.ts
apps/ui/sources/auth/storage/tokenStorage.test.ts
apps/ui/sources/auth/storage/tokenStorage.web.testHelpers.ts
apps/ui/sources/auth/terminal/terminalProvisioning.test.ts
apps/ui/sources/capabilities/codexAcpDep.test.ts
apps/ui/sources/capabilities/codexDepCapability.testHelpers.ts
apps/ui/sources/capabilities/codexMcpResume.test.ts
apps/ui/sources/capabilities/installablesBackgroundPlan.test.ts
apps/ui/sources/capabilities/installablesRegistry.test.ts
apps/ui/sources/components/CommandPalette/buildCommandPaletteCommands.test.ts
apps/ui/sources/components/account/ProviderIdentityItems.test.tsx
apps/ui/sources/components/account/RecoveryKeyReminderBanner.spec.tsx
apps/ui/sources/components/account/restore/RestoreScanComputerQrView.alreadyRequested.spec.tsx
apps/ui/sources/components/account/restore/RestoreScanComputerQrView.featureDisabled.spec.tsx
apps/ui/sources/components/account/restore/RestoreScanComputerQrView.webPhone.spec.tsx
apps/ui/sources/components/appShell/panes/AppPaneScopeHost.containerWidth.test.tsx
apps/ui/sources/components/appShell/panes/AppPaneScopeHost.dockedMaxWidths.test.tsx
apps/ui/sources/components/appShell/panes/AppPaneScopeHost.focusModeUncapped.test.tsx
apps/ui/sources/components/appShell/panes/AppPaneScopeHost.focusModeWidths.test.tsx
apps/ui/sources/components/appShell/panes/AppPaneScopeHost.fullScreenOverlayOnPhoneWeb.test.tsx
apps/ui/sources/components/appShell/panes/AppPaneScopeHost.overlayStackKeepsRightOpen.test.tsx
apps/ui/sources/components/appShell/panes/AppPaneScopeHost.overlayWidths.test.tsx
apps/ui/sources/components/appShell/panes/hooks/resolveDetailsTabOpenAs.test.ts
apps/ui/sources/components/appShell/panes/layout/applyEditorFocusModePaneLayoutOverride.test.ts
apps/ui/sources/components/appShell/panes/layout/paneSizing.test.ts
apps/ui/sources/components/appShell/panes/layout/resolveMultiPaneDeviceType.test.ts
apps/ui/sources/components/appShell/panes/model/appPaneReducer.test.ts
apps/ui/sources/components/autocomplete/applySuggestion.test.ts
apps/ui/sources/components/autocomplete/findActiveWord.test.ts
apps/ui/sources/components/automations/gating/AutomationsGate.test.tsx
apps/ui/sources/components/automations/screens/AutomationsScreen.test.tsx
apps/ui/sources/components/automations/screens/SessionAutomationCreateScreen.test.tsx
apps/ui/sources/components/automations/screens/SessionAutomationsScreen.test.tsx
apps/ui/sources/components/automations/screens/automationAssignmentsModel.test.ts
apps/ui/sources/components/friends/RequireFriendsIdentityForFriends.test.tsx
apps/ui/sources/components/friends/resolveFriendsIdentityGate.test.ts
apps/ui/sources/components/machines/DetectedClisList.errorSnapshot.test.ts
apps/ui/sources/components/machines/InstallableDepInstaller.serverScope.test.tsx
apps/ui/sources/components/markdown/MarkdownSpansView.linkRel.test.tsx
apps/ui/sources/components/markdown/MarkdownView.diffCodeBlocks.test.tsx
apps/ui/sources/components/markdown/MermaidRenderer.copy.test.tsx
apps/ui/sources/components/markdown/mermaidSanitize.test.ts
apps/ui/sources/components/markdown/parseMarkdownBlock.table.test.ts
apps/ui/sources/components/markdown/parseMarkdownSpans.autolink.test.ts
apps/ui/sources/components/model/ModelPickerOverlay.test.tsx
apps/ui/sources/components/navigation/ConnectionStatusControl.label.test.tsx
apps/ui/sources/components/navigation/ConnectionStatusControl.popover.test.ts
apps/ui/sources/components/navigation/shell/HomeHeader.automationsButton.test.tsx
apps/ui/sources/components/navigation/shell/InboxView.voiceSurface.test.tsx
apps/ui/sources/components/navigation/shell/MainView.primaryPaneGettingStarted.test.tsx
apps/ui/sources/components/navigation/shell/MainView.sidebarActions.test.tsx
apps/ui/sources/components/navigation/shell/SidebarNavigator.collapsed.test.tsx
apps/ui/sources/components/navigation/shell/SidebarView.automationsButton.test.tsx
apps/ui/sources/components/navigation/shell/sidebarSizing.test.ts
apps/ui/sources/components/profiles/edit/ProfileEditForm.previewMachinePicker.test.ts
apps/ui/sources/components/profiles/environmentVariables/EnvironmentVariableCard.test.ts
apps/ui/sources/components/profiles/environmentVariables/EnvironmentVariablesList.test.ts
apps/ui/sources/components/profiles/profileListModel.test.ts
apps/ui/sources/components/qr/QrCodeScannerView.test.tsx
apps/ui/sources/components/secrets/SecretsList.test.ts
apps/ui/sources/components/sessions/actions/SessionActionDraftCard.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.abortButtonVisibility.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.actionBarScroll.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.dragOverlay.feat.attachments.uploads.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.historyNavigation.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.machineChip.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.modelOptionsOverride.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.permissionPromptSurface.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.permissionRequestLocation.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.permissionRequests.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.sendButtonAccessibility.test.tsx
apps/ui/sources/components/sessions/agentInput/PathAndResumeRow.test.ts
apps/ui/sources/components/sessions/agentInput/actionBarLogic.test.ts
apps/ui/sources/components/sessions/agentInput/actionChips/listAgentInputActionChipActionIds.test.ts
apps/ui/sources/components/sessions/agentInput/attachActionBarMouseDragScroll.test.ts
apps/ui/sources/components/sessions/agentInput/components/AgentInputAutocomplete.test.ts
apps/ui/sources/components/sessions/agentInput/components/AgentInputPopoverSurface.test.tsx
apps/ui/sources/components/sessions/agentInput/components/PermissionModePicker.test.tsx
apps/ui/sources/components/sessions/agentInput/inputMaxHeight.test.ts
apps/ui/sources/components/sessions/agentInput/permissionChipVisibility.test.ts
apps/ui/sources/components/sessions/agentInput/recipient/useSessionRecipientState.test.ts
apps/ui/sources/components/sessions/chatListItems.test.ts
apps/ui/sources/components/sessions/files/FilesToolbar.test.tsx
apps/ui/sources/components/sessions/files/SourceControlBranchSummary.test.tsx
apps/ui/sources/components/sessions/files/SourceControlOperationsHistorySection.test.tsx
apps/ui/sources/components/sessions/files/SourceControlOperationsPanel.test.tsx
apps/ui/sources/components/sessions/files/commit/ScmCommitMessageEditorModal.test.tsx
apps/ui/sources/components/sessions/files/content/ChangedFilesList.test.tsx
apps/ui/sources/components/sessions/files/content/ChangedFilesReview.flashListExtraData.test.tsx
apps/ui/sources/components/sessions/files/content/ChangedFilesReview.test.tsx
apps/ui/sources/components/sessions/files/content/RepositoryTreeList.test.tsx
apps/ui/sources/components/sessions/files/content/SearchResultsList.test.tsx
apps/ui/sources/components/sessions/files/content/review/buildChangedFilesOutlineTree.test.ts
apps/ui/sources/components/sessions/files/content/review/buildChangedFilesReviewRows.test.ts
apps/ui/sources/components/sessions/files/content/review/imagePreviewCache.test.ts
apps/ui/sources/components/sessions/files/content/review/resolveReviewPrefetchWindow.test.ts
apps/ui/sources/components/sessions/files/content/review/useChangedFilesReviewDiffLoading.binaryPlaceholders.test.tsx
apps/ui/sources/components/sessions/files/content/review/useChangedFilesReviewDiffLoading.fallbackDiff.test.tsx
apps/ui/sources/components/sessions/files/content/review/useChangedFilesReviewDiffLoading.test.ts
apps/ui/sources/components/sessions/files/content/review/useChangedFilesReviewImagePreview.test.tsx
apps/ui/sources/components/sessions/files/file/FileActionToolbar.test.tsx
apps/ui/sources/components/sessions/files/file/FileContentPanel.readOnlyDiff.web.test.tsx
apps/ui/sources/components/sessions/files/file/FileContentPanel.test.tsx
apps/ui/sources/components/sessions/files/file/FileHeader.test.tsx
apps/ui/sources/components/sessions/files/filesUtils.test.ts
apps/ui/sources/components/sessions/files/repositoryTree/computeExpandedPathsForReveal.test.ts
apps/ui/sources/components/sessions/files/repositoryTree/scmTreeBadges.test.ts
apps/ui/sources/components/sessions/files/views/SessionCommitDetailsView.test.tsx
apps/ui/sources/components/sessions/files/views/SessionFileDetailsView.binaryState.test.tsx
apps/ui/sources/components/sessions/files/views/SessionRepositoryTreeBrowserView.changedOnly.test.tsx
apps/ui/sources/components/sessions/files/views/SessionRepositoryTreeBrowserView.createActions.test.tsx
apps/ui/sources/components/sessions/files/views/SessionRepositoryTreeBrowserView.test.tsx
apps/ui/sources/components/sessions/files/views/SessionRepositoryTreeBrowserView.toolbar.test.tsx
apps/ui/sources/components/sessions/files/views/sessionFileDetails/refreshSessionFileDetails.fallbackDiff.test.ts
apps/ui/sources/components/sessions/files/views/sessionFileDetails/refreshSessionFileDetails.imagePreview.test.ts
apps/ui/sources/components/sessions/files/views/sessionFileDetails/refreshSessionFileDetails.multiFileDiff.test.ts
apps/ui/sources/components/sessions/files/views/sessionFileDetails/resolveShowDiffToggle.test.ts
apps/ui/sources/components/sessions/files/views/sessionFileDetails/useSessionFileEditorState.daemonUnavailable.test.tsx
apps/ui/sources/components/sessions/files/views/sessionFileDetails/useSessionFileEditorState.startFromDiff.test.tsx
apps/ui/sources/components/sessions/guidance/SessionGettingStartedGuidance.featureGate.test.tsx
apps/ui/sources/components/sessions/guidance/SessionGettingStartedGuidance.view.test.tsx
apps/ui/sources/components/sessions/guidance/gettingStartedModel.test.ts
apps/ui/sources/components/sessions/linkedFiles/LinkedWorkspaceFilesRow.open.test.tsx
apps/ui/sources/components/sessions/linkedFiles/extractWorkspaceFileMentions.test.ts
apps/ui/sources/components/sessions/linkedFiles/projectPicker/ProjectFileLinkPickerModal.test.tsx
apps/ui/sources/components/sessions/linkedFiles/projectPicker/SessionLinkFileAction.test.tsx
apps/ui/sources/components/sessions/model/inactiveSessionUi.test.ts
apps/ui/sources/components/sessions/model/resolveSessionMachineReachability.test.ts
apps/ui/sources/components/sessions/new/components/ConnectedServicesAuthModal.test.tsx
apps/ui/sources/components/sessions/new/components/MachineSelector.offlineDisable.test.tsx
apps/ui/sources/components/sessions/new/components/NewSessionSimplePanel.attachments.feat.attachments.uploads.test.tsx
apps/ui/sources/components/sessions/new/components/NewSessionSimplePanel.modelOptionsOverride.test.tsx
apps/ui/sources/components/sessions/new/components/NewSessionWizard.attachments.feat.attachments.uploads.test.tsx
apps/ui/sources/components/sessions/new/components/WizardSectionHeaderRow.test.ts
apps/ui/sources/components/sessions/new/hooks/machines/useServerScopedMachineOptions.test.tsx
apps/ui/sources/components/sessions/new/hooks/newSessionModelModePolicy.test.ts
apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState.cache.test.tsx
apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState.cwd.test.tsx
apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState.persistence.test.tsx
apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState.refresh.test.tsx
apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState.cache.test.tsx
apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState.cwd.test.tsx
apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState.loadingPlaceholder.test.tsx
apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState.persistence.test.tsx
apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState.refresh.test.tsx
apps/ui/sources/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState.test.tsx
apps/ui/sources/components/sessions/new/hooks/useCreateNewSession.acpSessionModeSeed.test.ts
apps/ui/sources/components/sessions/new/hooks/useCreateNewSession.daemonUnavailable.test.ts
apps/ui/sources/components/sessions/new/hooks/useCreateNewSession.permissionSeed.test.ts
apps/ui/sources/components/sessions/new/hooks/useCreateNewSession.worktreeGate.test.ts
apps/ui/sources/components/sessions/new/hooks/useNewSessionScreenModel.automationChip.test.tsx
apps/ui/sources/components/sessions/new/modules/automationFeatureGate.test.ts
apps/ui/sources/components/sessions/new/modules/canCreateNewSession.test.ts
apps/ui/sources/components/sessions/new/modules/resolveNewSessionCapabilityServerId.test.ts
apps/ui/sources/components/sessions/new/modules/useAutomationPickerAutoOpen.test.tsx
apps/ui/sources/components/sessions/new/navigation/newSessionRouteParams.test.ts
apps/ui/sources/components/sessions/new/navigation/spawnServerRouteParam.test.ts
apps/ui/sources/components/sessions/panes/SessionDetailsPanel.activeTabFallback.test.tsx
apps/ui/sources/components/sessions/panes/SessionDetailsPanel.autoPinOnEdit.test.tsx
apps/ui/sources/components/sessions/panes/SessionDetailsPanel.closeTabOnce.test.tsx
apps/ui/sources/components/sessions/panes/SessionDetailsPanel.commitResource.test.tsx
apps/ui/sources/components/sessions/panes/SessionDetailsPanel.keepMountedTabs.test.tsx
apps/ui/sources/components/sessions/panes/SessionDetailsPanel.scmReviewResource.test.tsx
apps/ui/sources/components/sessions/panes/SessionRightPanel.gitSubTabs.test.tsx
apps/ui/sources/components/sessions/panes/SessionRightPanel.keepMountedTabs.test.tsx
apps/ui/sources/components/sessions/panes/git/SessionRightPanelGitCommitTab.draftDebounce.test.tsx
apps/ui/sources/components/sessions/panes/git/SessionRightPanelGitCommitTab.virtualization.test.tsx
apps/ui/sources/components/sessions/panes/git/SessionRightPanelGitView.inactiveResume.test.tsx
apps/ui/sources/components/sessions/panes/git/SessionRightPanelGitView.keepMountedSubTabs.test.tsx
apps/ui/sources/components/sessions/panes/git/SessionRightPanelGitView.remoteActionsVisibility.test.tsx
apps/ui/sources/components/sessions/panes/url/sessionPaneUrlState.test.ts
apps/ui/sources/components/sessions/panes/url/useSessionPaneUrlSync.test.tsx
apps/ui/sources/components/sessions/pending/PendingMessagesModal.discardFallback.test.ts
apps/ui/sources/components/sessions/pending/PendingMessagesModal.test.ts
apps/ui/sources/components/sessions/pending/PendingQueueIndicator.test.ts
apps/ui/sources/components/sessions/pending/PendingUserTextMessageView.test.tsx
apps/ui/sources/components/sessions/pendingBadge.test.ts
apps/ui/sources/components/sessions/reviews/comments/buildReviewCommentDraftFromCodeLine.test.ts
apps/ui/sources/components/sessions/reviews/comments/useCodeLinesReviewComments.test.tsx
apps/ui/sources/components/sessions/reviews/messages/ReviewCommentsMessageCard.test.tsx
apps/ui/sources/components/sessions/reviews/messages/ReviewFindingsMessageCard.test.tsx
apps/ui/sources/components/sessions/runs/ExecutionRunList.test.tsx
apps/ui/sources/components/sessions/shell/SessionGroupDragList.rowHeight.test.tsx
apps/ui/sources/components/sessions/shell/SessionItem.hoverPinAffordance.test.tsx
apps/ui/sources/components/sessions/shell/SessionItem.serverScopeMutation.test.tsx
apps/ui/sources/components/sessions/shell/SessionItem.tags.addNewTag.test.tsx
apps/ui/sources/components/sessions/shell/SessionItem.tags.layout.test.tsx
apps/ui/sources/components/sessions/shell/SessionView.attachmentsGating.test.tsx
apps/ui/sources/components/sessions/shell/SessionView.sendAttachmentsResumable.feat.attachments.uploads.test.tsx
apps/ui/sources/components/sessions/shell/SessionView.transcriptRender.seqOnly.test.tsx
apps/ui/sources/components/sessions/shell/SessionsList.pinningAndReorder.test.tsx
apps/ui/sources/components/sessions/shell/SessionsList.sessionItem.serverId.test.tsx
apps/ui/sources/components/sessions/shell/SessionsListWrapper.emptyState.test.tsx
apps/ui/sources/components/sessions/sourceControl/changes/ScmChangeDiscardButton.test.tsx
apps/ui/sources/components/sessions/sourceControl/changes/ScmChangeOverflowMenu.test.tsx
apps/ui/sources/components/sessions/sourceControl/changes/ScmChangeRow.test.tsx
apps/ui/sources/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard.test.tsx
apps/ui/sources/components/sessions/sourceControl/commitSelection/ScmChangesSelectionHeaderRow.test.tsx
apps/ui/sources/components/sessions/sourceControl/commitSelection/ScmCommitSelectionSummaryRow.test.tsx
apps/ui/sources/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton.test.tsx
apps/ui/sources/components/sessions/sourceControl/remoteActions/SourceControlRemoteActionsRail.test.tsx
apps/ui/sources/components/sessions/sourceControl/states/SourceControlUnavailableState.test.tsx
apps/ui/sources/components/sessions/sourceControl/status/CompactSourceControlStatus.test.tsx
apps/ui/sources/components/sessions/sourceControl/status/ProjectSourceControlStatus.test.tsx
apps/ui/sources/components/sessions/sourceControl/status/SourceControlStatusBadge.test.tsx
apps/ui/sources/components/sessions/sourceControl/status/statusSummary.test.ts
apps/ui/sources/components/sessions/transcript/ChatFooter.localControl.test.tsx
apps/ui/sources/components/sessions/transcript/ChatHeaderView.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.autoFollowWhenPinned.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.pinOnContentChange.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.unpinnedNoWheel.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.forwardPrefetch.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.initialScrollBehavior.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.jumpToBottom.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.nullSession.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.thinkingExpansionControlled.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.turnGroupingMode.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.turnThinkingExpansionWiring.test.tsx
apps/ui/sources/components/sessions/transcript/MessageView.structured.test.tsx
apps/ui/sources/components/sessions/transcript/MessageView.thinkingPulse.test.tsx
apps/ui/sources/components/sessions/transcript/MessageView.toolChromeMode.test.tsx
apps/ui/sources/components/sessions/transcript/TranscriptList.flashListV2.test.tsx
apps/ui/sources/components/sessions/transcript/TranscriptList.thinkingExpansionControlled.test.tsx
apps/ui/sources/components/sessions/transcript/messageCopyVisibility.test.ts
apps/ui/sources/components/sessions/transcript/motion/ThinkingPulseLabel.test.tsx
apps/ui/sources/components/sessions/transcript/motion/TranscriptCollapsible.test.tsx
apps/ui/sources/components/sessions/transcript/motion/TranscriptEnterWrapper.webNativeDriver.test.tsx
apps/ui/sources/components/sessions/transcript/motion/resolveTranscriptMotionConfig.test.ts
apps/ui/sources/components/sessions/transcript/motion/transcriptFreshnessGate.test.ts
apps/ui/sources/components/sessions/transcript/scroll/transcriptScrollPinController.test.ts
apps/ui/sources/components/sessions/transcript/structured/StructuredMessageBlock.test.tsx
apps/ui/sources/components/sessions/transcript/structured/happierMetaEnvelope.test.ts
apps/ui/sources/components/sessions/transcript/structured/structuredMessageRegistry.voiceAgentTurn.test.ts
apps/ui/sources/components/sessions/transcript/thinking/ThinkingTimelineRow.test.tsx
apps/ui/sources/components/sessions/transcript/thinking/resolveActiveThinkingMessageId.test.ts
apps/ui/sources/components/sessions/transcript/turnGrouping/buildChatTranscriptListItems.test.ts
apps/ui/sources/components/sessions/transcript/turnGrouping/buildTranscriptTurns.test.ts
apps/ui/sources/components/sessions/transcript/turns/TurnView.thinkingExpansionControlled.test.tsx
apps/ui/sources/components/sessions/transcript/turns/activity/ActivityGroupView.collapsedPreview.test.tsx
apps/ui/sources/components/sessions/transcript/turns/activity/ActivityGroupView.motionWiring.test.tsx
apps/ui/sources/components/settings/SettingsView.addYourPhone.web.test.tsx
apps/ui/sources/components/settings/SettingsView.connectTerminal.native.test.tsx
apps/ui/sources/components/settings/SettingsView.multiServerMachines.test.tsx
apps/ui/sources/components/settings/SettingsView.runsEntry.test.tsx
apps/ui/sources/components/settings/SettingsView.serversEntry.test.tsx
apps/ui/sources/components/settings/account/AddPhoneSettingsView.test.tsx
apps/ui/sources/components/settings/bugReports/BugReportDiagnosticsPreviewModal.test.tsx
apps/ui/sources/components/settings/bugReports/bugReportDiagnostics.test.ts
apps/ui/sources/components/settings/bugReports/bugReportFallback.test.ts
apps/ui/sources/components/settings/bugReports/bugReportFeatureDefaults.test.ts
apps/ui/sources/components/settings/bugReports/bugReportSessionSnapshot.test.ts
apps/ui/sources/components/settings/bugReports/bugReportSubmissionFlow.test.ts
apps/ui/sources/components/settings/bugReports/hooks/useBugReportReporterGithubUsername.test.tsx
apps/ui/sources/components/settings/bugReports/openBugReportFallback.test.ts
apps/ui/sources/components/settings/connectedServices/ConnectedServiceDetailView.profileId.test.tsx
apps/ui/sources/components/settings/connectedServices/ConnectedServiceDetailView.quotas.test.tsx
apps/ui/sources/components/settings/connectedServices/ConnectedServiceOauthPasteView.test.tsx
apps/ui/sources/components/settings/connectedServices/ConnectedServiceOauthView.gating.test.tsx
apps/ui/sources/components/settings/connectedServices/ConnectedServiceQuotaCard.test.tsx
apps/ui/sources/components/settings/connectedServices/ConnectedServicesSettingsView.quotas.test.tsx
apps/ui/sources/components/settings/connectedServices/ConnectedServicesSettingsView.test.tsx
apps/ui/sources/components/settings/diagnosis/engine/diagnosisEngine.test.ts
apps/ui/sources/components/settings/features/FeatureDiagnosticsPanel.test.tsx
apps/ui/sources/components/settings/memory/MemorySettingsView.rpc.test.tsx
apps/ui/sources/components/settings/providers/ProviderCliInstallItem.test.tsx
apps/ui/sources/components/settings/server/hooks/useActiveSelectionMachineGroups.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerAutoAddFromRoute.canonicalUrl.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerSettingsScreenController.activeTargetKey.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerSettingsScreenController.canonicalUrlAdoption.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerSettingsScreenController.insecureHttpWarning.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerSettingsScreenController.serverOrdering.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerSettingsServerProfileActions.removeClearsCredentials.test.ts
apps/ui/sources/components/settings/server/navigation/serverSettingsRouteParams.test.ts
apps/ui/sources/components/settings/server/screens/ServerSettingsScreen.concurrentSectionVisibility.test.tsx
apps/ui/sources/components/settings/session/TranscriptRenderingAdvancedSettingsView.performance.test.tsx
apps/ui/sources/components/settings/sourceControl/SourceControlSettingsView.test.tsx
apps/ui/sources/components/settings/subAgent/SubAgentSettingsView.test.tsx
apps/ui/sources/components/settings/subAgent/guidance/subAgentGuidanceRuleEditorModal.test.tsx
apps/ui/sources/components/settings/supportUsBehavior.test.ts
apps/ui/sources/components/settings/systemStatus/cache/machineDoctorSnapshotCache.test.ts
apps/ui/sources/components/tools/catalog/core/diff.toolDefinition.test.ts
apps/ui/sources/components/tools/catalog/core/terminal.title.test.ts
apps/ui/sources/components/tools/catalog/parseUnifiedDiffFilePaths.test.ts
apps/ui/sources/components/tools/normalization/core/normalizeToolCallForRendering._testHelpers.ts
apps/ui/sources/components/tools/normalization/core/normalizeToolCallForRendering.inputShapes.spec.ts
apps/ui/sources/components/tools/normalization/core/normalizeToolCallForRendering.names.spec.ts
apps/ui/sources/components/tools/normalization/core/normalizeToolCallForRendering.results.spec.ts
apps/ui/sources/components/tools/normalization/core/normalizeToolCallForRendering.test.ts
apps/ui/sources/components/tools/normalization/parse/parseParenIdentifier.test.ts
apps/ui/sources/components/tools/normalization/parse/shellCommand.test.ts
apps/ui/sources/components/tools/normalization/policy/permissionSummary.test.ts
apps/ui/sources/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode.test.ts
apps/ui/sources/components/tools/normalization/policy/resolveToolViewDetailLevel.test.ts
apps/ui/sources/components/tools/normalization/policy/toolNameInference.test.ts
apps/ui/sources/components/tools/renderers/core/_registry.executeBashMapping.test.tsx
apps/ui/sources/components/tools/renderers/core/_registry.test.tsx
apps/ui/sources/components/tools/renderers/core/listView.testHelpers.ts
apps/ui/sources/components/tools/renderers/core/truncationView.testHelpers.ts
apps/ui/sources/components/tools/renderers/fileOps/CodeSearchView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/DeleteView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/DiffView.controlsRow.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/DiffView.fileListVirtualization.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/DiffView.reviewComments.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/DiffView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/EditView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/GlobView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/GrepView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/LSView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/MultiEditView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/PatchView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/ReadView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/WriteView.test.tsx
apps/ui/sources/components/tools/renderers/system/AcpHistoryImportView.test.tsx
apps/ui/sources/components/tools/renderers/system/BashView.test.tsx
apps/ui/sources/components/tools/renderers/system/MCPToolView.test.tsx
apps/ui/sources/components/tools/renderers/system/WorkspaceIndexingPermissionView.test.tsx
apps/ui/sources/components/tools/renderers/web/WebFetchView.test.tsx
apps/ui/sources/components/tools/renderers/web/WebSearchView.test.tsx
apps/ui/sources/components/tools/renderers/workflow/AskUserQuestionView.test.ts
apps/ui/sources/components/tools/renderers/workflow/ChangeTitleView.test.tsx
apps/ui/sources/components/tools/renderers/workflow/EnterPlanModeView.test.tsx
apps/ui/sources/components/tools/renderers/workflow/ExitPlanToolView.test.ts
apps/ui/sources/components/tools/renderers/workflow/ReasoningView.test.tsx
apps/ui/sources/components/tools/renderers/workflow/SubAgentRunView.test.tsx
apps/ui/sources/components/tools/renderers/workflow/TaskView.test.tsx
apps/ui/sources/components/tools/renderers/workflow/TodoView.test.tsx
apps/ui/sources/components/tools/renderers/workflow/collectTaskLikeTools.test.ts
apps/ui/sources/components/tools/shell/permissions/PermissionFooter.codexDecision.test.tsx
apps/ui/sources/components/tools/shell/permissions/PermissionFooter.stopAbortsRun.test.tsx
apps/ui/sources/components/tools/shell/permissions/PermissionPromptCard.preview.test.tsx
apps/ui/sources/components/tools/shell/permissions/presentation/buildPermissionPromptModel.test.ts
apps/ui/sources/components/tools/shell/presentation/ToolDiffView.test.tsx
apps/ui/sources/components/tools/shell/presentation/ToolHeader.iconGuard.test.tsx
apps/ui/sources/components/tools/shell/presentation/ToolStatusIndicator.permissionStates.test.tsx
apps/ui/sources/components/tools/shell/presentation/buildToolHeaderModel.test.tsx
apps/ui/sources/components/tools/shell/presentation/resolveToolHeaderTextPresentation.test.ts
apps/ui/sources/components/tools/shell/views/ToolFullView.errorObjectResult.test.ts
apps/ui/sources/components/tools/shell/views/ToolFullView.inference.test.ts
apps/ui/sources/components/tools/shell/views/ToolFullView.jumpChildIdScroll.test.tsx
apps/ui/sources/components/tools/shell/views/ToolFullView.permissionPending.test.tsx
apps/ui/sources/components/tools/shell/views/ToolFullView.taskTranscript.test.tsx
apps/ui/sources/components/tools/shell/views/ToolTimelineRow.minimalFallback.test.tsx
apps/ui/sources/components/tools/shell/views/ToolTimelineRow.tapAction.test.tsx
apps/ui/sources/components/tools/shell/views/ToolTimelineRow.titleFallback.test.tsx
apps/ui/sources/components/tools/shell/views/ToolTimelineRow.unknownCollapse.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.acpKindFallback.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.cardDensity.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.descriptionFallback.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.detailLevelCompact.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.detailLevelFull.singleRenderer.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.detailLevelTitle.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.diffHeaderActions.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.errorObjectResult.test.ts
apps/ui/sources/components/tools/shell/views/ToolView.exitPlanMode.test.ts
apps/ui/sources/components/tools/shell/views/ToolView.fixtures.v1.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.minimalSpecificView.test.ts
apps/ui/sources/components/tools/shell/views/ToolView.minimalStructuredFallback.test.ts
apps/ui/sources/components/tools/shell/views/ToolView.permissionDenied.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.permissionPending.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.runningStructuredFallback.test.ts
apps/ui/sources/components/tools/shell/views/ToolView.tapActionExpand.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.testHelpers.ts
apps/ui/sources/components/tools/shell/views/ToolView.unknownToolDefaultTitle.test.tsx
apps/ui/sources/components/tools/shell/views/timeline/ToolTimelineRowHeader.test.tsx
apps/ui/sources/components/ui/buttons/PrimaryCircleIconButton.test.tsx
apps/ui/sources/components/ui/buttons/RoundButton.test.tsx
apps/ui/sources/components/ui/code/blocks/CodeBlockView.test.tsx
apps/ui/sources/components/ui/code/blocks/CodeBlockView.web.test.tsx
apps/ui/sources/components/ui/code/blocks/CodeBlockViewFrame.test.tsx
apps/ui/sources/components/ui/code/diff/DiffFilesListView.test.tsx
apps/ui/sources/components/ui/code/diff/DiffPresentationStyleToggleButton.test.tsx
apps/ui/sources/components/ui/code/diff/DiffViewer.web.selection.test.tsx
apps/ui/sources/components/ui/code/diff/happier/HappierUnifiedDiffViewer.folding.test.tsx
apps/ui/sources/components/ui/code/diff/happier/collapseUnifiedDiffContext.test.ts
apps/ui/sources/components/ui/code/diff/pierre/PierreDiffViewer.web.test.tsx
apps/ui/sources/components/ui/code/diff/pierre/pierreWorkerFactory.web.test.ts
apps/ui/sources/components/ui/code/diff/pierre/pierreWorkerPool.web.test.ts
apps/ui/sources/components/ui/code/diff/pierre/resolvePierreLanguageOverride.web.test.ts
apps/ui/sources/components/ui/code/diff/pierre/resolvePierreWorkerPoolConfig.test.ts
apps/ui/sources/components/ui/code/diff/pierre/usePierreDiffWorkerPoolWarmup.web.test.tsx
apps/ui/sources/components/ui/code/diff/resolveInlineCodeVirtualization.test.ts
apps/ui/sources/components/ui/code/diff/resolveInlineDiffVirtualization.test.ts
apps/ui/sources/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer.test.tsx
apps/ui/sources/components/ui/code/editor/bridge/chunkedBridge.test.ts
apps/ui/sources/components/ui/code/editor/bridge/codemirrorWebViewHtml.test.ts
apps/ui/sources/components/ui/code/editor/bridge/resolveCodeMirrorWebViewLanguageSpec.test.ts
apps/ui/sources/components/ui/code/editor/codeEditorFontMetrics.test.ts
apps/ui/sources/components/ui/code/editor/codeEditorTypes.test.ts
apps/ui/sources/components/ui/code/editor/surfaces/MonacoEditorSurface.web.test.tsx
apps/ui/sources/components/ui/code/highlighting/resolveCodeLinesSyntaxHighlightingConfig.test.ts
apps/ui/sources/components/ui/code/highlighting/resolveShikiLanguageId.test.ts
apps/ui/sources/components/ui/code/model/buildCodeLinesFromFile.test.ts
apps/ui/sources/components/ui/code/model/buildCodeLinesFromTextDiff.test.ts
apps/ui/sources/components/ui/code/model/buildCodeLinesFromUnifiedDiff.test.ts
apps/ui/sources/components/ui/code/model/diff/diffViewModel.test.ts
apps/ui/sources/components/ui/code/model/diff/splitUnifiedDiffByFile.test.ts
apps/ui/sources/components/ui/code/tokenization/simpleSyntaxTokenizer.test.ts
apps/ui/sources/components/ui/code/view/CodeLineRow.test.tsx
apps/ui/sources/components/ui/code/view/CodeLinesView.test.tsx
apps/ui/sources/components/ui/code/view/CodeLinesView.web.test.tsx
apps/ui/sources/components/ui/feedback/desktopUpdateBannerModel.test.ts
apps/ui/sources/components/ui/forms/MultiTextInput.test.tsx
apps/ui/sources/components/ui/forms/SearchableListSelector.disabledItems.test.tsx
apps/ui/sources/components/ui/forms/dropdown/DropdownMenu.test.ts
apps/ui/sources/components/ui/forms/dropdown/SelectableMenuResults.scrollIntoView.test.ts
apps/ui/sources/components/ui/forms/dropdown/SelectableMenuResults.test.tsx
apps/ui/sources/components/ui/lists/ActionListSection.test.tsx
apps/ui/sources/components/ui/lists/Item.doublePress.test.tsx
apps/ui/sources/components/ui/lists/Item.subtitleNormalization.test.tsx
apps/ui/sources/components/ui/lists/ItemGroup.dividers.test.ts
apps/ui/sources/components/ui/lists/ItemGroup.selectableCount.test.ts
apps/ui/sources/components/ui/lists/ItemGroupTitleWithAction.test.ts
apps/ui/sources/components/ui/lists/ItemList.popoverBoundary.test.tsx
apps/ui/sources/components/ui/lists/ItemList.test.tsx
apps/ui/sources/components/ui/lists/ItemRowActions.test.ts
apps/ui/sources/components/ui/lists/SelectableRow.cursor.spec.tsx
apps/ui/sources/components/ui/lists/itemGroupRowCorners.test.ts
apps/ui/sources/components/ui/media/CodeView.test.tsx
apps/ui/sources/components/ui/media/SimpleSyntaxHighlighter.test.tsx
apps/ui/sources/components/ui/overlays/FloatingOverlay.arrow.test.ts
apps/ui/sources/components/ui/panels/MultiPaneHost.escapeDocked.test.tsx
apps/ui/sources/components/ui/panels/MultiPaneHost.hideMainDocked.test.tsx
apps/ui/sources/components/ui/panels/MultiPaneHost.overlayDetails.test.tsx
apps/ui/sources/components/ui/panels/MultiPaneHost.overlayRight.test.tsx
apps/ui/sources/components/ui/panels/ResizableDockedPane.test.tsx
apps/ui/sources/components/ui/panels/paneBreakpoints.test.ts
apps/ui/sources/components/ui/panels/resolvePointerClientX.test.ts
apps/ui/sources/components/ui/panels/shouldRedirectDetailsRouteToPanes.test.ts
apps/ui/sources/components/ui/popover/OverlayPortal.test.ts
apps/ui/sources/components/ui/popover/Popover.nativePortal.test.ts
apps/ui/sources/components/ui/popover/Popover.test.ts
apps/ui/sources/components/ui/popover/PopoverPortalTargetProvider.test.ts
apps/ui/sources/components/ui/text/uiFontScale.test.ts
apps/ui/sources/components/ui/text/webUnistylesFontOverrides.test.ts
apps/ui/sources/components/voice/surface/VoiceSurface.test.tsx
apps/ui/sources/desktop/updates/state.test.ts
apps/ui/sources/desktop/updates/useDesktopUpdater.test.ts
apps/ui/sources/dev/abortControllerPolyfillStub.ts
apps/ui/sources/dev/appConfig.routerIgnore.spec.ts
apps/ui/sources/dev/babelConfigAliases.test.ts
apps/ui/sources/dev/expoAudioStub.ts
apps/ui/sources/dev/expoClipboardStub.ts
apps/ui/sources/dev/expoConstantsStub.ts
apps/ui/sources/dev/expoLinearGradientStub.ts
apps/ui/sources/dev/expoLocalizationStub.ts
apps/ui/sources/dev/expoModulesCoreStub.ts
apps/ui/sources/dev/expoNotificationsStub.ts
apps/ui/sources/dev/expoRouterStub.ts
apps/ui/sources/dev/expoSpeechRecognitionStub.ts
apps/ui/sources/dev/expoSpeechStub.ts
apps/ui/sources/dev/expoStub.ts
apps/ui/sources/dev/jsdom.d.ts
apps/ui/sources/dev/metro.config.fontfaceobserver.spec.ts
apps/ui/sources/dev/reactNativeDeviceInfoStub.ts
apps/ui/sources/dev/reactNativeGestureHandlerStub.ts
apps/ui/sources/dev/reactNativeInternalStub.ts
apps/ui/sources/dev/reactNativePurchasesStub.ts
apps/ui/sources/dev/reactNativePurchasesUiStub.ts
apps/ui/sources/dev/reactNativeStub.ts
apps/ui/sources/dev/reactNativeVirtualizedListsStub.ts
apps/ui/sources/dev/reactNativeWebviewStub.ts
apps/ui/sources/dev/rnEncryptionStub.ts
apps/ui/sources/dev/stackScreenInlineOptions.test.ts
apps/ui/sources/dev/testRunner.ts
apps/ui/sources/dev/testkit/rootLayoutTestkit.ts
apps/ui/sources/dev/unistylesStyleSheetImports.test.ts
apps/ui/sources/dev/vitestIntegrationConfig.test.ts
apps/ui/sources/dev/vitestRnShim.test.ts
apps/ui/sources/dev/vitestRnShim.ts
apps/ui/sources/dev/vitestSetup.ts
apps/ui/sources/encryption/aes.web.test.ts
apps/ui/sources/encryption/base64.test.ts
apps/ui/sources/encryption/libsodium.lib.web.exports.test.ts
apps/ui/sources/encryption/text.test.ts
apps/ui/sources/hooks/auth/useCLIDetection.hook.test.ts
apps/ui/sources/hooks/auth/useConnectAccount.scannerLifecycle.test.tsx
apps/ui/sources/hooks/inbox/useChangelog.featureGate.test.tsx
apps/ui/sources/hooks/inbox/useInboxHasContent.test.ts
apps/ui/sources/hooks/inbox/useUpdates.test.ts
apps/ui/sources/hooks/machine/useCapabilityInstallability.test.tsx
apps/ui/sources/hooks/machine/useMachineEnvPresence.test.tsx
apps/ui/sources/hooks/search/useSearch.hook.test.ts
apps/ui/sources/hooks/server/connectedServices/useConnectedServiceQuotaBadges.test.ts
apps/ui/sources/hooks/server/serverFeatureHookHarness.testHelpers.ts
apps/ui/sources/hooks/server/serverFeaturesTestUtils.ts
apps/ui/sources/hooks/server/useAutomationsSupport.test.ts
apps/ui/sources/hooks/server/useEnvironmentVariables.hook.test.ts
apps/ui/sources/hooks/server/useEnvironmentVariables.test.ts
apps/ui/sources/hooks/server/useFeatureDecision.test.ts
apps/ui/sources/hooks/server/useFeatureDetails.test.ts
apps/ui/sources/hooks/server/useFeatureEnabled.test.ts
apps/ui/sources/hooks/server/useFriendsAllowUsernameSupport.test.ts
apps/ui/sources/hooks/server/useFriendsEnabled.test.ts
apps/ui/sources/hooks/server/useFriendsIdentityReadiness.test.ts
apps/ui/sources/hooks/server/useFriendsRequiredIdentityProviderId.test.ts
apps/ui/sources/hooks/server/useHappierVoiceSupport.test.ts
apps/ui/sources/hooks/server/useMachineCapabilitiesCache.hook.test.ts
apps/ui/sources/hooks/server/useMachineCapabilitiesCache.race.test.ts
apps/ui/sources/hooks/server/useOAuthProviderConfigured.test.ts
apps/ui/sources/hooks/session/files/executeScmCommit.daemonUnavailable.test.ts
apps/ui/sources/hooks/session/files/sessionPathState.test.ts
apps/ui/sources/hooks/session/files/useChangedFilesData.test.tsx
apps/ui/sources/hooks/session/files/useFileScmStageActions.daemonUnavailable.test.ts
apps/ui/sources/hooks/session/files/useFilesScmOperations.daemonUnavailable.test.ts
apps/ui/sources/hooks/session/files/useFilesScmOperations.unsupportedNotDaemon.test.ts
apps/ui/sources/hooks/session/files/useRepositoryTreeBrowser.test.tsx
apps/ui/sources/hooks/session/files/useScmOperationsVisibility.test.ts
apps/ui/sources/hooks/session/useConnectTerminal.authRedirect.test.tsx
apps/ui/sources/hooks/session/useConnectTerminal.scannerLifecycle.test.tsx
apps/ui/sources/hooks/session/useNavigateToSession.multiServer.test.tsx
apps/ui/sources/hooks/session/useUserMessageHistory.navigatorStability.test.tsx
apps/ui/sources/hooks/session/useUserMessageHistory.sessionMessagesSelector.test.ts
apps/ui/sources/hooks/session/userMessageHistory.test.ts
apps/ui/sources/hooks/ui/useHappyAction.daemonUnavailable.test.tsx
apps/ui/sources/hooks/ui/useMountedShouldContinue.test.ts
apps/ui/sources/hooks/ui/useTabState.test.tsx
apps/ui/sources/metro/metro.kokoroResolver.spec.ts
apps/ui/sources/modal/ModalManager.test.ts
apps/ui/sources/modal/ModalProvider.test.ts
apps/ui/sources/modal/components/BaseModal.test.ts
apps/ui/sources/modal/components/BaseModal.webNativeDriver.test.tsx
apps/ui/sources/modal/components/WebAlertModal.test.tsx
apps/ui/sources/modal/components/WebPromptModal.test.tsx
apps/ui/sources/platform/nodeShims/nodeFsPromisesShim.ts
apps/ui/sources/platform/nodeShims/nodeFsShim.ts
apps/ui/sources/platform/nodeShims/nodePathShim.ts
apps/ui/sources/platform/nodeShims/nodeUrlShim.ts
apps/ui/sources/platform/shims/fontFaceObserverWebShim.spec.ts
apps/ui/sources/platform/shims/fontFaceObserverWebShim.ts
apps/ui/sources/platform/stubs/huggingfaceTransformersStub.ts
apps/ui/sources/platform/stubs/kokoroJsStub.ts
apps/ui/sources/platform/stubs/onnxruntimeWebStub.ts
apps/ui/sources/profileRouteParams.test.ts
apps/ui/sources/realtime/RealtimeProvider.web.test.tsx
apps/ui/sources/realtime/RealtimeSession.voiceModes.spec.ts
apps/ui/sources/realtime/RealtimeVoiceSession.sessionId.spec.tsx
apps/ui/sources/realtime/RealtimeVoiceSession.web.spec.tsx
apps/ui/sources/realtime/elevenlabs/autoprovision.spec.ts
apps/ui/sources/realtime/elevenlabs/elevenLabsApi.spec.ts
apps/ui/sources/realtime/elevenlabs/elevenLabsVoices.spec.ts
apps/ui/sources/realtime/elevenlabs/requiredClientTools.test.ts
apps/ui/sources/realtime/realtimeClientTools.spec.ts
apps/ui/sources/scm/core/operationPolicy.test.ts
apps/ui/sources/scm/diff/defaultMode.test.ts
apps/ui/sources/scm/diff/extractUnifiedDiffForSingleFile.test.ts
apps/ui/sources/scm/diff/fallbackUnifiedDiff.test.ts
apps/ui/sources/scm/diff/looksLikeUnifiedDiff.test.ts
apps/ui/sources/scm/diffCache/scmDiffCache.test.ts
apps/ui/sources/scm/diffCache/scmDiffPrefetchScheduler.test.ts
apps/ui/sources/scm/diffCache/useScmDiffCacheLimits.test.tsx
apps/ui/sources/scm/operations/applyBulkFileStageAction.test.ts
apps/ui/sources/scm/operations/applyFileDiscardAction.daemonUnavailable.test.ts
apps/ui/sources/scm/operations/applyFileStageAction.daemonUnavailable.test.ts
apps/ui/sources/scm/operations/commitFailureMessage.test.ts
apps/ui/sources/scm/operations/commitMessage.test.ts
apps/ui/sources/scm/operations/commitMessageGenerator.test.ts
apps/ui/sources/scm/operations/commitSelectionHints.test.ts
apps/ui/sources/scm/operations/remoteFeedback.test.ts
apps/ui/sources/scm/operations/remoteTarget.test.ts
apps/ui/sources/scm/operations/reporting.test.ts
apps/ui/sources/scm/operations/revertFeedback.test.ts
apps/ui/sources/scm/operations/scmDaemonUnavailableAlert.test.ts
apps/ui/sources/scm/operations/withOperationLock.test.ts
apps/ui/sources/scm/refresh/useScmAdaptivePolling.test.tsx
apps/ui/sources/scm/refresh/workspaceMutationDetection/extractWorkspaceMutations.test.ts
apps/ui/sources/scm/refresh/workspaceMutationIngestion.test.ts
apps/ui/sources/scm/refresh/workspaceMutationInvalidator.test.ts
apps/ui/sources/scm/registry/scmUiBackendRegistry.test.ts
apps/ui/sources/scm/scmAttribution.test.ts
apps/ui/sources/scm/scmLineSelection.test.ts
apps/ui/sources/scm/scmPatchSelection.test.ts
apps/ui/sources/scm/scmRepositoryService.test.ts
apps/ui/sources/scm/scmSafety.test.ts
apps/ui/sources/scm/scmStatusFiles.test.ts
apps/ui/sources/scm/scmStatusSync.polling.test.ts
apps/ui/sources/scm/scmStatusSync.test.ts
apps/ui/sources/scm/scmUserFacingErrors.test.ts
apps/ui/sources/scm/settings/commitStrategy.test.ts
apps/ui/sources/scm/settings/scmBackendSettingsRegistry.test.ts
apps/ui/sources/scm/statusSync/errorReporting.test.ts
apps/ui/sources/scm/statusSync/projectState.test.ts
apps/ui/sources/scm/utils/filePathParam.test.ts
apps/ui/sources/scm/utils/filePresentation.test.ts
apps/ui/sources/sync/__testdata__/trace_0.json
apps/ui/sources/sync/__testdata__/trace_1.json
apps/ui/sources/sync/__testdata__/trace_2.json
apps/ui/sources/sync/acp/configOptionsControl.test.ts
apps/ui/sources/sync/acp/sessionModeControl.test.ts
apps/ui/sources/sync/api/account/apiAccountEncryptionMode.test.ts
apps/ui/sources/sync/api/account/apiConnectedServicesQuotasV2.test.ts
apps/ui/sources/sync/api/account/apiConnectedServicesQuotasV3.test.ts
apps/ui/sources/sync/api/account/apiConnectedServicesV2.test.ts
apps/ui/sources/sync/api/account/apiConnectedServicesV3.test.ts
apps/ui/sources/sync/api/account/apiKv.serverGeneration.test.ts
apps/ui/sources/sync/api/account/apiUsage.serverGeneration.test.ts
apps/ui/sources/sync/api/account/apiUsername.test.ts
apps/ui/sources/sync/api/account/apiVendorTokens.test.ts
apps/ui/sources/sync/api/automations/apiAutomationRuns.test.ts
apps/ui/sources/sync/api/automations/apiAutomations.test.ts
apps/ui/sources/sync/api/capabilities/serverFeaturesClient.guardrail.test.ts
apps/ui/sources/sync/api/capabilities/serverFeaturesClient.test.ts
apps/ui/sources/sync/api/capabilities/serverFeaturesParse.spec.ts
apps/ui/sources/sync/api/session/apiChanges.spec.ts
apps/ui/sources/sync/api/session/apiSocket.request.serverScopedAuth.test.ts
apps/ui/sources/sync/api/session/apiSocket.transports.test.ts
apps/ui/sources/sync/api/social/apiFriends.githubRequired.feat.social.friends.test.ts
apps/ui/sources/sync/api/types/apiTypes.sessionMessages.test.ts
apps/ui/sources/sync/api/voice/apiVoice.test.ts
apps/ui/sources/sync/domains/actions/buildActionDraftInput.test.ts
apps/ui/sources/sync/domains/automations/automationExistingSessionTemplateUpdate.test.ts
apps/ui/sources/sync/domains/automations/automationSessionLink.test.ts
apps/ui/sources/sync/domains/automations/automationTemplateCodec.test.ts
apps/ui/sources/sync/domains/automations/automationTemplateTransport.test.ts
apps/ui/sources/sync/domains/automations/automationValidation.test.ts
apps/ui/sources/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount.test.ts
apps/ui/sources/sync/domains/connectedServices/connectedServiceProfilePreferences.test.ts
apps/ui/sources/sync/domains/connectedServices/connectedServiceQuotaBadges.test.ts
apps/ui/sources/sync/domains/connectedServices/filterConnectedServiceV2ProfilesForAgent.test.ts
apps/ui/sources/sync/domains/connectedServices/oauth/anthropicOauth.test.ts
apps/ui/sources/sync/domains/connectedServices/oauth/geminiOauth.test.ts
apps/ui/sources/sync/domains/connectedServices/oauth/openAiCodexOauth.test.ts
apps/ui/sources/sync/domains/connectedServices/openConnectedServiceQuotaSnapshot.test.ts
apps/ui/sources/sync/domains/connectedServices/sealConnectedServiceCredential.test.ts
apps/ui/sources/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount.test.ts
apps/ui/sources/sync/domains/features/featureDecisionInputs.test.ts
apps/ui/sources/sync/domains/features/featureDecisionRuntime.feat.voice.agent.test.ts
apps/ui/sources/sync/domains/features/featureDecisionRuntime.test.ts
apps/ui/sources/sync/domains/features/featureLocalPolicy.test.ts
apps/ui/sources/sync/domains/input/participants/resolveParticipantRoutedSend.test.ts
apps/ui/sources/sync/domains/input/repositoryDirectory.test.ts
apps/ui/sources/sync/domains/input/reviewComments/reviewCommentMeta.test.ts
apps/ui/sources/sync/domains/input/reviewComments/reviewCommentPrompt.test.ts
apps/ui/sources/sync/domains/input/slashCommands/executeSessionComposerResolution.test.ts
apps/ui/sources/sync/domains/input/slashCommands/parseSessionSlashCommand.test.ts
apps/ui/sources/sync/domains/input/slashCommands/resolveSessionComposerSend.test.ts
apps/ui/sources/sync/domains/input/suggestionCommands.test.ts
apps/ui/sources/sync/domains/input/suggestionFile.test.ts
apps/ui/sources/sync/domains/messages/buildSendMessageMeta.metaOverrides.test.ts
apps/ui/sources/sync/domains/messages/buildSendMessageMeta.test.ts
apps/ui/sources/sync/domains/messages/messageMeta.providerExtras.test.ts
apps/ui/sources/sync/domains/messages/messageMeta.test.ts
apps/ui/sources/sync/domains/messages/messageMetaProviders.test.ts
apps/ui/sources/sync/domains/messages/messageMetaTypes.forwardCompat.test.ts
apps/ui/sources/sync/domains/messages/messageMetaTypes.passthrough.test.ts
apps/ui/sources/sync/domains/messages/sentFrom.test.ts
apps/ui/sources/sync/domains/messages/unread.test.ts
apps/ui/sources/sync/domains/models/describeEffectiveModelMode.test.ts
apps/ui/sources/sync/domains/models/dynamicModelProbeCache.ts
apps/ui/sources/sync/domains/models/dynamicModelProbeCacheKey.test.ts
apps/ui/sources/sync/domains/models/modelOptions.i18n.test.ts
apps/ui/sources/sync/domains/models/modelOptions.preflight.test.ts
apps/ui/sources/sync/domains/models/modelOptions.test.ts
apps/ui/sources/sync/domains/models/modelOverride.test.ts
apps/ui/sources/sync/domains/pending/pendingNotificationNav.test.ts
apps/ui/sources/sync/domains/pending/pendingQueueWake.test.ts
apps/ui/sources/sync/domains/pending/pendingTerminalConnect.test.ts
apps/ui/sources/sync/domains/pending/pendingTerminalConnect.web.test.ts
apps/ui/sources/sync/domains/permissions/deriveNewPermissionRequests.test.ts
apps/ui/sources/sync/domains/permissions/describeEffectivePermissionMode.test.ts
apps/ui/sources/sync/domains/permissions/permissionDefaults.test.ts
apps/ui/sources/sync/domains/permissions/permissionModeApply.test.ts
apps/ui/sources/sync/domains/permissions/permissionModeOptions.i18n.test.ts
apps/ui/sources/sync/domains/permissions/permissionModeOptions.test.ts
apps/ui/sources/sync/domains/permissions/permissionModeOverride.test.ts
apps/ui/sources/sync/domains/permissions/permissionTypes.test.ts
apps/ui/sources/sync/domains/profiles/profileGrouping.test.ts
apps/ui/sources/sync/domains/profiles/profileUtils.test.ts
apps/ui/sources/sync/domains/purchases/purchases.spec.ts
apps/ui/sources/sync/domains/purchases/requiredEntitlements.spec.ts
apps/ui/sources/sync/domains/purchases/revenueCat.entitlementMigration.spec.ts
apps/ui/sources/sync/domains/reviews/reviewEngineCatalog.test.ts
apps/ui/sources/sync/domains/server/activeServerSwitch.normalizeServerUrl.test.ts
apps/ui/sources/sync/domains/server/selection/serverSelectionMutations.test.ts
apps/ui/sources/sync/domains/server/selection/serverSelectionResolver.test.ts
apps/ui/sources/sync/domains/server/serverConfig.test.ts
apps/ui/sources/sync/domains/server/serverProfiles.test.ts
apps/ui/sources/sync/domains/server/url/serverUrlCanonical.test.ts
apps/ui/sources/sync/domains/server/url/serverUrlClassification.test.ts
apps/ui/sources/sync/domains/session/control/controlledByUserTransitions.test.ts
apps/ui/sources/sync/domains/session/control/localControlSwitch.test.ts
apps/ui/sources/sync/domains/session/control/submitMode.test.ts
apps/ui/sources/sync/domains/session/listing/computeVisibleSessionListViewData.test.ts
apps/ui/sources/sync/domains/session/listing/sessionListOrderingStateV1.test.ts
apps/ui/sources/sync/domains/session/listing/sessionListPresentation.test.ts
apps/ui/sources/sync/domains/session/listing/sessionListViewData.test.ts
apps/ui/sources/sync/domains/session/metadata/updateSessionMetadataWithRetry.test.ts
apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts
apps/ui/sources/sync/domains/session/resume/resumeSessionBase.test.ts
apps/ui/sources/sync/domains/session/resume/resumeSessionPayload.test.ts
apps/ui/sources/sync/domains/session/sequence/realtimeSessionSeq.test.ts
apps/ui/sources/sync/domains/session/spawn/windowsRemoteSessionConsole.test.ts
apps/ui/sources/sync/domains/sessionModes/dynamicSessionModeProbeCache.ts
apps/ui/sources/sync/domains/settings/accountSettingsCipher.test.ts
apps/ui/sources/sync/domains/settings/actionsSettings.test.ts
apps/ui/sources/sync/domains/settings/executionRunsGuidance.test.ts
apps/ui/sources/sync/domains/settings/installablesPolicy.test.ts
apps/ui/sources/sync/domains/settings/localSettings.test.ts
apps/ui/sources/sync/domains/settings/secretBindings.test.ts
apps/ui/sources/sync/domains/settings/settings.providerPlugins.test.ts
apps/ui/sources/sync/domains/settings/settings.providerPlugins.undefinedDefaults.test.ts
apps/ui/sources/sync/domains/settings/settings.spec.ts
apps/ui/sources/sync/domains/settings/terminalSettings.spec.ts
apps/ui/sources/sync/domains/settings/voiceSettings.spec.ts
apps/ui/sources/sync/domains/social/sharingRequests/buildCreateSessionShareRequest.test.ts
apps/ui/sources/sync/domains/state/agentStateCapabilities.test.ts
apps/ui/sources/sync/domains/state/persistence.test.ts
apps/ui/sources/sync/domains/state/persistence.ts
apps/ui/sources/sync/domains/state/readStateV1.test.ts
apps/ui/sources/sync/domains/state/storageTypes.agentStateCapabilities.test.ts
apps/ui/sources/sync/domains/state/storageTypes.discardedCommitted.test.ts
apps/ui/sources/sync/domains/state/storageTypes.machineMetadata.test.ts
apps/ui/sources/sync/domains/state/storageTypes.permissionMode.test.ts
apps/ui/sources/sync/domains/state/storageTypes.systemSession.test.ts
apps/ui/sources/sync/domains/state/storageTypes.terminal.test.ts
apps/ui/sources/sync/encryption/encryption.automationTemplates.test.ts
apps/ui/sources/sync/encryption/encryption.initializeMachines.keyUpdate.test.ts
apps/ui/sources/sync/encryption/encryption.initializeSessions.keyUpdate.test.ts
apps/ui/sources/sync/encryption/secretSettings.test.ts
apps/ui/sources/sync/encryption/sessionEncryption.decryptMessages.cacheBehavior.test.ts
apps/ui/sources/sync/engine/account/syncAccount.accountSettingsCipher.test.ts
apps/ui/sources/sync/engine/account/syncAccount.connectedServicesV2.test.ts
apps/ui/sources/sync/engine/account/syncAccount.pushTokenLogging.test.ts
apps/ui/sources/sync/engine/account/syncAccount.pushTokenMultiServer.test.ts
apps/ui/sources/sync/engine/account/syncAccount.settingsSync.test.ts
apps/ui/sources/sync/engine/account/syncAccount.settingsV2.plain.test.ts
apps/ui/sources/sync/engine/artifacts/syncArtifacts.staleUpdates.test.ts
apps/ui/sources/sync/engine/automations/automationSocketApply.test.ts
apps/ui/sources/sync/engine/automations/syncAutomations.test.ts
apps/ui/sources/sync/engine/machines/syncMachines.fetchRequest.test.ts
apps/ui/sources/sync/engine/machines/syncMachines.staleUpdates.test.ts
apps/ui/sources/sync/engine/overrides/acpConfigOptionOverridePublish.test.ts
apps/ui/sources/sync/engine/overrides/acpSessionModeOverridePublish.test.ts
apps/ui/sources/sync/engine/overrides/modelOverridePublish.test.ts
apps/ui/sources/sync/engine/overrides/permissionModePublish.test.ts
apps/ui/sources/sync/engine/pending/pendingQueueV2.decryptMapping.test.ts
apps/ui/sources/sync/engine/pending/pendingQueueV2.errorHandling.test.ts
apps/ui/sources/sync/engine/pending/pendingQueueV2.optimisticThinking.test.ts
apps/ui/sources/sync/engine/pending/pendingQueueV2.testHelpers.ts
apps/ui/sources/sync/engine/pending/pendingQueueV2.updatePendingMessageV2.test.ts
apps/ui/sources/sync/engine/sessions/sessionMessageApplyCoalescer.test.ts
apps/ui/sources/sync/engine/sessions/syncSessions.fetchMessages.sidechainParentBackfill.test.ts
apps/ui/sources/sync/engine/sessions/syncSessions.fetchNewerMessages.test.ts
apps/ui/sources/sync/engine/sessions/syncSessions.fetchOlderMessages.noLifecycle.test.ts
apps/ui/sources/sync/engine/sessions/syncSessions.newMessageSocketUpdate.test.ts
apps/ui/sources/sync/engine/sessions/syncSessions.sessionMissing.test.ts
apps/ui/sources/sync/engine/sessions/syncSessions.updateSessionSocket.plaintext.test.ts
apps/ui/sources/sync/engine/sessions/syncSessions.v2SessionsFetch.test.ts
apps/ui/sources/sync/engine/settings/syncSettings.accountSettingsCipher.test.ts
apps/ui/sources/sync/engine/settings/syncSettings.localOnlyServerSelection.test.ts
apps/ui/sources/sync/engine/social/relationshipUpdate.test.ts
apps/ui/sources/sync/engine/social/syncFriends.feat.social.friends.test.ts
apps/ui/sources/sync/engine/socket/socket.automationUpdates.test.ts
apps/ui/sources/sync/engine/socket/socket.cursorIsolation.test.ts
apps/ui/sources/sync/engine/socket/socket.newMachineUpdates.test.ts
apps/ui/sources/sync/engine/socket/socket.reconnect.test.ts
apps/ui/sources/sync/engine/socket/socket.scmInvalidation.test.ts
apps/ui/sources/sync/engine/socket/socketEmitWithAckFallback.test.ts
apps/ui/sources/sync/engine/socket/socketParse.test.ts
apps/ui/sources/sync/http/client.abort.test.ts
apps/ui/sources/sync/http/client.authInvalidation.test.ts
apps/ui/sources/sync/http/client.runtimeFetch.test.ts
apps/ui/sources/sync/ops/__tests__/gitRepoHarness.initBareRemote.test.ts
apps/ui/sources/sync/ops/__tests__/gitRepoHarness.initRepo.test.ts
apps/ui/sources/sync/ops/__tests__/gitRepoHarness.ts
apps/ui/sources/sync/ops/__tests__/saplingRepoHarness.ts
apps/ui/sources/sync/ops/__tests__/sessionAbort.test.ts
apps/ui/sources/sync/ops/__tests__/sessionArchive.serverScope.test.ts
apps/ui/sources/sync/ops/__tests__/sessionDelete.serverScope.test.ts
apps/ui/sources/sync/ops/__tests__/sessionStop.serverScope.test.ts
apps/ui/sources/sync/ops/__tests__/sessionStop.test.ts
apps/ui/sources/sync/ops/__tests__/spawnSessionPayload.test.ts
apps/ui/sources/sync/ops/account/buildAccountEncryptionMigrateToE2eeRequest.test.ts
apps/ui/sources/sync/ops/account/buildAccountEncryptionMigrateToPlainRequest.test.ts
apps/ui/sources/sync/ops/actions/actionExecutor.test.ts
apps/ui/sources/sync/ops/machineAccount.revoke.test.ts
apps/ui/sources/sync/ops/machineExecutionRuns.test.ts
apps/ui/sources/sync/ops/machineMetadataMerge.test.ts
apps/ui/sources/sync/ops/machines.spawn.errorMapping.test.ts
apps/ui/sources/sync/ops/machines.stopDaemon.test.ts
apps/ui/sources/sync/ops/machines.stopSession.test.ts
apps/ui/sources/sync/ops/sessionAttachmentsUpload.test.ts
apps/ui/sources/sync/ops/sessionEphemeralTasks.test.ts
apps/ui/sources/sync/ops/sessionExecutionRuns.test.ts
apps/ui/sources/sync/ops/sessionScm.test.ts
apps/ui/sources/sync/ops/sessions.createDirectory.test.ts
apps/ui/sources/sync/ops/sessions.permissionDeny.test.ts
apps/ui/sources/sync/ops/sessions.readFile.test.ts
apps/ui/sources/sync/ops/sessions.readLogTail.test.ts
apps/ui/sources/sync/ops/sessions.serverScoped.test.ts
apps/ui/sources/sync/ops/sessions.writeFile.test.ts
apps/ui/sources/sync/reducer/activityUpdateAccumulator.test.ts
apps/ui/sources/sync/reducer/helpers/thinkingText.test.ts
apps/ui/sources/sync/reducer/messageToEvent.test.ts
apps/ui/sources/sync/reducer/permissionPlaceholder.toolResultOverride.test.ts
apps/ui/sources/sync/reducer/phase0-skipping.spec.ts
apps/ui/sources/sync/reducer/phases/agentStatePermissions.execpolicyAmendment.test.ts
apps/ui/sources/sync/reducer/reducer.seq.test.ts
apps/ui/sources/sync/reducer/reducer.spec.ts
apps/ui/sources/sync/reducer/reducer.streamingMerge.agentIdReuse.test.ts
apps/ui/sources/sync/reducer/reducer.streamingMerge.test.ts
apps/ui/sources/sync/reducer/reducer.streamingMerge.thinkingCursor.test.ts
apps/ui/sources/sync/reducer/reducer.streamingMerge.thinkingInterleaved.test.ts
apps/ui/sources/sync/reducer/reducer.streamingMerge.toolBoundary.test.ts
apps/ui/sources/sync/reducer/reducerTracer.dedupe.spec.ts
apps/ui/sources/sync/reducer/reducerTracer.orphans.spec.ts
apps/ui/sources/sync/reducer/reducerTracer.sidechainLinking.spec.ts
apps/ui/sources/sync/reducer/reducerTracer.taskMapping.spec.ts
apps/ui/sources/sync/reducer/sidechains.providerAgnostic.spec.ts
apps/ui/sources/sync/reducer/userAndText.streaming.providerAgnostic.spec.ts
apps/ui/sources/sync/runtime/appVariant.test.ts
apps/ui/sources/sync/runtime/orchestration/applyMessageCatchUpDecision.test.ts
apps/ui/sources/sync/runtime/orchestration/changesApplier.test.ts
apps/ui/sources/sync/runtime/orchestration/changesPlanner.test.ts
apps/ui/sources/sync/runtime/orchestration/concurrentSessionCache.socketRouting.test.ts
apps/ui/sources/sync/runtime/orchestration/concurrentSessionCache.test.ts
apps/ui/sources/sync/runtime/orchestration/connectionManager.abortOnSwitch.test.ts
apps/ui/sources/sync/runtime/orchestration/messageCatchUpPolicy.test.ts
apps/ui/sources/sync/runtime/orchestration/projectManager.gitAttribution.test.ts
apps/ui/sources/sync/runtime/orchestration/projectManager.gitOperations.test.ts
apps/ui/sources/sync/runtime/orchestration/projectManager.scmSnapshotError.test.ts
apps/ui/sources/sync/runtime/orchestration/runTasksWithLimit.test.ts
apps/ui/sources/sync/runtime/orchestration/runWithInFlightDedupe.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc.retry.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc.test.ts
apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage.test.ts
apps/ui/sources/sync/runtime/orchestration/socketReconnectViaChanges.test.ts
apps/ui/sources/sync/runtime/rpcErrors.test.ts
apps/ui/sources/sync/runtime/syncTuning.test.ts
apps/ui/sources/sync/store/domains/automations.test.ts
apps/ui/sources/sync/store/domains/messages.ordering.seq.test.ts
apps/ui/sources/sync/store/domains/messages.permissionInference.test.ts
apps/ui/sources/sync/store/domains/messages.permissionInferenceLifecycle.test.ts
apps/ui/sources/sync/store/domains/messages.reset.test.ts
apps/ui/sources/sync/store/domains/sessions.actionDrafts.test.ts
apps/ui/sources/sync/store/domains/sessions.modelModeNormalization.test.ts
apps/ui/sources/sync/store/domains/sessions.permissionModeNormalization.test.ts
apps/ui/sources/sync/store/domains/sessions.reviewCommentsDrafts.test.ts
apps/ui/sources/sync/store/domains/sessions.voiceSideEffects.test.ts
apps/ui/sources/sync/store/hooks.useAllMachines.test.tsx
apps/ui/sources/sync/store/hooks.useMessagesByIds.test.tsx
apps/ui/sources/sync/store/hooks.useSessionMessages.test.tsx
apps/ui/sources/sync/store/sessionListCache.test.ts
apps/ui/sources/sync/sync.assumeUsers.test.ts
apps/ui/sources/sync/sync.create.initialAwaitTimeout.test.ts
apps/ui/sources/sync/sync.optimisticThinking.test.ts
apps/ui/sources/sync/sync.sessionMissingServerScope.test.ts
apps/ui/sources/sync/sync.voicePermissionRequests.test.ts
apps/ui/sources/sync/typesRaw.spec.ts
apps/ui/sources/sync/typesRaw/normalize.permissionRequest.test.ts
apps/ui/sources/sync/typesRaw/normalize.progressRecord.test.ts
apps/ui/sources/sync/typesRaw/normalize.sidechainId.test.ts
apps/ui/sources/sync/typesRaw/normalize.taskNotification.test.ts
apps/ui/sources/text/_default.test.ts
apps/ui/sources/text/i18n.integrity.test.ts
apps/ui/sources/text/userFacingTextScan.sources.test.ts
apps/ui/sources/text/userFacingTextScan.test.ts
apps/ui/sources/tools/tauri/make-latest-json.test.ts
apps/ui/sources/tools/tauri/updateEndpoints.test.ts
apps/ui/sources/track/tracking.featureGate.test.ts
apps/ui/sources/track/useTrackScreens.test.tsx
apps/ui/sources/utils/auth/oauthCore.test.ts
apps/ui/sources/utils/code/normalizeCodeLanguageId.test.ts
apps/ui/sources/utils/errors/daemonUnavailableAlert.test.ts
apps/ui/sources/utils/errors/errors.test.ts
apps/ui/sources/utils/errors/formatOperationFailedDebugMessage.test.ts
apps/ui/sources/utils/errors/getErrorMessage.test.ts
apps/ui/sources/utils/errors/toolErrorParser.test.ts
apps/ui/sources/utils/path/isSafeWorkspaceRelativePath.test.ts
apps/ui/sources/utils/path/pathUtils.spec.ts
apps/ui/sources/utils/path/routeUtils.test.ts
apps/ui/sources/utils/path/terminalConnectUrl.test.ts
apps/ui/sources/utils/platform/deviceCalculations.test.ts
apps/ui/sources/utils/platform/platform.test.ts
apps/ui/sources/utils/platform/webMobileHeuristics.test.ts
apps/ui/sources/utils/profiles/envVarTemplate.test.ts
apps/ui/sources/utils/profiles/profileConfigRequirements.test.ts
apps/ui/sources/utils/secrets/normalizeSecretInput.test.ts
apps/ui/sources/utils/secrets/secretRequirementApply.test.ts
apps/ui/sources/utils/secrets/secretRequirementPromptEligibility.test.ts
apps/ui/sources/utils/secrets/secretSatisfaction.test.ts
apps/ui/sources/utils/sessions/deriveTranscriptInteraction.test.ts
apps/ui/sources/utils/sessions/discardedCommittedMessages.test.ts
apps/ui/sources/utils/sessions/jumpToTranscriptSeq.test.ts
apps/ui/sources/utils/sessions/machineUtils.test.ts
apps/ui/sources/utils/sessions/permissions/findToolCallMessageForPermissionId.test.ts
apps/ui/sources/utils/sessions/permissions/resolvePermissionToolCallLocations.test.ts
apps/ui/sources/utils/sessions/sessionUtils.test.ts
apps/ui/sources/utils/sessions/sortNormalizedMessagesOldestFirst.test.ts
apps/ui/sources/utils/sessions/sync.test.ts
apps/ui/sources/utils/sessions/terminalSessionDetails.test.ts
apps/ui/sources/utils/strings/countTextLinesUpTo.test.ts
apps/ui/sources/utils/strings/toSnakeCase.test.ts
apps/ui/sources/utils/system/bugReportActionTrail.test.ts
apps/ui/sources/utils/system/bugReportLogBuffer.missingConsoleMethods.test.ts
apps/ui/sources/utils/system/bugReportLogBuffer.test.ts
apps/ui/sources/utils/system/fireAndForget.test.ts
apps/ui/sources/utils/system/postinstallRunCommand.test.ts
apps/ui/sources/utils/system/requestReview.test.ts
apps/ui/sources/utils/system/runtimeFetch.test.ts
apps/ui/sources/utils/system/sentry.bugReportReplay.test.ts
apps/ui/sources/utils/system/sentry.optOut.test.ts
apps/ui/sources/utils/system/storageScope.test.ts
apps/ui/sources/utils/system/versionUtils.test.ts
apps/ui/sources/utils/timing/debounce.test.ts
apps/ui/sources/utils/timing/pauseController.test.ts
apps/ui/sources/utils/timing/time.test.ts
apps/ui/sources/utils/tools/toolComparison.test.ts
apps/ui/sources/utils/ui/clipboard.test.ts
apps/ui/sources/utils/ui/ignoreNextRowPress.test.ts
apps/ui/sources/utils/ui/promptUnsavedChangesAlert.test.ts
apps/ui/sources/utils/ui/toTestIdSafeValue.test.ts
apps/ui/sources/utils/url/sessionFileDeepLink.test.ts
apps/ui/sources/utils/url/urlSafety.test.ts
apps/ui/sources/utils/worktree/createWorktree.daemonUnavailable.test.ts
apps/ui/sources/voice/activity/voiceActivityStore.spec.ts
apps/ui/sources/voice/adapters/localConversation/localConversationAdapter.spec.ts
apps/ui/sources/voice/adapters/localDirect/localDirectAdapter.spec.ts
apps/ui/sources/voice/adapters/realtimeElevenLabs/realtimeElevenLabsAdapter.spec.ts
apps/ui/sources/voice/adapters/registerBuiltinVoiceAdapters.web.spec.ts
apps/ui/sources/voice/agent/VoiceAgentSessionController.persistence.spec.ts
apps/ui/sources/voice/agent/VoiceAgentSessionController.streaming.spec.ts
apps/ui/sources/voice/agent/daemonVoiceAgentClient.spec.ts
apps/ui/sources/voice/agent/openaiCompatVoiceAgentClient.test.ts
apps/ui/sources/voice/agent/resolveDaemonVoiceAgentModels.test.ts
apps/ui/sources/voice/agent/teleportVoiceAgentToSessionRoot.test.ts
apps/ui/sources/voice/agent/voiceCarrierSession.test.ts
apps/ui/sources/voice/context/contextFormatters.permission.spec.ts
apps/ui/sources/voice/context/contextFormatters.privacy.spec.ts
apps/ui/sources/voice/context/voiceHooks.privacy.spec.ts
apps/ui/sources/voice/context/voiceHooks.sinkRouting.spec.ts
apps/ui/sources/voice/downloads/downloadProgress.spec.ts
apps/ui/sources/voice/input/SherpaStreamingSttController.spec.ts
apps/ui/sources/voice/input/SherpaStreamingSttController.web.spec.ts
apps/ui/sources/voice/input/TurnEndpointDetector.spec.ts
apps/ui/sources/voice/input/googleGeminiModelsApi.spec.ts
apps/ui/sources/voice/input/googleGeminiStt.spec.ts
apps/ui/sources/voice/input/transcribeRecordedAudio.spec.ts
apps/ui/sources/voice/kokoro/assets/kokoroAssetSets.spec.ts
apps/ui/sources/voice/kokoro/assets/kokoroBrowserCache.spec.ts
apps/ui/sources/voice/kokoro/assets/kokoroCacheApi.spec.ts
apps/ui/sources/voice/kokoro/audio/encodeWavPcm16.spec.ts
apps/ui/sources/voice/kokoro/config/kokoroConfig.spec.ts
apps/ui/sources/voice/kokoro/runtime/kokoroSupport.spec.ts
apps/ui/sources/voice/kokoro/runtime/kokoroWebWorkerClient.web.ts
apps/ui/sources/voice/kokoro/runtime/loadKokoroWebRuntime.spec.ts
apps/ui/sources/voice/kokoro/runtime/synthesizeKokoroWav.native.spec.ts
apps/ui/sources/voice/kokoro/runtime/synthesizeKokoroWav.spec.ts
apps/ui/sources/voice/local/fetchOpenAiCompatSpeechAudio.test.ts
apps/ui/sources/voice/local/formatVoiceTestFailureMessage.test.ts
apps/ui/sources/voice/local/localVoiceEngine.agent.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.deviceStt.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.kokoro.agent.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.localNeuralStt.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.recording.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.stop.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.testHarness.ts
apps/ui/sources/voice/local/localVoiceEngine.tts.spec.ts
apps/ui/sources/voice/local/localVoiceTelemetry.spec.ts
apps/ui/sources/voice/local/openaiCompat.spec.ts
apps/ui/sources/voice/local/playAudioBytes.web.test.ts
apps/ui/sources/voice/modelPacks/installer.spec.ts
apps/ui/sources/voice/modelPacks/manifest.spec.ts
apps/ui/sources/voice/modelPacks/manifests.spec.ts
apps/ui/sources/voice/output/GoogleCloudTtsController.spec.ts
apps/ui/sources/voice/output/KokoroTtsController.spec.ts
apps/ui/sources/voice/output/TtsChunker.spec.ts
apps/ui/sources/voice/output/playAudioBytesWithStopper.spec.ts
apps/ui/sources/voice/output/speakAssistantText.spec.ts
apps/ui/sources/voice/persistence/buildVoiceReplaySeedPromptFromCarrierSession.spec.ts
apps/ui/sources/voice/persistence/hydrateVoiceAgentActivityFromCarrierSession.test.ts
apps/ui/sources/voice/persistence/voiceAgentRunMetadata.spec.ts
apps/ui/sources/voice/runtime/deriveSessionMicActive.test.ts
apps/ui/sources/voice/runtime/googleApiKeyHeaders.spec.ts
apps/ui/sources/voice/runtime/voiceConfig.spec.ts
apps/ui/sources/voice/runtime/voiceTargetStore.test.ts
apps/ui/sources/voice/runtime/voiceUpdatePolicy.test.ts
apps/ui/sources/voice/session/VoiceSessionRuntime.spec.tsx
apps/ui/sources/voice/session/useVoiceSessionSnapshot.dom.test.tsx
apps/ui/sources/voice/session/useVoiceSessionSnapshot.hook.test.tsx
apps/ui/sources/voice/session/voiceSessionManager.spec.ts
apps/ui/sources/voice/session/voiceSessionStore.test.tsx
apps/ui/sources/voice/settings/panels/LocalConversationSection.hooksInvariant.test.ts
apps/ui/sources/voice/settings/panels/LocalConversationSection.test.tsx
apps/ui/sources/voice/settings/panels/RealtimeElevenLabsSection.test.tsx
apps/ui/sources/voice/settings/panels/localStt/providers/googleGemini/googleGeminiSttProvider.test.tsx
apps/ui/sources/voice/settings/panels/localStt/providers/registry.spec.tsx
apps/ui/sources/voice/settings/panels/localTts/LocalNeuralTtsSettings.native.spec.tsx
apps/ui/sources/voice/settings/panels/localTts/LocalNeuralTtsSettings.web.spec.tsx
apps/ui/sources/voice/settings/panels/localTts/LocalVoiceTtsGroup.spec.tsx
apps/ui/sources/voice/settings/panels/localTts/providers/googleCloud/googleCloudTtsProvider.test.tsx
apps/ui/sources/voice/settings/panels/localTts/providers/localNeural/localNeuralTtsProvider.spec.ts
apps/ui/sources/voice/settings/panels/localTts/providers/registry.spec.tsx
apps/ui/sources/voice/settings/panels/localTts/useLocalNeuralModelPackState.native.spec.tsx
apps/ui/sources/voice/tools/actionImpl/agentCatalogList.spec.ts
apps/ui/sources/voice/tools/actionImpl/spawnSessionPicker.spec.ts
apps/ui/sources/voice/tools/handlers.registry.spec.ts
apps/ui/sources/voice/tools/handlers.spec.ts
apps/ui/sources/voice/tools/resolveToolSessionId.test.ts
apps/ui/src-tauri/tauri.conf.json
apps/ui/src-tauri/tauri.preview.conf.json
apps/ui/tools/ensureNohoistPeerLinks.mjs
apps/ui/tools/i18n/translationAudit.ts
apps/ui/tools/i18n/userFacingTextScan.ts
apps/ui/tools/postinstall/runCommand.mjs
apps/ui/tools/resolveUiPostinstallTasks.mjs
apps/ui/tools/tauri/make-latest-json.mjs
apps/ui/vitest.config.ts
scripts/postinstall/shouldRunPostinstall.cjs
scripts/testing/featureTestGating.ts
```

### Integration — apps/ui (Vitest) (count: 83)

```text
apps/ui/package.json
apps/ui/sources/__tests__/app/_layout.test.ts
apps/ui/sources/__tests__/app/machine/machineDetails.capabilitiesRequestStability.test.ts
apps/ui/sources/__tests__/app/machine/machineDetails.executionRuns.test.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.revokeMachine.test.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.serverIdSwitch.test.tsx
apps/ui/sources/__tests__/app/new/index.blockingGuidance.test.tsx
apps/ui/sources/__tests__/app/new/pick/machine.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.stackOptionsStability.test.ts
apps/ui/sources/__tests__/app/new/pick/path.test.ts
apps/ui/sources/__tests__/app/new/pick/profile-edit.headerButtons.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.secretRequirementNavigation.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.setOptionsLoop.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.stackOptionsStability.test.ts
apps/ui/sources/__tests__/app/new/pick/testHarness.ts
apps/ui/sources/__tests__/app/settings/profiles.nativeNavigation.test.ts
apps/ui/sources/__tests__/app/share/publicShareViewer.plaintext.test.tsx
apps/ui/sources/__tests__/config/appConfig.easDefaults.test.ts
apps/ui/sources/__tests__/config/fixtures/app.local.fixture.cjs
apps/ui/sources/__tests__/install/ensureNohoistPeerLinks.test.ts
apps/ui/sources/__tests__/install/resolveUiPostinstallTasks.test.ts
apps/ui/sources/__tests__/install/shouldRunPostinstall.test.ts
apps/ui/sources/__tests__/voice/settings/localDirectSection.unhandledRejection.test.tsx
apps/ui/sources/dev/abortControllerPolyfillStub.ts
apps/ui/sources/dev/appConfig.routerIgnore.spec.ts
apps/ui/sources/dev/babelConfigAliases.test.ts
apps/ui/sources/dev/expoAudioStub.ts
apps/ui/sources/dev/expoClipboardStub.ts
apps/ui/sources/dev/expoConstantsStub.ts
apps/ui/sources/dev/expoLinearGradientStub.ts
apps/ui/sources/dev/expoLocalizationStub.ts
apps/ui/sources/dev/expoModulesCoreStub.ts
apps/ui/sources/dev/expoNotificationsStub.ts
apps/ui/sources/dev/expoRouterStub.ts
apps/ui/sources/dev/expoSpeechRecognitionStub.ts
apps/ui/sources/dev/expoSpeechStub.ts
apps/ui/sources/dev/expoStub.ts
apps/ui/sources/dev/jsdom.d.ts
apps/ui/sources/dev/metro.config.fontfaceobserver.spec.ts
apps/ui/sources/dev/reactNativeDeviceInfoStub.ts
apps/ui/sources/dev/reactNativeGestureHandlerStub.ts
apps/ui/sources/dev/reactNativeInternalStub.ts
apps/ui/sources/dev/reactNativePurchasesStub.ts
apps/ui/sources/dev/reactNativePurchasesUiStub.ts
apps/ui/sources/dev/reactNativeStub.ts
apps/ui/sources/dev/reactNativeVirtualizedListsStub.ts
apps/ui/sources/dev/reactNativeWebviewStub.ts
apps/ui/sources/dev/rnEncryptionStub.ts
apps/ui/sources/dev/stackScreenInlineOptions.test.ts
apps/ui/sources/dev/testRunner.ts
apps/ui/sources/dev/testkit/rootLayoutTestkit.ts
apps/ui/sources/dev/unistylesStyleSheetImports.test.ts
apps/ui/sources/dev/vitestIntegrationConfig.test.ts
apps/ui/sources/dev/vitestRnShim.test.ts
apps/ui/sources/dev/vitestRnShim.ts
apps/ui/sources/dev/vitestSetup.ts
apps/ui/sources/hooks/session/files/useFileScmStageActions.integration.test.ts
apps/ui/sources/hooks/session/files/useFilesScmOperations.integration.test.ts
apps/ui/sources/hooks/session/files/useScmCommitHistory.integration.test.ts
apps/ui/sources/sync/__testdata__/trace_0.json
apps/ui/sources/sync/__testdata__/trace_1.json
apps/ui/sources/sync/__testdata__/trace_2.json
apps/ui/sources/sync/ops/__tests__/gitRepoHarness.initBareRemote.test.ts
apps/ui/sources/sync/ops/__tests__/gitRepoHarness.initRepo.test.ts
apps/ui/sources/sync/ops/__tests__/gitRepoHarness.ts
apps/ui/sources/sync/ops/__tests__/saplingRepoHarness.ts
apps/ui/sources/sync/ops/__tests__/sessionAbort.test.ts
apps/ui/sources/sync/ops/__tests__/sessionArchive.serverScope.test.ts
apps/ui/sources/sync/ops/__tests__/sessionDelete.serverScope.test.ts
apps/ui/sources/sync/ops/__tests__/sessionStop.serverScope.test.ts
apps/ui/sources/sync/ops/__tests__/sessionStop.test.ts
apps/ui/sources/sync/ops/__tests__/spawnSessionPayload.test.ts
apps/ui/sources/sync/ops/capabilities.serverScoped.integration.test.ts
apps/ui/sources/sync/ops/machines.serverScoped.integration.test.ts
apps/ui/sources/sync/ops/sessions.sapling.integration.test.ts
apps/ui/sources/sync/ops/sessions.scm.integration.test.ts
apps/ui/sources/sync/ops/sessions.serverScoped.integration.test.ts
apps/ui/vitest.config.ts
apps/ui/vitest.integration.config.ts
scripts/testing/featureTestGating.ts
```

### Unit — apps/cli (Vitest) (count: 733)

```text
apps/cli/.env.integration-test
apps/cli/bin/happier.mjs
apps/cli/package.json
apps/cli/scripts/__tests__/buildSharedDeps.test.ts
apps/cli/scripts/__tests__/bundleWorkspaceDeps.test.ts
apps/cli/scripts/__tests__/childProcessOptions.test.ts
apps/cli/scripts/__tests__/happierBinPreflightHoistedNodeModules.test.ts
apps/cli/scripts/__tests__/happierDependencyPreflight.test.ts
apps/cli/scripts/__tests__/publishBundledDependencies.test.ts
apps/cli/scripts/__tests__/ripgrep_launcher.test.ts
apps/cli/scripts/__tests__/vitestLaneSeparation.test.ts
apps/cli/scripts/buildOutputs.spawnHooks.test.ts
apps/cli/scripts/buildSharedDeps.mjs
apps/cli/scripts/bundleWorkspaceDeps.mjs
apps/cli/scripts/childProcessOptions.cjs
apps/cli/scripts/claude_version_utils.findClaudeInPath.win32.test.ts
apps/cli/scripts/claude_version_utils.test.ts
apps/cli/scripts/claude_version_utils.win32Reliability.test.ts
apps/cli/scripts/permission_hook_forwarder.cjs
apps/cli/scripts/ripgrep_launcher.cjs
apps/cli/scripts/rmDirSafe.test.ts
apps/cli/scripts/rmDist.test.ts
apps/cli/scripts/session_hook_forwarder.cjs
apps/cli/scripts/shims/git
apps/cli/scripts/tool-trace-extract.ts
apps/cli/scripts/tool-trace-fixtures-v1.ts
apps/cli/scripts/tool-trace-fixtures.v1.allowlist.txt
apps/cli/src/agent/acp/__tests__/AcpBackend.acpFs.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.authenticate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.configOptions.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.dispose.killsProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsEnabled.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsMethods.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.initDelay.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionDeniedCleanup.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionSeed.toolCallUpdateFallback.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.promptUsage.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.responseCompletionError.idle.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModels.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModes.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionUpdate.maxUpdates.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.stderrArtifacts.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.toolCallUpdate.kindInference.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.usageUpdate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.waitForResponseComplete.test.ts
apps/cli/src/agent/acp/__tests__/acpSpawn.test.ts
apps/cli/src/agent/acp/__tests__/createAcpFilteredStdoutReadable.multiline.test.ts
apps/cli/src/agent/acp/__tests__/killProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.capture.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.captureErrors.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.destroyedWrite.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.test.ts
apps/cli/src/agent/acp/__tests__/sessionUpdateHandlers.test.ts
apps/cli/src/agent/acp/bridge/__tests__/acpCommonHandlers.test.ts
apps/cli/src/agent/acp/bridge/__tests__/createAcpAgentMessageForwarder.test.ts
apps/cli/src/agent/acp/history/__tests__/acpReplayCapture.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplayHistory.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplaySidechain.test.ts
apps/cli/src/agent/acp/permissions/__tests__/permissionMapping.test.ts
apps/cli/src/agent/acp/permissions/__tests__/permissionRequest.test.ts
apps/cli/src/agent/acp/runtime/__tests__/abortAcpRuntimeTurnIfNeeded.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.configOptions.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.ensureBackend.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.historyImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.modelOutputStreaming.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.pendingPump.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.permissionRequestHook.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sessionModels.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sessionModes.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sidechainImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.thinkingState.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.tokenCountForwarding.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.traceMarkers.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.turnHooks.test.ts
apps/cli/src/agent/acp/runtime/createAcpRuntime.testkit.ts
apps/cli/src/agent/acp/updates/__tests__/content.test.ts
apps/cli/src/agent/acp/updates/__tests__/events.test.ts
apps/cli/src/agent/acp/updates/__tests__/messages.test.ts
apps/cli/src/agent/adapters/MessageAdapter.toolIsError.test.ts
apps/cli/src/agent/executionRuns/policy/ExecutionRunPolicy.test.ts
apps/cli/src/agent/executionRuns/profiles/delegate/DelegateProfile.test.ts
apps/cli/src/agent/executionRuns/profiles/plan/PlanProfile.test.ts
apps/cli/src/agent/executionRuns/profiles/review/ReviewProfile.test.ts
apps/cli/src/agent/executionRuns/runtime/ExecutionRunManager.runRegistry.test.ts
apps/cli/src/agent/executionRuns/runtime/ExecutionRunManager.test.ts
apps/cli/src/agent/executionRuns/runtime/createExecutionRunBackend.coderabbit.test.ts
apps/cli/src/agent/executionRuns/runtime/resumeBackendController.test.ts
apps/cli/src/agent/executionRuns/runtime/turnDelivery.test.ts
apps/cli/src/agent/localControl/__tests__/confirmDiscardBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/createLocalRemoteModeController.test.ts
apps/cli/src/agent/localControl/__tests__/discardPendingBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/discardQueuedAndPendingForLocalSwitch.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.startAtEndErrors.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.test.ts
apps/cli/src/agent/localControl/__tests__/launchGating.test.ts
apps/cli/src/agent/localControl/__tests__/switchRequestTarget.test.ts
apps/cli/src/agent/permissions/BasePermissionHandler.allowlist.test.ts
apps/cli/src/agent/permissions/BasePermissionHandler.pushNotifications.test.ts
apps/cli/src/agent/permissions/BasePermissionHandler.toolTrace.test.ts
apps/cli/src/agent/permissions/CodexLikePermissionHandler.metadataSync.test.ts
apps/cli/src/agent/permissions/CodexLikePermissionHandler.test.ts
apps/cli/src/agent/permissions/CodexLikePermissionHandler.toolTrace.test.ts
apps/cli/src/agent/permissions/ProviderEnforcedPermissionHandler.test.ts
apps/cli/src/agent/permissions/createProviderEnforcedPermissionHandler.test.ts
apps/cli/src/agent/permissions/permissionToolIdentifier.test.ts
apps/cli/src/agent/permissions/shellCommandAllowlist.test.ts
apps/cli/src/agent/reviews/engines/coderabbit/CodeRabbitReviewBackend.win32CmdShim.test.ts
apps/cli/src/agent/reviews/engines/coderabbit/buildCodeRabbitEnv.test.ts
apps/cli/src/agent/reviews/engines/coderabbit/readCodeRabbitReviewConfig.test.ts
apps/cli/src/agent/reviews/engines/coderabbit/runWithRateLimitRetries.test.ts
apps/cli/src/agent/reviews/registry/reviewEngineRegistry.test.ts
apps/cli/src/agent/runtime/acpConfigOptionOverrideSync.test.ts
apps/cli/src/agent/runtime/acpConfigOptionOverridesMetadata.test.ts
apps/cli/src/agent/runtime/acpSessionModeOverrideSync.test.ts
apps/cli/src/agent/runtime/createHappierMcpBridge.test.ts
apps/cli/src/agent/runtime/createPermissionModeQueueState.queueKey.test.ts
apps/cli/src/agent/runtime/createSessionMetadata.test.ts
apps/cli/src/agent/runtime/daemonInitialPrompt.test.ts
apps/cli/src/agent/runtime/initializeBackendApiContext.test.ts
apps/cli/src/agent/runtime/initializeBackendRunSession.test.ts
apps/cli/src/agent/runtime/mergeSessionMetadataForStartup.test.ts
apps/cli/src/agent/runtime/modeMessageQueue.test.ts
apps/cli/src/agent/runtime/modelOverridePrecedence.test.ts
apps/cli/src/agent/runtime/modelOverrideSync.test.ts
apps/cli/src/agent/runtime/monotonicUpdatedAt.test.ts
apps/cli/src/agent/runtime/permission/bindPermissionModeQueue.inFlightSteer.test.ts
apps/cli/src/agent/runtime/permission/bindPermissionModeQueue.test.ts
apps/cli/src/agent/runtime/permission/permissionModeCanonical.test.ts
apps/cli/src/agent/runtime/permission/permissionModeFromMetadata.test.ts
apps/cli/src/agent/runtime/permission/permissionModeFromUserMessage.test.ts
apps/cli/src/agent/runtime/permission/permissionModeMetadata.test.ts
apps/cli/src/agent/runtime/permission/permissionModeStateSync.test.ts
apps/cli/src/agent/runtime/permission/startupPermissionModeSeed.test.ts
apps/cli/src/agent/runtime/permissionIntentPrecedence.test.ts
apps/cli/src/agent/runtime/permissionModeForAgent.test.ts
apps/cli/src/agent/runtime/queueSpecialCommands.test.ts
apps/cli/src/agent/runtime/runPermissionModePromptLoop.test.ts
apps/cli/src/agent/runtime/runStandardAcpProvider.test.ts
apps/cli/src/agent/runtime/runnerTerminationHandlers.test.ts
apps/cli/src/agent/runtime/runtimeOverridesSynchronizer.test.ts
apps/cli/src/agent/runtime/sendReadyWithPushNotification.test.ts
apps/cli/src/agent/runtime/sessionAttach.test.ts
apps/cli/src/agent/runtime/sessionControlsPublishShared.test.ts
apps/cli/src/agent/runtime/signalForwarding.test.ts
apps/cli/src/agent/runtime/startup/DeferredApiSessionClient.test.ts
apps/cli/src/agent/runtime/startup/startupCoordinator.test.ts
apps/cli/src/agent/runtime/startup/startupTiming.test.ts
apps/cli/src/agent/runtime/startupMetadataUpdate.test.ts
apps/cli/src/agent/runtime/startupSideEffects.test.ts
apps/cli/src/agent/runtime/subprocessArtifacts.test.ts
apps/cli/src/agent/runtime/waitForMessagesOrPending.test.ts
apps/cli/src/agent/runtime/waitForNextPermissionModeMessage.test.ts
apps/cli/src/agent/tools/diff/turnDiffEmitter.test.ts
apps/cli/src/agent/tools/normalization/__fixtures__/tool-trace-fixtures.v1.json
apps/cli/src/agent/tools/normalization/canonicalizeToolNameV2.mapping.test.ts
apps/cli/src/agent/tools/normalization/families/diff.schema.test.ts
apps/cli/src/agent/tools/normalization/families/diff.test.ts
apps/cli/src/agent/tools/normalization/families/edit.test.ts
apps/cli/src/agent/tools/normalization/families/execute.kilo.test.ts
apps/cli/src/agent/tools/normalization/families/read.kilo.test.ts
apps/cli/src/agent/tools/normalization/families/search.kilo.test.ts
apps/cli/src/agent/tools/normalization/families/task.test.ts
apps/cli/src/agent/tools/normalization/families/write.test.ts
apps/cli/src/agent/tools/normalization/fixtures.v1.calls.test.ts
apps/cli/src/agent/tools/normalization/fixtures.v1.catalog.test.ts
apps/cli/src/agent/tools/normalization/fixtures.v1.results.test.ts
apps/cli/src/agent/tools/normalization/fixtures.v1.testkit.ts
apps/cli/src/agent/tools/normalization/index.test.ts
apps/cli/src/agent/tools/normalization/protocolSchemas.test.ts
apps/cli/src/agent/tools/trace/curateToolTraceFixtures.test.ts
apps/cli/src/agent/tools/trace/extractToolTraceFixtures.test.ts
apps/cli/src/agent/tools/trace/mergeToolTraceFixtures.test.ts
apps/cli/src/agent/tools/trace/resolveStackToolTraceDir.test.ts
apps/cli/src/agent/tools/trace/testEvents.testkit.test.ts
apps/cli/src/agent/tools/trace/testEvents.testkit.ts
apps/cli/src/agent/tools/trace/toolTrace.test.ts
apps/cli/src/agent/tools/trace/toolTrace.ts
apps/cli/src/agent/tools/trace/toolTraceFixturesAllowlist.test.ts
apps/cli/src/agent/transport/utils/jsonStdoutFilter.test.ts
apps/cli/src/agent/voice/agent/VoiceAgentManager.test.ts
apps/cli/src/agent/voice/agent/permissionPolicy.test.ts
apps/cli/src/agent/voice/agent/voiceAgentPrompts.test.ts
apps/cli/src/api/api.connectedServicesQuotasV3.test.ts
apps/cli/src/api/api.connectedServicesV2.test.ts
apps/cli/src/api/api.loopbackUrl.test.ts
apps/cli/src/api/api.plaintextSessionCreate.test.ts
apps/cli/src/api/api.sessionDataEncryptionKey.test.ts
apps/cli/src/api/api.test.ts
apps/cli/src/api/apiMachine.connectOrder.test.ts
apps/cli/src/api/apiMachine.loopbackUrl.test.ts
apps/cli/src/api/apiMachine.spawnSession.test.ts
apps/cli/src/api/apiMachine.transports.test.ts
apps/cli/src/api/apiMachine.v2ChangesReconnect.test.ts
apps/cli/src/api/changes.test.ts
apps/cli/src/api/client/encryptionKey.test.ts
apps/cli/src/api/client/loopbackUrl.test.ts
apps/cli/src/api/client/serializeAxiosErrorForLog.test.ts
apps/cli/src/api/encryption.bigint.test.ts
apps/cli/src/api/encryption.boxBundle.test.ts
apps/cli/src/api/encryption.libsodiumDecryptForSecretKey.test.ts
apps/cli/src/api/machine/ensureMachineRegistered.test.ts
apps/cli/src/api/machine/resolveMachineRpcWorkingDirectory.test.ts
apps/cli/src/api/machine/rpcHandlers.memory.deepSearch.test.ts
apps/cli/src/api/machine/rpcHandlers.memory.status.test.ts
apps/cli/src/api/machine/rpcHandlers.test.ts
apps/cli/src/api/offline/offlineSessionStub.test.ts
apps/cli/src/api/pushNotificationData.test.ts
apps/cli/src/api/pushNotifications.fetchPushTokens.test.ts
apps/cli/src/api/pushNotifications.sendToAllDevices.test.ts
apps/cli/src/api/pushTicketLogSummary.test.ts
apps/cli/src/api/queue/discardedCommittedMessageLocalIds.test.ts
apps/cli/src/api/rpc/RpcHandlerManager.test.ts
apps/cli/src/api/session/acpMessageEnvelope.test.ts
apps/cli/src/api/session/acpTokenCountUsage.test.ts
apps/cli/src/api/session/acpTokenCountUsageReport.test.ts
apps/cli/src/api/session/agentStateRecords.test.ts
apps/cli/src/api/session/fetchEncryptedTranscriptWindow.test.ts
apps/cli/src/api/session/sessionClient.echoToSender.test.ts
apps/cli/src/api/session/sessionMessageCatchUp.plain.test.ts
apps/cli/src/api/session/sessionStateUpdateHandling.test.ts
apps/cli/src/api/session/sessionWritesBestEffort.test.ts
apps/cli/src/api/session/snapshotSync.test.ts
apps/cli/src/api/session/sockets.loopbackUrl.test.ts
apps/cli/src/api/session/sockets.transports.test.ts
apps/cli/src/api/session/stateUpdates.plain.test.ts
apps/cli/src/api/session/toolTrace.acpTaskComplete.test.ts
apps/cli/src/api/session/transcriptMessageLookup.test.ts
apps/cli/src/api/session/transcriptQueries.plain.test.ts
apps/cli/src/api/session/transcriptRecoveryScheduler.test.ts
apps/cli/src/api/sessionClient.afterSeqCatchUp.test.ts
apps/cli/src/api/sessionClient.pendingQueue.test.ts
apps/cli/src/api/sessionClient.test.ts
apps/cli/src/api/sessionClient.toolTrace.test.ts
apps/cli/src/api/sessionClient.v2ChangesFeatureFlag.test.ts
apps/cli/src/api/testkit/sessionClientTestkit.ts
apps/cli/src/api/types.messageMeta.passthrough.test.ts
apps/cli/src/api/types.sessionMessageContent.test.ts
apps/cli/src/api/webAuth.test.ts
apps/cli/src/backends/auggie/acp/backend.permissions.test.ts
apps/cli/src/backends/auggie/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/auggie/acp/transport.test.ts
apps/cli/src/backends/auggie/utils/auggieSessionIdMetadata.test.ts
apps/cli/src/backends/auggie/utils/permissionHandler.test.ts
apps/cli/src/backends/catalog.test.ts
apps/cli/src/backends/claude/claudeLocal.test.ts
apps/cli/src/backends/claude/claudeLocalLauncher.agentTeamsEnv.test.ts
apps/cli/src/backends/claude/claudeRemote.test.ts
apps/cli/src/backends/claude/claudeRemoteLauncher.readyPushPolicy.test.ts
apps/cli/src/backends/claude/claudeUnhandledRejectionPolicy.test.ts
apps/cli/src/backends/claude/claude_version_utils.signalForwarding.test.ts
apps/cli/src/backends/claude/cli/command.help.test.ts
apps/cli/src/backends/claude/cli/command.settingsFlag.test.ts
apps/cli/src/backends/claude/cli/command.version.test.ts
apps/cli/src/backends/claude/daemon/spawnHooks.test.ts
apps/cli/src/backends/claude/localPermissions/localPermissionBridge.pushPolicy.test.ts
apps/cli/src/backends/claude/localPermissions/localPermissionBridge.test.ts
apps/cli/src/backends/claude/loop.agentTeamsEnv.test.ts
apps/cli/src/backends/claude/loop.test.ts
apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.checkpoints.test.ts
apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.optionsAndHooks.test.ts
apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.postResultStreaming.test.ts
apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.streamEvents.test.ts
apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.testkit.ts
apps/cli/src/backends/claude/remote/claudeRemoteDispatch.test.ts
apps/cli/src/backends/claude/remote/claudeRemoteMetaState.test.ts
apps/cli/src/backends/claude/remote/modeHash.test.ts
apps/cli/src/backends/claude/remote/resolveInitialClaudeRemoteMetaState.test.ts
apps/cli/src/backends/claude/remote/sdkFlagOverrides.test.ts
apps/cli/src/backends/claude/remote/sessionStartPlan.test.ts
apps/cli/src/backends/claude/remote/sidechains/claudeRemoteSubagentFileCollector.test.ts
apps/cli/src/backends/claude/remote/sidechains/claudeRemoteTaskOutputCollector.test.ts
apps/cli/src/backends/claude/remote/sidechains/claudeTaskOutputSidechainImporter.limits.test.ts
apps/cli/src/backends/claude/remote/sidechains/claudeTaskOutputSidechainImporter.test.ts
apps/cli/src/backends/claude/sdk/query.executableResolution.test.ts
apps/cli/src/backends/claude/sdk/query.exitHandling.test.ts
apps/cli/src/backends/claude/sdk/query.onMessageReceived.test.ts
apps/cli/src/backends/claude/sdk/query.signalCleanup.test.ts
apps/cli/src/backends/claude/sdk/query.stderrDrain.test.ts
apps/cli/src/backends/claude/sdk/utils.test.ts
apps/cli/src/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend.test.ts
apps/cli/src/backends/claude/session.keepAliveScheduling.test.ts
apps/cli/src/backends/claude/session.test.ts
apps/cli/src/backends/claude/startup/createClaudeStartupSpec.test.ts
apps/cli/src/backends/claude/terminationOutcome.test.ts
apps/cli/src/backends/claude/ui/RemoteModeDisplay.test.ts
apps/cli/src/backends/claude/utils/OutgoingMessageQueue.test.ts
apps/cli/src/backends/claude/utils/__fixtures__/0-say-lol-session.jsonl
apps/cli/src/backends/claude/utils/__fixtures__/1-continue-run-ls-tool.jsonl
apps/cli/src/backends/claude/utils/adoptModelOverrideFromMetadata.test.ts
apps/cli/src/backends/claude/utils/claudeCheckSession.test.ts
apps/cli/src/backends/claude/utils/claudeFindLastSession.test.ts
apps/cli/src/backends/claude/utils/claudeSettings.test.ts
apps/cli/src/backends/claude/utils/ensureSessionInfoBeforeSwitch.test.ts
apps/cli/src/backends/claude/utils/generateHookSettings.test.ts
apps/cli/src/backends/claude/utils/inferPermissionIntentFromArgs.test.ts
apps/cli/src/backends/claude/utils/mcpConfigMerge.test.ts
apps/cli/src/backends/claude/utils/parseRawJsonLines.test.ts
apps/cli/src/backends/claude/utils/participantRouting/formatClaudeTeamRoutedPrompt.test.ts
apps/cli/src/backends/claude/utils/participantRouting/parseParticipantMessageMeta.test.ts
apps/cli/src/backends/claude/utils/path.test.ts
apps/cli/src/backends/claude/utils/permissionHandler.askUserQuestion.test.ts
apps/cli/src/backends/claude/utils/permissionHandler.exitPlanMode.test.ts
apps/cli/src/backends/claude/utils/permissionHandler.lateResponse.test.ts
apps/cli/src/backends/claude/utils/permissionHandler.modeParameterPrecedence.test.ts
apps/cli/src/backends/claude/utils/permissionHandler.providedToolUseId.test.ts
apps/cli/src/backends/claude/utils/permissionHandler.pushPolicy.test.ts
apps/cli/src/backends/claude/utils/permissionHandler.taskOutputRewrite.test.ts
apps/cli/src/backends/claude/utils/permissionHandler.testkit.ts
apps/cli/src/backends/claude/utils/permissionHandler.toolTrace.test.ts
apps/cli/src/backends/claude/utils/permissionMode.test.ts
apps/cli/src/backends/claude/utils/permissionRpcRouting.test.ts
apps/cli/src/backends/claude/utils/remoteSystemPrompt.test.ts
apps/cli/src/backends/claude/utils/sdkToLogConverter.core.test.ts
apps/cli/src/backends/claude/utils/sdkToLogConverter.relationships.test.ts
apps/cli/src/backends/claude/utils/sdkToLogConverter.testkit.ts
apps/cli/src/backends/claude/utils/sdkToLogConverter.toolResults.test.ts
apps/cli/src/backends/claude/utils/sessionFixtures.testkit.ts
apps/cli/src/backends/claude/utils/sessionScanner.onMessageErrors.test.ts
apps/cli/src/backends/claude/utils/sessionScanner.test.ts
apps/cli/src/backends/claude/utils/startHookServer.permission.test.ts
apps/cli/src/backends/claude/utils/syncPermissionModeFromMetadata.test.ts
apps/cli/src/backends/claude/utils/systemPrompt.env.test.ts
apps/cli/src/backends/codex/__tests__/buildCodexMcpStartConfigForMessage.test.ts
apps/cli/src/backends/codex/__tests__/emitReadyIfIdle.test.ts
apps/cli/src/backends/codex/__tests__/extractCodexToolErrorText.test.ts
apps/cli/src/backends/codex/__tests__/extractMcpToolCallResultOutput.test.ts
apps/cli/src/backends/codex/__tests__/resolveCodexMessageModel.test.ts
apps/cli/src/backends/codex/__tests__/resumeSessionIdConsumption.test.ts
apps/cli/src/backends/codex/__tests__/rolloutToolNameMapping.test.ts
apps/cli/src/backends/codex/acp/backend.test.ts
apps/cli/src/backends/codex/acp/env.test.ts
apps/cli/src/backends/codex/acp/probeLoadSessionSupport.test.ts
apps/cli/src/backends/codex/acp/resolveCommand.test.ts
apps/cli/src/backends/codex/acp/syncSessionModeFromPermissionMode.test.ts
apps/cli/src/backends/codex/cli/command.test.ts
apps/cli/src/backends/codex/cli/extraCapabilities.installablesParity.test.ts
apps/cli/src/backends/codex/cloud/authenticate.exchange.test.ts
apps/cli/src/backends/codex/codexMcpClient.connectionRecovery.test.ts
apps/cli/src/backends/codex/codexMcpClient.test.ts
apps/cli/src/backends/codex/daemon/spawnHooks.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.lifecycle.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.test.ts
apps/cli/src/backends/codex/localControl/__tests__/createLocalControlSupportResolver.test.ts
apps/cli/src/backends/codex/localControl/__tests__/localControlSupport.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutDiscovery.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutMapper.test.ts
apps/cli/src/backends/codex/loop.test.ts
apps/cli/src/backends/codex/mcp/client.test.ts
apps/cli/src/backends/codex/registerHappierMcpBridgeTools.test.ts
apps/cli/src/backends/codex/resume/resolveCodexMcpServer.test.ts
apps/cli/src/backends/codex/resume/resolveMcpResumeServer.test.ts
apps/cli/src/backends/codex/resume/resumeResolve.testkit.test.ts
apps/cli/src/backends/codex/resume/resumeResolve.testkit.ts
apps/cli/src/backends/codex/resume/vendorResumeSupport.test.ts
apps/cli/src/backends/codex/runtime/localModePass.test.ts
apps/cli/src/backends/codex/runtime/mcpMessageHandler.test.ts
apps/cli/src/backends/codex/utils/applyPermissionModeToHandler.test.ts
apps/cli/src/backends/codex/utils/buildCodexMcpStartConfig.test.ts
apps/cli/src/backends/codex/utils/codexAcpLifecycle.test.ts
apps/cli/src/backends/codex/utils/codexSessionIdMetadata.test.ts
apps/cli/src/backends/codex/utils/createCodexPermissionHandler.test.ts
apps/cli/src/backends/codex/utils/diffProcessor.coalesce.test.ts
apps/cli/src/backends/codex/utils/formatCodexEventForUi.test.ts
apps/cli/src/backends/codex/utils/metadataOverridesWatcher.test.ts
apps/cli/src/backends/codex/utils/permissionHandler.test.ts
apps/cli/src/backends/codex/utils/permissionModePolicy.test.ts
apps/cli/src/backends/codex/utils/publishInFlightSteerCapability.test.ts
apps/cli/src/backends/codex/utils/resolveCodexStartingMode.test.ts
apps/cli/src/backends/codex/utils/shouldRestartOnModeBoundary.test.ts
apps/cli/src/backends/copilot/acp/backend.test.ts
apps/cli/src/backends/executionRuns/executionRunBackendRegistry.reviewEngines.test.ts
apps/cli/src/backends/executionRuns/permissionModeForExecutionRunPolicy.test.ts
apps/cli/src/backends/gemini/acp/backend.authMethod.test.ts
apps/cli/src/backends/gemini/acp/backend.permissions.test.ts
apps/cli/src/backends/gemini/acp/transport.test.ts
apps/cli/src/backends/gemini/cli/command.model.test.ts
apps/cli/src/backends/gemini/cloud/authenticate.exchange.test.ts
apps/cli/src/backends/gemini/daemon/spawnHooks.test.ts
apps/cli/src/backends/gemini/runtime/createGeminiBackendMessageHandler.reasoningAsThinking.test.ts
apps/cli/src/backends/gemini/runtime/ensureGeminiAcpSession.test.ts
apps/cli/src/backends/gemini/runtime/sendGeminiPromptWithRetry.test.ts
apps/cli/src/backends/gemini/utils/config.tokenInference.test.ts
apps/cli/src/backends/gemini/utils/diffProcessor.test.ts
apps/cli/src/backends/gemini/utils/formatGeminiErrorForUi.test.ts
apps/cli/src/backends/gemini/utils/geminiSessionIdMetadata.test.ts
apps/cli/src/backends/gemini/utils/permissionHandler.test.ts
apps/cli/src/backends/isolation/resolveBackendIsolationBundle.test.ts
apps/cli/src/backends/kilo/acp/backend.permissions.test.ts
apps/cli/src/backends/kilo/acp/backend.test.ts
apps/cli/src/backends/kilo/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/kilo/acp/transport.test.ts
apps/cli/src/backends/kilo/utils/kiloSessionIdMetadata.test.ts
apps/cli/src/backends/kilo/utils/permissionHandler.test.ts
apps/cli/src/backends/kimi/acp/backend.permissions.test.ts
apps/cli/src/backends/kimi/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/kimi/acp/runtime.reset.test.ts
apps/cli/src/backends/kimi/acp/runtime.testkit.ts
apps/cli/src/backends/kimi/acp/transport.test.ts
apps/cli/src/backends/kimi/utils/kimiSessionIdMetadata.test.ts
apps/cli/src/backends/kimi/utils/permissionHandler.test.ts
apps/cli/src/backends/opencode/acp/backend.permissions.test.ts
apps/cli/src/backends/opencode/acp/backend.test.ts
apps/cli/src/backends/opencode/acp/permissionRulesetCompat.test.ts
apps/cli/src/backends/opencode/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/opencode/acp/runtime.testkit.ts
apps/cli/src/backends/opencode/acp/transport.test.ts
apps/cli/src/backends/opencode/daemon/spawnHooks.test.ts
apps/cli/src/backends/opencode/runOpenCode.test.ts
apps/cli/src/backends/opencode/utils/opencodeSessionIdMetadata.test.ts
apps/cli/src/backends/opencode/utils/permissionHandler.test.ts
apps/cli/src/backends/opencode/utils/turnDiffAccumulator.test.ts
apps/cli/src/backends/pi/acp/backend.test.ts
apps/cli/src/backends/pi/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.authReloadContinue.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.ensureProcessRecovery.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.introspectionFailures.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.loadSession.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.promptFailure.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.waitForResponseComplete.test.ts
apps/cli/src/backends/pi/rpc/eventMapping.test.ts
apps/cli/src/backends/pi/utils/piSessionIdMetadata.test.ts
apps/cli/src/backends/qwen/acp/backend.permissions.test.ts
apps/cli/src/backends/qwen/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/qwen/acp/runtime.testkit.ts
apps/cli/src/backends/qwen/utils/permissionHandler.test.ts
apps/cli/src/backends/qwen/utils/qwenSessionIdMetadata.test.ts
apps/cli/src/capabilities/checklists.executionRuns.test.ts
apps/cli/src/capabilities/deps/codexAcp.win32NpmShim.test.ts
apps/cli/src/capabilities/deps/codexMcpResume.legacyInstallRemoval.test.ts
apps/cli/src/capabilities/deps/codexMcpResume.win32NpmShim.test.ts
apps/cli/src/capabilities/probes/acpCapabilitySnapshot.test.ts
apps/cli/src/capabilities/probes/acpProbe.cache.test.ts
apps/cli/src/capabilities/probes/acpProbe.spawnError.test.ts
apps/cli/src/capabilities/probes/agentModelsProbe.cache.test.ts
apps/cli/src/capabilities/probes/agentModelsProbe.staticOnly.test.ts
apps/cli/src/capabilities/probes/agentModelsProbe.testkit.ts
apps/cli/src/capabilities/registry/toolExecutionRuns.feat.execution.runs.test.ts
apps/cli/src/capabilities/snapshots/cliSnapshot.cache.test.ts
apps/cli/src/capabilities/snapshots/cliSnapshot.test.ts
apps/cli/src/capabilities/snapshots/cliSnapshot.win32CmdShim.test.ts
apps/cli/src/capabilities/utils/acpProbeTimeout.test.ts
apps/cli/src/capabilities/utils/normalizeCapabilityProbeError.test.ts
apps/cli/src/cli/commandRegistry.installSelfUpdate.test.ts
apps/cli/src/cli/commands/auth.logout.test.ts
apps/cli/src/cli/commands/auth/login.printConfigureLinks.test.ts
apps/cli/src/cli/commands/auth/status.json.test.ts
apps/cli/src/cli/commands/bugReport.test.ts
apps/cli/src/cli/commands/daemon.installAlias.test.ts
apps/cli/src/cli/commands/daemon.multiAll.test.ts
apps/cli/src/cli/commands/daemon.service.test.ts
apps/cli/src/cli/commands/daemon.serviceList.test.ts
apps/cli/src/cli/commands/daemon.startLogging.test.ts
apps/cli/src/cli/commands/doctor.json.test.ts
apps/cli/src/cli/commands/notify.test.ts
apps/cli/src/cli/commands/resume.test.ts
apps/cli/src/cli/commands/self.test.ts
apps/cli/src/cli/commands/server.addFlow.test.ts
apps/cli/src/cli/commands/server.json.test.ts
apps/cli/src/cli/commands/server.postAdd.test.ts
apps/cli/src/cli/commands/server.selfHealCapabilities.test.ts
apps/cli/src/cli/commands/session/actions/actions.test.ts
apps/cli/src/cli/commands/session/actions/json.contract.test.ts
apps/cli/src/cli/commands/session/jsonFailSafe.test.ts
apps/cli/src/cli/dispatch.tmuxDisallowed.test.ts
apps/cli/src/cli/parsers/specialCommands.test.ts
apps/cli/src/cli/permissionIntentParsing.test.ts
apps/cli/src/cli/permissionIntentResolution.test.ts
apps/cli/src/cli/permissionModeNormalization.test.ts
apps/cli/src/cli/runBackendSessionCliCommand.lock.test.ts
apps/cli/src/cli/runBackendSessionCliCommand.test.ts
apps/cli/src/cli/runtime/update/autoUpdateNotice.test.ts
apps/cli/src/cli/runtime/update/binarySelfUpdate.test.ts
apps/cli/src/cli/runtime/update/runtimeReexec.test.ts
apps/cli/src/cli/sessionStartArgs.test.ts
apps/cli/src/cloud/connectStatus.test.ts
apps/cli/src/cloud/loopbackOauthPkce.test.ts
apps/cli/src/cloud/loopbackPort.test.ts
apps/cli/src/cloud/oauthPkceWithPasteFallback.test.ts
apps/cli/src/cloud/parseOauthRedirectPaste.test.ts
apps/cli/src/cloud/pkce.test.ts
apps/cli/src/configuration.apiServerUrl.test.ts
apps/cli/src/configuration.daemonProcess.test.ts
apps/cli/src/configuration.memoryLimits.test.ts
apps/cli/src/configuration.serverSelection.localUrlSafety.test.ts
apps/cli/src/configuration.socketTransports.test.ts
apps/cli/src/configuration.webappFallback.test.ts
apps/cli/src/daemon/automation/automationBackoffPolicy.test.ts
apps/cli/src/daemon/automation/automationClaimClient.test.ts
apps/cli/src/daemon/automation/automationFeatureGate.feat.automations.test.ts
apps/cli/src/daemon/automation/automationScheduler.test.ts
apps/cli/src/daemon/automation/automationTemplateExecution.test.ts
apps/cli/src/daemon/automation/automationWorker.test.ts
apps/cli/src/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn.test.ts
apps/cli/src/daemon/connectedServices/materialize/normalizeMaterializationKeyForPath.test.ts
apps/cli/src/daemon/connectedServices/parseConnectedServicesBindings.test.ts
apps/cli/src/daemon/connectedServices/quotas/ConnectedServiceQuotasCoordinator.test.ts
apps/cli/src/daemon/connectedServices/quotas/fetchers/anthropicQuotaFetcher.test.ts
apps/cli/src/daemon/connectedServices/quotas/fetchers/openAiCodexQuotaFetcher.test.ts
apps/cli/src/daemon/connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions.test.ts
apps/cli/src/daemon/connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled.feat.connectedServices.quotas.test.ts
apps/cli/src/daemon/connectedServices/quotas/startConnectedServiceQuotasLoop.test.ts
apps/cli/src/daemon/connectedServices/refresh/ConnectedServiceRefreshCoordinator.test.ts
apps/cli/src/daemon/connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler.test.ts
apps/cli/src/daemon/connectedServices/refresh/serviceRefreshers.test.ts
apps/cli/src/daemon/connectedServices/resolveConnectedServiceAuthForSpawn.test.ts
apps/cli/src/daemon/connectedServices/resolveConnectedServiceCredentials.test.ts
apps/cli/src/daemon/connectedServices/shouldResolveConnectedServiceAuthForSpawn.test.ts
apps/cli/src/daemon/controlClient.httpErrors.test.ts
apps/cli/src/daemon/controlServer.spawnSession.test.ts
apps/cli/src/daemon/doctor.test.ts
apps/cli/src/daemon/ensureDaemon.startup.test.ts
apps/cli/src/daemon/ensureDaemonDecision.test.ts
apps/cli/src/daemon/executionBudget/ExecutionBudgetRegistry.test.ts
apps/cli/src/daemon/executionRunRegistry.test.ts
apps/cli/src/daemon/findRunningTrackedSessionById.test.ts
apps/cli/src/daemon/lifecycle/heartbeat.executionRunsGc.test.ts
apps/cli/src/daemon/lifecycle/heartbeat.processMissingDelegates.test.ts
apps/cli/src/daemon/lifecycle/heartbeat.selfRestart.test.ts
apps/cli/src/daemon/lifecycle/publishShutdownState.test.ts
apps/cli/src/daemon/lifecycle/singleFlightIntervalLoop.test.ts
apps/cli/src/daemon/memory/artifacts/buildMemoryArtifactLocalId.test.ts
apps/cli/src/daemon/memory/deepIndex/chunkTranscriptRows.test.ts
apps/cli/src/daemon/memory/deepIndex/deepIndexDb.test.ts
apps/cli/src/daemon/memory/deepIndex/embeddings/rerankHitsWithEmbeddings.test.ts
apps/cli/src/daemon/memory/deepIndex/syncDeepIndexForSessionsOnce.test.ts
apps/cli/src/daemon/memory/enforceMemoryDiskBudgets.test.ts
apps/cli/src/daemon/memory/getMemoryWindow.test.ts
apps/cli/src/daemon/memory/hints/buildMemoryHintsPrompt.test.ts
apps/cli/src/daemon/memory/hints/commitMemoryHintArtifacts.test.ts
apps/cli/src/daemon/memory/hints/generateMemoryHintsShard.test.ts
apps/cli/src/daemon/memory/hints/parseMemoryHintsOutput.test.ts
apps/cli/src/daemon/memory/hints/runMemoryHintsExecutionRun.test.ts
apps/cli/src/daemon/memory/ingestSummaryShardsFromDecryptedTranscriptRows.test.ts
apps/cli/src/daemon/memory/inventory/selectSessionsForBackfill.test.ts
apps/cli/src/daemon/memory/memoryWorker.test.ts
apps/cli/src/daemon/memory/searchMemory.embeddings.test.ts
apps/cli/src/daemon/memory/summaryShardIndexDb.test.ts
apps/cli/src/daemon/memory/syncMemoryHintsForSessionsOnce.test.ts
apps/cli/src/daemon/platform/windows/spawnHappyCliVisibleConsole.test.ts
apps/cli/src/daemon/platform/windows/visibleConsoleSpawn.test.ts
apps/cli/src/daemon/platform/windows/windowsSessionConsoleMode.test.ts
apps/cli/src/daemon/processSupervision/sessionRunnerRespawn.test.ts
apps/cli/src/daemon/reattach.respawnDescriptor.test.ts
apps/cli/src/daemon/service.darwin.test.ts
apps/cli/src/daemon/service.systemd.test.ts
apps/cli/src/daemon/service/cli.test.ts
apps/cli/src/daemon/service/cli.uidEnv.test.ts
apps/cli/src/daemon/service/commandExistsInPath.test.ts
apps/cli/src/daemon/serviceApply.test.ts
apps/cli/src/daemon/serviceInstaller.test.ts
apps/cli/src/daemon/serviceLifecyclePlan.test.ts
apps/cli/src/daemon/servicePlan.test.ts
apps/cli/src/daemon/sessionAttachFile.test.ts
apps/cli/src/daemon/sessionEncryption/resolveExistingSessionEncryptionKeyBase64.test.ts
apps/cli/src/daemon/sessionExitReport.test.ts
apps/cli/src/daemon/sessionRegistry.test.ts
apps/cli/src/daemon/sessionRunnerLock.test.ts
apps/cli/src/daemon/sessionSpawnArgs.test.ts
apps/cli/src/daemon/sessionTermination.test.ts
apps/cli/src/daemon/sessions/isSessionRunnerActive.test.ts
apps/cli/src/daemon/sessions/onChildExited.respawn.test.ts
apps/cli/src/daemon/sessions/onHappySessionWebhook.test.ts
apps/cli/src/daemon/sessions/reattachFromMarkers.test.ts
apps/cli/src/daemon/sessions/resolveSpawnWebhookResult.test.ts
apps/cli/src/daemon/sessions/stopSession.test.ts
apps/cli/src/daemon/sessions/visibleConsoleSpawnWaiter.test.ts
apps/cli/src/daemon/shutdownPolicy.test.ts
apps/cli/src/daemon/spawn/authEnvValidation.test.ts
apps/cli/src/daemon/spawn/buildSpawnChildProcessEnv.test.ts
apps/cli/src/daemon/spawn/createSpawnConcurrencyGate.test.ts
apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.connectedServices.test.ts
apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.explicitEnvKeys.test.ts
apps/cli/src/daemon/spawn/spawnRequestCoalescer.test.ts
apps/cli/src/daemon/spawn/waitForSessionWebhook.test.ts
apps/cli/src/daemon/startDaemon.sessionRunnerLockDedupe.test.ts
apps/cli/src/daemon/startDaemon.tmuxEnv.test.ts
apps/cli/src/daemon/startup/ensureDaemonPath.test.ts
apps/cli/src/daemon/startup/ensureSessionDirectory.test.ts
apps/cli/src/daemon/startup/waitForAuthConfig.test.ts
apps/cli/src/daemon/startup/waitForInitialCredentials.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
apps/cli/src/diagnostics/bugReportArtifacts.test.ts
apps/cli/src/diagnostics/bugReportCommandArgs.test.ts
apps/cli/src/diagnostics/bugReportFeatureClient.test.ts
apps/cli/src/diagnostics/httpClient.test.ts
apps/cli/src/features/featureDecisionInputs.test.ts
apps/cli/src/features/featureDecisionService.test.ts
apps/cli/src/integrations/caffeinate.test.ts
apps/cli/src/integrations/tmux/sessionSelector.test.ts
apps/cli/src/integrations/tmux/tmux.commandEnv.test.ts
apps/cli/src/integrations/tmux/tmux.commandTimeout.test.ts
apps/cli/src/integrations/tmux/tmux.socketPath.test.ts
apps/cli/src/integrations/tmux/tmux.spawnAndEnv.test.ts
apps/cli/src/integrations/tmux/tmux.spawnMock.testkit.ts
apps/cli/src/integrations/tmux/tmux.test.ts
apps/cli/src/integrations/watcher/startFileWatcher.test.ts
apps/cli/src/mcp/createHappierMcpServer.test.ts
apps/cli/src/mcp/happierMcpToolCatalog.test.ts
apps/cli/src/mcp/tools/actionSpecTools.test.ts
apps/cli/src/persistence.changesCursor.test.ts
apps/cli/src/persistence.daemonLock.test.ts
apps/cli/src/persistence.daemonState.test.ts
apps/cli/src/persistence.permissions.test.ts
apps/cli/src/persistence.readSettings.activeServerOverride.test.ts
apps/cli/src/persistence.schemaV6Migration.test.ts
apps/cli/src/persistence.serverProfiles.test.ts
apps/cli/src/rpc/handlers/attachmentsUpload.test.ts
apps/cli/src/rpc/handlers/capabilities.prewarm.test.ts
apps/cli/src/rpc/handlers/capabilities.probeModels.cwd.test.ts
apps/cli/src/rpc/handlers/capabilities.probeModes.cwd.test.ts
apps/cli/src/rpc/handlers/encryptedRpc.testkit.ts
apps/cli/src/rpc/handlers/ephemeralTasks.test.ts
apps/cli/src/rpc/handlers/executionRuns.feat.execution.runs.test.ts
apps/cli/src/rpc/handlers/fileSystem.pathResolution.test.ts
apps/cli/src/rpc/handlers/pathSecurity.test.ts
apps/cli/src/rpc/handlers/registerSessionHandlers.attachmentsUpload.test.ts
apps/cli/src/rpc/handlers/registerSessionHandlers.previewEnv.test.ts
apps/cli/src/rpc/handlers/sessionLogTail.test.ts
apps/cli/src/scm/backends/git/operations/readOperations.untrackedDiff.test.ts
apps/cli/src/scm/backends/git/remoteArgs.test.ts
apps/cli/src/scm/backends/git/remoteGuards.test.ts
apps/cli/src/scm/backends/git/statusParser.test.ts
apps/cli/src/scm/backends/sapling/diffStats.test.ts
apps/cli/src/scm/backends/sapling/remoteArgs.test.ts
apps/cli/src/scm/backends/sapling/remoteGuards.test.ts
apps/cli/src/scm/backends/sapling/repository.test.ts
apps/cli/src/scm/backends/sapling/statusParser.test.ts
apps/cli/src/scm/backends/shared/nonInteractiveEnv.test.ts
apps/cli/src/scm/registry.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.changeDiscard.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.diffRead.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.historyRevert.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.patchAndValidation.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteFlows.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteGuards.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteSetup.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.workingDirectoryTilde.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/scm/rpc/__tests__/testRpcHarness.ts
apps/cli/src/scm/rpc/dispatch.test.ts
apps/cli/src/scm/runtime.normalizeCommitRef.test.ts
apps/cli/src/scm/runtime.normalizeRepoRootPathspec.test.ts
apps/cli/src/scm/runtime.runScmCommand.test.ts
apps/cli/src/server/serverCapabilities.test.ts
apps/cli/src/server/serverProfiles.localUrlSafety.test.ts
apps/cli/src/server/serverProfiles.test.ts
apps/cli/src/server/serverSelection.test.ts
apps/cli/src/server/serverTest.test.ts
apps/cli/src/server/serverUrlClassification.test.ts
apps/cli/src/session/replay/decryptTranscriptRows.test.ts
apps/cli/src/session/replay/decryptTranscriptTextItems.test.ts
apps/cli/src/sessionControl/resolveSessionId.longPrefix.test.ts
apps/cli/src/sessionControl/sessionControlTimeouts.test.ts
apps/cli/src/sessionControl/sessionEncryptionContext.plaintext.test.ts
apps/cli/src/sessionControl/sessionSummary.test.ts
apps/cli/src/sessionControl/sessionsHttp.compat.test.ts
apps/cli/src/sessionControl/testFixtures.ts
apps/cli/src/settings/accountSettings/accountSettingsCache.test.ts
apps/cli/src/settings/accountSettings/bootstrapAccountSettingsContext.test.ts
apps/cli/src/settings/accountSettingsClient.test.ts
apps/cli/src/settings/actionsSettings.test.ts
apps/cli/src/settings/applyAccountSettingsToProcessEnv.test.ts
apps/cli/src/settings/backendEnabled.test.ts
apps/cli/src/settings/memorySettings.test.ts
apps/cli/src/settings/notifications/permissionRequestPush.test.ts
apps/cli/src/settings/notifications/permissionRequestPushNotifier.test.ts
apps/cli/src/settings/permissions/permissionModeSeed.test.ts
apps/cli/src/settings/providerSettings.test.ts
apps/cli/src/settings/providerSettingsRegistry.test.ts
apps/cli/src/subprocess/supervision/__tests__/backoff.test.ts
apps/cli/src/subprocess/supervision/__tests__/exitClassifier.test.ts
apps/cli/src/subprocess/supervision/__tests__/managedChildProcess.waitForTermination.test.ts
apps/cli/src/subprocess/supervision/__tests__/restartController.test.ts
apps/cli/src/subprocess/supervision/__tests__/supervisedProcess.unhandledRejection.test.ts
apps/cli/src/terminal/attachment/terminalAttachPlan.test.ts
apps/cli/src/terminal/attachment/terminalAttachmentInfo.test.ts
apps/cli/src/terminal/attachment/terminalFallbackMessage.test.ts
apps/cli/src/terminal/runtime/envVarSanitization.test.ts
apps/cli/src/terminal/runtime/terminalConfig.test.ts
apps/cli/src/terminal/runtime/terminalRuntimeFlags.test.ts
apps/cli/src/terminal/tmux/headlessTmuxArgs.test.ts
apps/cli/src/terminal/tmux/startHappyHeadlessInTmux.test.ts
apps/cli/src/test-setup.ts
apps/cli/src/testkit/backends/permissionHandler.ts
apps/cli/src/testkit/backends/sessionMetadata.ts
apps/cli/src/testkit/backends/transport.ts
apps/cli/src/testkit/env.testkit.ts
apps/cli/src/ui/auth.inkRawModeGuard.test.ts
apps/cli/src/ui/auth.nonInteractiveBoth.test.ts
apps/cli/src/ui/doctor.test.ts
apps/cli/src/ui/doctorSnapshot.test.ts
apps/cli/src/ui/formatErrorForUi.test.ts
apps/cli/src/ui/ink/cleanupStdinAfterInk.test.ts
apps/cli/src/ui/ink/messageBuffer.ts
apps/cli/src/ui/ink/nonBlockingStdout.test.ts
apps/cli/src/ui/ink/restoreStdinBestEffort.test.ts
apps/cli/src/ui/logger.test.ts
apps/cli/src/ui/messageFormatterInk.partial.test.ts
apps/cli/src/ui/openBrowser.test.ts
apps/cli/src/ui/qrcode.test.ts
apps/cli/src/ui/testkit/authNonInteractiveGlobals.testkit.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.test.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.testkit.ts
apps/cli/src/ui/tty/resolveHasTTY.test.ts
apps/cli/src/utils/PushableAsyncIterable.test.ts
apps/cli/src/utils/__tests__/runtime.test.ts
apps/cli/src/utils/__tests__/runtimeIntegration.test.ts
apps/cli/src/utils/collections/lru.test.ts
apps/cli/src/utils/deterministicJson.test.ts
apps/cli/src/utils/expandEnvVars.test.ts
apps/cli/src/utils/fs/writeJsonAtomic.test.ts
apps/cli/src/utils/hmac_sha512.test.ts
apps/cli/src/utils/platform/windows/ensureWindowsUtf8CodePage.test.ts
apps/cli/src/utils/processEnv/stripNestedSessionDetectionEnv.test.ts
apps/cli/src/utils/protocolBugReportsRuntimeImport.test.ts
apps/cli/src/utils/proxy/axiosProxy.test.ts
apps/cli/src/utils/proxy/noProxy.test.ts
apps/cli/src/utils/proxy/parseProxyUrl.test.ts
apps/cli/src/utils/proxy/resolveProxyForUrl.test.ts
apps/cli/src/utils/spawnHappyCLI.entrypointMissing.test.ts
apps/cli/src/utils/spawnHappyCLI.execPath.test.ts
apps/cli/src/utils/spawnHappyCLI.fallback.test.ts
apps/cli/src/utils/sync.test.ts
apps/cli/src/vitestSetup.ts
apps/cli/vitest.config.ts
apps/cli/vitest.integration.config.ts
apps/cli/vitest.slow.config.ts
packages/tests/suites/providers/claude.agentTeams.toolNames.realProbe.test.ts
scripts/testing/featureTestGating.ts
```

### Integration — apps/cli (Vitest) (count: 183)

```text
apps/cli/.env.integration-test
apps/cli/package.json
apps/cli/scripts/__tests__/buildSharedDeps.test.ts
apps/cli/scripts/__tests__/bundleWorkspaceDeps.test.ts
apps/cli/scripts/__tests__/childProcessOptions.test.ts
apps/cli/scripts/__tests__/happierBinPreflightHoistedNodeModules.test.ts
apps/cli/scripts/__tests__/happierDependencyPreflight.test.ts
apps/cli/scripts/__tests__/publishBundledDependencies.test.ts
apps/cli/scripts/__tests__/ripgrep_launcher.test.ts
apps/cli/scripts/__tests__/vitestLaneSeparation.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.acpFs.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.authenticate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.configOptions.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.dispose.killsProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsEnabled.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsMethods.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.initDelay.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionDeniedCleanup.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionSeed.toolCallUpdateFallback.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.promptUsage.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.responseCompletionError.idle.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModels.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModes.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionUpdate.maxUpdates.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.stderrArtifacts.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.toolCallUpdate.kindInference.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.usageUpdate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.waitForResponseComplete.test.ts
apps/cli/src/agent/acp/__tests__/acpSpawn.test.ts
apps/cli/src/agent/acp/__tests__/createAcpFilteredStdoutReadable.multiline.test.ts
apps/cli/src/agent/acp/__tests__/killProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.capture.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.captureErrors.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.destroyedWrite.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.test.ts
apps/cli/src/agent/acp/__tests__/sessionUpdateHandlers.test.ts
apps/cli/src/agent/acp/bridge/__tests__/acpCommonHandlers.test.ts
apps/cli/src/agent/acp/bridge/__tests__/createAcpAgentMessageForwarder.test.ts
apps/cli/src/agent/acp/history/__tests__/acpReplayCapture.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplayHistory.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplaySidechain.test.ts
apps/cli/src/agent/acp/permissions/__tests__/permissionMapping.test.ts
apps/cli/src/agent/acp/permissions/__tests__/permissionRequest.test.ts
apps/cli/src/agent/acp/runtime/__tests__/abortAcpRuntimeTurnIfNeeded.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.configOptions.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.ensureBackend.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.historyImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.modelOutputStreaming.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.pendingPump.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.permissionRequestHook.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sessionModels.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sessionModes.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sidechainImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.thinkingState.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.tokenCountForwarding.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.traceMarkers.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.turnHooks.test.ts
apps/cli/src/agent/acp/runtime/createAcpRuntime.testkit.ts
apps/cli/src/agent/acp/updates/__tests__/content.test.ts
apps/cli/src/agent/acp/updates/__tests__/events.test.ts
apps/cli/src/agent/acp/updates/__tests__/messages.test.ts
apps/cli/src/agent/localControl/__tests__/confirmDiscardBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/createLocalRemoteModeController.test.ts
apps/cli/src/agent/localControl/__tests__/discardPendingBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/discardQueuedAndPendingForLocalSwitch.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.startAtEndErrors.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.test.ts
apps/cli/src/agent/localControl/__tests__/launchGating.test.ts
apps/cli/src/agent/localControl/__tests__/switchRequestTarget.test.ts
apps/cli/src/api/offline/serverConnectionErrors.integration.test.ts
apps/cli/src/api/sessionClient.changesCursorIsolation.integration.test.ts
apps/cli/src/api/sessionClient.codexMissingToolMapping.integration.test.ts
apps/cli/src/api/sessionClient.pendingQueueV2.integration.test.ts
apps/cli/src/api/testkit/sessionClientTestkit.ts
apps/cli/src/backends/claude/claudeLocalLauncher.integration.test.ts
apps/cli/src/backends/claude/claudeRemoteLauncher.integration.test.ts
apps/cli/src/backends/claude/executionRuns/claudeSdkExecutionRunSidechain.integration.test.ts
apps/cli/src/backends/claude/runClaude.fastStart.integration.test.ts
apps/cli/src/backends/codex/__tests__/buildCodexMcpStartConfigForMessage.test.ts
apps/cli/src/backends/codex/__tests__/emitReadyIfIdle.test.ts
apps/cli/src/backends/codex/__tests__/extractCodexToolErrorText.test.ts
apps/cli/src/backends/codex/__tests__/extractMcpToolCallResultOutput.test.ts
apps/cli/src/backends/codex/__tests__/resolveCodexMessageModel.test.ts
apps/cli/src/backends/codex/__tests__/resumeSessionIdConsumption.test.ts
apps/cli/src/backends/codex/__tests__/rolloutToolNameMapping.test.ts
apps/cli/src/backends/codex/cli/capability.loadSession.e2e.test.ts
apps/cli/src/backends/codex/codexLocalLauncher.integration.test.ts
apps/cli/src/backends/codex/codexLocalLauncher.testkit.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.lifecycle.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.test.ts
apps/cli/src/backends/codex/localControl/__tests__/createLocalControlSupportResolver.test.ts
apps/cli/src/backends/codex/localControl/__tests__/localControlSupport.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutDiscovery.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutMapper.test.ts
apps/cli/src/backends/codex/localControl/createLocalControlSupportResolver.integration.test.ts
apps/cli/src/backends/codex/runCodex.acpResumePreflight.integration.test.ts
apps/cli/src/backends/codex/runCodex.fastStart.integration.test.ts
apps/cli/src/backends/kilo/cli/capability.loadSession.e2e.test.ts
apps/cli/src/backends/opencode/cli/capability.loadSession.e2e.test.ts
apps/cli/src/capabilities/probes/agentModelsProbe.integration.test.ts
apps/cli/src/cli/commands/auth.pairRemote.integration.test.ts
apps/cli/src/cli/commands/auth.pairing.integration.test.ts
apps/cli/src/cli/commands/resume.integration.test.ts
apps/cli/src/cli/commands/session/archive.integration.test.ts
apps/cli/src/cli/commands/session/create.integration.test.ts
apps/cli/src/cli/commands/session/create.plain.integration.test.ts
apps/cli/src/cli/commands/session/delegate/start.integration.test.ts
apps/cli/src/cli/commands/session/executionRunGet.integration.test.ts
apps/cli/src/cli/commands/session/history.integration.test.ts
apps/cli/src/cli/commands/session/list.integration.test.ts
apps/cli/src/cli/commands/session/plan/start.integration.test.ts
apps/cli/src/cli/commands/session/review/start.integration.test.ts
apps/cli/src/cli/commands/session/run/action.integration.test.ts
apps/cli/src/cli/commands/session/run/send.integration.test.ts
apps/cli/src/cli/commands/session/run/start.integration.test.ts
apps/cli/src/cli/commands/session/run/stop.integration.test.ts
apps/cli/src/cli/commands/session/run/stream.integration.test.ts
apps/cli/src/cli/commands/session/run/wait.integration.test.ts
apps/cli/src/cli/commands/session/runList.integration.test.ts
apps/cli/src/cli/commands/session/send.integration.test.ts
apps/cli/src/cli/commands/session/send.plain.integration.test.ts
apps/cli/src/cli/commands/session/setModel.integration.test.ts
apps/cli/src/cli/commands/session/setPermissionMode.integration.test.ts
apps/cli/src/cli/commands/session/setTitle.integration.test.ts
apps/cli/src/cli/commands/session/status.integration.test.ts
apps/cli/src/cli/commands/session/stop.integration.test.ts
apps/cli/src/cli/commands/session/voiceAgent/start.feat.voice.agent.integration.test.ts
apps/cli/src/cli/commands/session/wait.integration.test.ts
apps/cli/src/daemon/automation/automationWorker.feat.automations.integration.test.ts
apps/cli/src/daemon/controlClient.pidSafety.integration.test.ts
apps/cli/src/daemon/daemon.integration.test.ts
apps/cli/src/daemon/multiDaemon.integration.test.ts
apps/cli/src/daemon/pidSafety.real.integration.test.ts
apps/cli/src/daemon/reattach.real.integration.test.ts
apps/cli/src/daemon/startDaemon.automation.integration.test.ts
apps/cli/src/daemon/startDaemon.noninteractiveAuth.integration.test.ts
apps/cli/src/daemon/startDaemon.tmuxSpawn.integration.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
apps/cli/src/integrations/difftastic/index.integration.test.ts
apps/cli/src/integrations/ripgrep/index.integration.test.ts
apps/cli/src/integrations/tmux/tmux.real.integration.test.ts
apps/cli/src/mcp/startHappyServer.integration.test.ts
apps/cli/src/rpc/handlers/registerSessionHandlers.capabilities.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.changeDiscard.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.diffRead.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.historyRevert.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.patchAndValidation.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteFlows.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteGuards.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteSetup.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.workingDirectoryTilde.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/scm/rpc/__tests__/testRpcHarness.ts
apps/cli/src/session/replay/hydrateReplayDialogFromTranscript.integration.test.ts
apps/cli/src/subprocess/supervision/__tests__/backoff.test.ts
apps/cli/src/subprocess/supervision/__tests__/exitClassifier.test.ts
apps/cli/src/subprocess/supervision/__tests__/managedChildProcess.waitForTermination.test.ts
apps/cli/src/subprocess/supervision/__tests__/restartController.test.ts
apps/cli/src/subprocess/supervision/__tests__/supervisedProcess.unhandledRejection.test.ts
apps/cli/src/test-setup.ts
apps/cli/src/testkit/backends/permissionHandler.ts
apps/cli/src/testkit/backends/sessionMetadata.ts
apps/cli/src/testkit/backends/transport.ts
apps/cli/src/testkit/env.testkit.ts
apps/cli/src/ui/auth.legacyServerFallback.integration.test.ts
apps/cli/src/ui/auth.noninteractive.claim.integration.test.ts
apps/cli/src/ui/testkit/authNonInteractiveGlobals.testkit.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.test.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.testkit.ts
apps/cli/src/utils/__tests__/runtime.test.ts
apps/cli/src/utils/__tests__/runtimeIntegration.test.ts
apps/cli/src/utils/spawnHappyCLI.invocation.integration.test.ts
apps/cli/src/utils/spawnHappyCLI.ts
apps/cli/src/vitestSetup.ts
apps/cli/vitest.integration.config.ts
packages/tests/suites/ui-e2e/session.sourceControl.reviewScroll.spec.ts
packages/tests/suites/ui-e2e/session.transcript.catchup.reconnect.spec.ts
packages/tests/suites/ui-e2e/session.transcript.catchup.smallReconnect.spec.ts
scripts/testing/featureTestGating.ts
```

### Slow — apps/cli (Vitest) (count: 120)

```text
apps/cli/.env.integration-test
apps/cli/package.json
apps/cli/scripts/__tests__/buildSharedDeps.test.ts
apps/cli/scripts/__tests__/bundleWorkspaceDeps.test.ts
apps/cli/scripts/__tests__/childProcessOptions.test.ts
apps/cli/scripts/__tests__/happierBinPreflightHoistedNodeModules.test.ts
apps/cli/scripts/__tests__/happierDependencyPreflight.test.ts
apps/cli/scripts/__tests__/publishBundledDependencies.test.ts
apps/cli/scripts/__tests__/ripgrep_launcher.test.ts
apps/cli/scripts/__tests__/vitestLaneSeparation.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.acpFs.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.authenticate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.configOptions.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.dispose.killsProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsEnabled.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsMethods.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.initDelay.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionDeniedCleanup.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionSeed.toolCallUpdateFallback.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.promptUsage.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.responseCompletionError.idle.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModels.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModes.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionUpdate.maxUpdates.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.stderrArtifacts.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.toolCallUpdate.kindInference.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.usageUpdate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.waitForResponseComplete.test.ts
apps/cli/src/agent/acp/__tests__/acpSpawn.test.ts
apps/cli/src/agent/acp/__tests__/createAcpFilteredStdoutReadable.multiline.test.ts
apps/cli/src/agent/acp/__tests__/killProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.capture.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.captureErrors.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.destroyedWrite.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.test.ts
apps/cli/src/agent/acp/__tests__/sessionUpdateHandlers.test.ts
apps/cli/src/agent/acp/bridge/__tests__/acpCommonHandlers.test.ts
apps/cli/src/agent/acp/bridge/__tests__/createAcpAgentMessageForwarder.test.ts
apps/cli/src/agent/acp/history/__tests__/acpReplayCapture.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplayHistory.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplaySidechain.test.ts
apps/cli/src/agent/acp/permissions/__tests__/permissionMapping.test.ts
apps/cli/src/agent/acp/permissions/__tests__/permissionRequest.test.ts
apps/cli/src/agent/acp/runtime/__tests__/abortAcpRuntimeTurnIfNeeded.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.configOptions.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.ensureBackend.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.historyImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.modelOutputStreaming.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.pendingPump.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.permissionRequestHook.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sessionModels.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sessionModes.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sidechainImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.thinkingState.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.tokenCountForwarding.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.traceMarkers.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.turnHooks.test.ts
apps/cli/src/agent/acp/updates/__tests__/content.test.ts
apps/cli/src/agent/acp/updates/__tests__/events.test.ts
apps/cli/src/agent/acp/updates/__tests__/messages.test.ts
apps/cli/src/agent/localControl/__tests__/confirmDiscardBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/createLocalRemoteModeController.test.ts
apps/cli/src/agent/localControl/__tests__/discardPendingBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/discardQueuedAndPendingForLocalSwitch.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.startAtEndErrors.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.test.ts
apps/cli/src/agent/localControl/__tests__/launchGating.test.ts
apps/cli/src/agent/localControl/__tests__/switchRequestTarget.test.ts
apps/cli/src/api/sessionClient.longOfflineReconnect.slow.test.ts
apps/cli/src/api/testkit/sessionClientTestkit.ts
apps/cli/src/backends/codex/__tests__/buildCodexMcpStartConfigForMessage.test.ts
apps/cli/src/backends/codex/__tests__/emitReadyIfIdle.test.ts
apps/cli/src/backends/codex/__tests__/extractCodexToolErrorText.test.ts
apps/cli/src/backends/codex/__tests__/extractMcpToolCallResultOutput.test.ts
apps/cli/src/backends/codex/__tests__/resolveCodexMessageModel.test.ts
apps/cli/src/backends/codex/__tests__/resumeSessionIdConsumption.test.ts
apps/cli/src/backends/codex/__tests__/rolloutToolNameMapping.test.ts
apps/cli/src/backends/codex/acp/runtime.permissionMode.slow.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.lifecycle.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.test.ts
apps/cli/src/backends/codex/localControl/__tests__/createLocalControlSupportResolver.test.ts
apps/cli/src/backends/codex/localControl/__tests__/localControlSupport.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutDiscovery.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutMapper.test.ts
apps/cli/src/cli/commands/auth.methodFlag.slow.test.ts
apps/cli/src/cli/runtime/update/runtimeReexec.wiring.slow.test.ts
apps/cli/src/daemon/daemon.spawnStop.stress.slow.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.changeDiscard.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.diffRead.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.historyRevert.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.patchAndValidation.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteFlows.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteGuards.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteSetup.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.workingDirectoryTilde.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/scm/rpc/__tests__/testRpcHarness.ts
apps/cli/src/subprocess/supervision/__tests__/backoff.test.ts
apps/cli/src/subprocess/supervision/__tests__/exitClassifier.test.ts
apps/cli/src/subprocess/supervision/__tests__/managedChildProcess.waitForTermination.test.ts
apps/cli/src/subprocess/supervision/__tests__/restartController.test.ts
apps/cli/src/subprocess/supervision/__tests__/supervisedProcess.unhandledRejection.test.ts
apps/cli/src/test-setup.ts
apps/cli/src/testkit/backends/permissionHandler.ts
apps/cli/src/testkit/backends/sessionMetadata.ts
apps/cli/src/testkit/backends/transport.ts
apps/cli/src/testkit/env.testkit.ts
apps/cli/src/ui/testkit/authNonInteractiveGlobals.testkit.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.test.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.testkit.ts
apps/cli/src/utils/__tests__/runtime.test.ts
apps/cli/src/utils/__tests__/runtimeIntegration.test.ts
apps/cli/src/vitestSetup.ts
apps/cli/vitest.slow.config.ts
scripts/testing/featureTestGating.ts
```

### Unit — apps/server (Vitest) (count: 165)

```text
apps/server/package.json
apps/server/scripts/dev.fullArgs.spec.ts
apps/server/scripts/dev.lightPlan.spec.ts
apps/server/scripts/generateClients.spec.ts
apps/server/scripts/migrate.light.deployPlan.spec.ts
apps/server/scripts/migrationsConsistency.spec.ts
apps/server/scripts/mysqlBaselineMigration.spec.ts
apps/server/scripts/run-server.sh.test.ts
apps/server/scripts/schemaSync.spec.ts
apps/server/sources/app/api/api.listenHost.spec.ts
apps/server/sources/app/api/routes/accessKeys/accessKeysRoutes.put.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/artifacts/artifactsRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/auth/registerPairingAuthRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/automations/automationRoutes.feat.automations.spec.ts
apps/server/sources/app/api/routes/changes/changesRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/changes/changesRoutes.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oauthExternal.rateLimit.feat.connectedServices.spec.ts
apps/server/sources/app/api/routes/connect/connectedServicesV2/exchangeConnectedServiceOauthTokens.test.ts
apps/server/sources/app/api/routes/connect/oauthExternal/createExternalAuthorizeUrl.spec.ts
apps/server/sources/app/api/routes/dev/devRoutes.spec.ts
apps/server/sources/app/api/routes/diagnostics/bugReportDiagnosticsRoutes.spec.ts
apps/server/sources/app/api/routes/features/featuresRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/feed/feedRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/kv/kvRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/pendingRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.listing.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.messages.afterSeq.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.messages.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.messagesByLocalId.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.testkit.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v1sessions.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2archive.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2archivedSessions.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2messages.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2patch.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2sessionById.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2sessions.spec.ts
apps/server/sources/app/api/routes/share/publicShareRoutes.optionalAuth.spec.ts
apps/server/sources/app/api/routes/share/shareRoutes.changes.spec.ts
apps/server/sources/app/api/routes/share/shareRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/version/versionRoutes.get.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.complete.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.rateLimit.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.secure.spec.ts
apps/server/sources/app/api/socket/sessionUpdateHandler.spec.ts
apps/server/sources/app/api/socketRooms.spec.ts
apps/server/sources/app/api/testkit/appLifecycle.ts
apps/server/sources/app/api/testkit/env.ts
apps/server/sources/app/api/testkit/oidcStub.ts
apps/server/sources/app/api/testkit/routeHarness.spec.ts
apps/server/sources/app/api/testkit/routeHarness.ts
apps/server/sources/app/api/testkit/socketHarness.ts
apps/server/sources/app/api/testkit/sqliteFastify.ts
apps/server/sources/app/api/testkit/txHarness.ts
apps/server/sources/app/api/uiConfig.spec.ts
apps/server/sources/app/api/utils/apiRateLimitCatalog.spec.ts
apps/server/sources/app/api/utils/apiRateLimitPolicy.spec.ts
apps/server/sources/app/api/utils/enableAuthentication.spec.ts
apps/server/sources/app/api/utils/enableAuthentication.ts
apps/server/sources/app/api/utils/enableErrorHandlers.sentry.spec.ts
apps/server/sources/app/api/utils/enableErrorHandlers.spec.ts
apps/server/sources/app/api/utils/enableServeUi.spec.ts
apps/server/sources/app/artifacts/artifactWriteService.spec.ts
apps/server/sources/app/auth/auth.oauthState.fallback.spec.ts
apps/server/sources/app/auth/auth.oauthState.spec.ts
apps/server/sources/app/auth/auth.persistentSeedCompatibility.spec.ts
apps/server/sources/app/auth/auth.tokenCache.spec.ts
apps/server/sources/app/auth/authPolicy.interval.spec.ts
apps/server/sources/app/auth/authPolicy.offboardingEnabled.spec.ts
apps/server/sources/app/auth/authPolicy.offboardingMode.spec.ts
apps/server/sources/app/auth/keyless/resolveKeylessAutoProvisionEligibility.test.ts
apps/server/sources/app/auth/protocol.authErrors.spec.ts
apps/server/sources/app/auth/providers/github/socialProfile.spec.ts
apps/server/sources/app/auth/providers/identityProviders/registry.spec.ts
apps/server/sources/app/auth/providers/mtls/mtlsIdentity.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcProviderConfig.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcProviderModuleFactory.spec.ts
apps/server/sources/app/automations/automationAssignmentService.test.ts
apps/server/sources/app/automations/automationClaimService.test.ts
apps/server/sources/app/automations/automationRunQueueService.test.ts
apps/server/sources/app/automations/automationSchedulingService.test.ts
apps/server/sources/app/automations/automationSummaryService.test.ts
apps/server/sources/app/automations/automationValidation.feat.automations.test.ts
apps/server/sources/app/changes/accountChangeCleanup.spec.ts
apps/server/sources/app/changes/markAccountChanged.spec.ts
apps/server/sources/app/events/eventRouter.protocol.spec.ts
apps/server/sources/app/events/eventRouter.rooms.spec.ts
apps/server/sources/app/events/sharingEvents.spec.ts
apps/server/sources/app/features/attachmentsUploadsFeature.feat.attachments.uploads.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.methods.connectAction.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.methods.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.mtls.autoRedirect.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.oauthKeyless.autoRedirect.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.ui.recoveryKeyReminder.spec.ts
apps/server/sources/app/features/automationsFeature.feat.automations.spec.ts
apps/server/sources/app/features/bugReportsFeature.feat.bugReports.spec.ts
apps/server/sources/app/features/catalog/readFeatureEnv.test.ts
apps/server/sources/app/features/catalog/resolveServerFeaturePayload.spec.ts
apps/server/sources/app/features/catalog/serverFeatureGate.spec.ts
apps/server/sources/app/features/connectedServicesFeature.feat.connectedServices.spec.ts
apps/server/sources/app/features/e2ee/resolveKeylessAccountsEnabled.test.ts
apps/server/sources/app/features/friendsFeature.feat.social.friends.spec.ts
apps/server/sources/app/features/serverFeatureRegistry.test.ts
apps/server/sources/app/features/updatesFeature.feat.updates.ota.spec.ts
apps/server/sources/app/features/voiceFeature.feat.voice.spec.ts
apps/server/sources/app/feed/feedPost.changes.spec.ts
apps/server/sources/app/integrations/tailscale/tailscaleServePublicUrlInference.test.ts
apps/server/sources/app/integrations/tailscale/tailscaleServeStatusParse.test.ts
apps/server/sources/app/kv/kvMutate.changes.spec.ts
apps/server/sources/app/monitoring/sentry.spec.ts
apps/server/sources/app/oauth/pkce.spec.ts
apps/server/sources/app/oauth/providers/github.timeout.spec.ts
apps/server/sources/app/oauth/providers/oidc/oidcDiscovery.timeout.spec.ts
apps/server/sources/app/oauth/providers/oidc/oidcOAuthProvider.spec.ts
apps/server/sources/app/oauth/providers/registry.spec.ts
apps/server/sources/app/presence/presenceBatcher.spec.ts
apps/server/sources/app/presence/presenceMode.spec.ts
apps/server/sources/app/presence/presenceRecorder.spec.ts
apps/server/sources/app/presence/presenceRedisQueue.worker.spec.ts
apps/server/sources/app/presence/sessionCache.machinePresence.spec.ts
apps/server/sources/app/presence/sessionCache.sessionPresence.spec.ts
apps/server/sources/app/presence/timeout.spec.ts
apps/server/sources/app/session/messageContent/normalizeIncomingSessionMessageContent.spec.ts
apps/server/sources/app/session/pending/pendingMessageService.spec.ts
apps/server/sources/app/session/sessionDelete.changes.spec.ts
apps/server/sources/app/session/sessionWriteService.spec.ts
apps/server/sources/app/share/accessControl.spec.ts
apps/server/sources/app/share/accessLogger.spec.ts
apps/server/sources/app/share/sessionParticipants.spec.ts
apps/server/sources/app/social/friendAdd.misconfig.spec.ts
apps/server/sources/app/social/friendNotification.spec.ts
apps/server/sources/app/social/friends.changes.spec.ts
apps/server/sources/app/social/friendsPolicy.spec.ts
apps/server/sources/app/social/socialTestHarness.ts
apps/server/sources/app/social/usernamePolicy.spec.ts
apps/server/sources/app/social/usernameUpdate.changes.spec.ts
apps/server/sources/app/voice/voiceSessionLeaseCleanup.spec.ts
apps/server/sources/config/backends.spec.ts
apps/server/sources/config/env.spec.ts
apps/server/sources/flavors/light/env.spec.ts
apps/server/sources/flavors/light/files.spec.ts
apps/server/sources/flavors/light/sqliteMigrations.spec.ts
apps/server/sources/startServer.role.spec.ts
apps/server/sources/storage/blob/files.spec.ts
apps/server/sources/storage/blob/processImage.spec.ts
apps/server/sources/storage/inTx.spec.ts
apps/server/sources/storage/locks/pgliteLock.spec.ts
apps/server/sources/storage/prisma.generatedClients.spec.ts
apps/server/sources/storage/prisma.spec.ts
apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.ts
apps/server/sources/testkit/startServerMocks.ts
apps/server/sources/utils/collections/lru.spec.ts
apps/server/sources/utils/logging/log.transportTargets.spec.ts
apps/server/sources/utils/network/urlSafety.spec.ts
apps/server/sources/utils/process/processHandlers.spec.ts
apps/server/sources/utils/process/shutdown.spec.ts
apps/server/sources/utils/runtime/delay.spec.ts
apps/server/sources/utils/runtime/forever.backoffAbort.spec.ts
apps/server/sources/utils/strings/separateName.spec.ts
apps/server/sources/voice/elevenLabsEnv.spec.ts
apps/server/vitest.config.ts
scripts/testing/featureTestGating.ts
```

### Integration — apps/server (Vitest) (count: 94)

```text
apps/server/package.json
apps/server/sources/app/api/routes/account/accountRoutes.changes.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.encryption.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.encryption.keylessRejectE2ee.feat.e2ee.keylessAccounts.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.encryption.migrate.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.identityVisibility.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.profile.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.settingsV2.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.v2usage.integration.spec.ts
apps/server/sources/app/api/routes/account/accountUsername.feat.social.friends.integration.spec.ts
apps/server/sources/app/api/routes/artifacts/artifactsRoutes.changes.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.accountAuth.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.mtls.feat.auth.mtls.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.pairingAuth.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.policy.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.terminalAuth.integration.spec.ts
apps/server/sources/app/api/routes/automations/automationDaemonRoutes.feat.automations.integration.spec.ts
apps/server/sources/app/api/routes/changes/changesRoutes.automation.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV2.feat.connectedServices.quotas.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV3.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV2.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV3.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthCallback.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.keyless.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthParams.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubCallback.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubCallback.oauthStateAuthFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubUsernameFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcAllowlist.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcAuthFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcRefreshToken.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcUserInfo.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.vendorTokenDelete.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.vendorTokens.presence.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/features/featuresRoutes.integration.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.changes.integration.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.claimExisting.integration.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.revoke.integration.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.updateExisting.integration.spec.ts
apps/server/sources/app/api/routes/push/pushRoutes.clientServerUrl.integration.spec.ts
apps/server/sources/app/api/routes/session/pendingRoutes.delete.integration.spec.ts
apps/server/sources/app/api/routes/session/pendingRoutes.enqueue.integration.spec.ts
apps/server/sources/app/api/routes/session/pendingRoutes.materialize.integration.spec.ts
apps/server/sources/app/api/routes/share/publicShareRoutes.changes.integration.spec.ts
apps/server/sources/app/api/routes/share/publicShareRoutes.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/user/friendsGithubGate.feat.social.friends.integration.spec.ts
apps/server/sources/app/api/routes/user/userRoutes.badges.integration.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.integration.spec.ts
apps/server/sources/app/api/socket.authPolicy.integration.spec.ts
apps/server/sources/app/api/socket.env.testHelper.ts
apps/server/sources/app/api/socket.redisAdapter.integration.spec.ts
apps/server/sources/app/api/socket/artifactUpdateHandler.changes.integration.spec.ts
apps/server/sources/app/api/socket/machineUpdateHandler.changes.integration.spec.ts
apps/server/sources/app/api/socket/rpcHandler.integration.spec.ts
apps/server/sources/app/api/socket/sessionUpdateHandler.changes.integration.spec.ts
apps/server/sources/app/api/socket/sessionUpdateHandler.sessionState.changes.integration.spec.ts
apps/server/sources/app/api/socket/sessionUpdateHandler.versionMismatch.integration.spec.ts
apps/server/sources/app/api/testkit/appLifecycle.ts
apps/server/sources/app/api/testkit/env.ts
apps/server/sources/app/api/testkit/oidcStub.ts
apps/server/sources/app/api/testkit/routeHarness.spec.ts
apps/server/sources/app/api/testkit/routeHarness.ts
apps/server/sources/app/api/testkit/socketHarness.ts
apps/server/sources/app/api/testkit/sqliteFastify.ts
apps/server/sources/app/api/testkit/txHarness.ts
apps/server/sources/app/api/utils/enableAuthentication.authPolicy.integration.spec.ts
apps/server/sources/app/api/utils/enableMonitoring.integration.spec.ts
apps/server/sources/app/api/utils/logRedaction.integration.spec.ts
apps/server/sources/app/auth/auth.oauthState.ttl.integration.spec.ts
apps/server/sources/app/auth/enforceLoginEligibility.accountDisabled.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubConnect.changes.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubConnect.identityCollision.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubConnect.tokenStorage.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubDisconnect.changes.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubLoginEligibility.upstreamFailure.integration.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcIdentityProvider.connect.integration.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcOffboardingRefresh.integration.spec.ts
apps/server/sources/app/automations/automationClaimService.integration.spec.ts
apps/server/sources/app/automations/automationCrudService.integration.spec.ts
apps/server/sources/app/automations/automationRunService.integration.spec.ts
apps/server/sources/app/events/eventRouter.sessionRoomIsolation.integration.spec.ts
apps/server/sources/app/presence/presenceRedisQueue.integration.spec.ts
apps/server/sources/app/session/pending/pendingMessageService.sharedSession.integration.spec.ts
apps/server/sources/startServer.dbProvider.integration.spec.ts
apps/server/sources/startServer.lightShutdownOrder.integration.spec.ts
apps/server/sources/startServer.redisOptional.integration.spec.ts
apps/server/sources/startServer.voiceLeaseCleanup.integration.spec.ts
apps/server/sources/storage/prisma.pglite.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.ts
apps/server/sources/testkit/startServerMocks.ts
apps/server/vitest.integration.config.ts
scripts/testing/featureTestGating.ts
```

### DB Contract — apps/server (Vitest) (count: 15)

```text
apps/server/package.json
apps/server/sources/app/api/testkit/appLifecycle.ts
apps/server/sources/app/api/testkit/env.ts
apps/server/sources/app/api/testkit/oidcStub.ts
apps/server/sources/app/api/testkit/routeHarness.spec.ts
apps/server/sources/app/api/testkit/routeHarness.ts
apps/server/sources/app/api/testkit/socketHarness.ts
apps/server/sources/app/api/testkit/sqliteFastify.ts
apps/server/sources/app/api/testkit/txHarness.ts
apps/server/sources/storage/dbcontract/portability.dbcontract.spec.ts
apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.ts
apps/server/sources/testkit/startServerMocks.ts
apps/server/vitest.dbcontract.config.ts
scripts/testing/featureTestGating.ts
```

### E2E Core — packages/tests (Vitest) (count: 209)

```text
packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/suites/core-e2e/accountSettings.notifications.roundtrip.test.ts
packages/tests/suites/core-e2e/agentState.multiDeviceReconnect.test.ts
packages/tests/suites/core-e2e/auth.mtls.keyless.plaintext.roundtrip.feat.auth.mtls.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/auth.pairing.desktopQrMobileScan.roundtrip.feat.auth.pairing.desktopQrMobileScan.e2e.test.ts
packages/tests/suites/core-e2e/automations.actions.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.crud.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.existingSession.pendingBridge.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/automations.leaseTakeover.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/automations.lifecycle.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.offlineRecovery.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/baselines.scoreShape.test.ts
packages/tests/suites/core-e2e/changes.catchupHints.test.ts
packages/tests/suites/core-e2e/claude.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.argsAndPermissions.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.mcpConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.taskoutput.sidechains.slow.e2e.test.ts
packages/tests/suites/core-e2e/cliDist.sharedDeps.test.ts
packages/tests/suites/core-e2e/codex.acp.inFlightSteer.pendingQueue.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/codex.localControl.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.resume.mcpStripsAcpState.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.failClosed.pending.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.codex.materialize.feat.connectedServices.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.quotas.roundtrip.feat.connectedServices.quotas.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.codex.tempHome.seedsConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.firstMessageNotDropped.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.stopDaemonFromHomeDir.portability.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.accountModeSwitch.keepsExistingSessionsReadable.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.defaultAccountMode.roundtrip.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.directShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.session.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.messageModeEnforcement.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.pendingQueueV2.materialize.roundtrip.feat.encryption.plaintextStorage.feat.sharing.pendingQueueV2.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.plaintextOnlyPolicy.guards.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.publicShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.public.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.roundtrip.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/ephemeralTasks.scmCommitMessage.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.planAndDelegate.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.resumableResume.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.review.triage.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/fakeClaude.hookForwarder.safe.test.ts
packages/tests/suites/core-e2e/fakeClaude.streamJsonInput.test.ts
packages/tests/suites/core-e2e/featureNegotiation.automations.enablement.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.buildPolicy.enforcement.slow.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.scopeAndFallback.feat.social.friends.slow.e2e.test.ts
packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/memory.hints.searchWindow.roundtrip.slow.e2e.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.emitsSocketUpdates.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.idempotencyKey.test.ts
packages/tests/suites/core-e2e/messages.socket.echoToSender.test.ts
packages/tests/suites/core-e2e/messages.socketAck.didWrite.test.ts
packages/tests/suites/core-e2e/messages.socketAck.schema.test.ts
packages/tests/suites/core-e2e/messages.socketIdempotency.noRebroadcast.test.ts
packages/tests/suites/core-e2e/multiServer.groupTarget.sessionListProjection.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.serverScopedOperationRouting.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.switch.authAndSockets.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.modelOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.probeModels.capabilityInvoke.test.ts
packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.slashCommandsExtraction.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.cli.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.daemon.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.http.crud.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.idempotency.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.socketRpc.test.ts
packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts
packages/tests/suites/core-e2e/permissions.lifecycle.encrypted.test.ts
packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.metadataUpdate.midTurn.slow.e2e.test.ts
packages/tests/suites/core-e2e/providers.baselines.selectKeys.test.ts
packages/tests/suites/core-e2e/providers.baselines.test.ts
packages/tests/suites/core-e2e/providers.harness.homeIsolation.test.ts
packages/tests/suites/core-e2e/providers.kilo.specPresence.test.ts
packages/tests/suites/core-e2e/providers.presets.test.ts
packages/tests/suites/core-e2e/providers.resumeMode.test.ts
packages/tests/suites/core-e2e/providers.sidechainWait.test.ts
packages/tests/suites/core-e2e/providers.toolSchemas.test.ts
packages/tests/suites/core-e2e/providers.traceSatisfaction.test.ts
packages/tests/suites/core-e2e/reconnect.midstreamStorm.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.agentMessages.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.test.ts
packages/tests/suites/core-e2e/rpc.permissionRoundtrip.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.sapling.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/serverLight.portRetry.test.ts
packages/tests/suites/core-e2e/session.continueWithReplay.dataKeyHydration.slow.e2e.test.ts
packages/tests/suites/core-e2e/sessions.list.catchup.test.ts
packages/tests/suites/core-e2e/sharing.public.e2ee.encryptedDataKeyRequired.feat.sharing.public.feat.sharing.contentKeys.e2e.test.ts
packages/tests/suites/core-e2e/sharing.session.e2ee.encryptedDataKeyRequired.feat.sharing.session.feat.sharing.contentKeys.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/structuredMessages.reviewComments.v1.feat.files.reviewComments.e2e.test.ts
packages/tests/suites/core-e2e/testkit.utils.test.ts
packages/tests/suites/core-e2e/tmux.attach.selectWindow.test.ts
packages/tests/suites/core-e2e/toolTraceJsonl.test.ts
packages/tests/suites/core-e2e/voice.agent.daemon.rpc.feat.voice.agent.slow.e2e.test.ts
packages/tests/suites/core-e2e/voice.leaseMint.accountScoped.feat.voice.test.ts
packages/tests/suites/core-e2e/voice.localTts.kokoro.settingsRoundtrip.feat.voice.test.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### E2E Core Fast — packages/tests (Vitest) (count: 193)

```text
apps/cli/src/backends/auggie/e2e/providerScenarios.json
apps/cli/src/backends/auggie/e2e/providerSpec.json
apps/cli/src/backends/claude/e2e/providerScenarios.json
apps/cli/src/backends/claude/e2e/providerSpec.json
apps/cli/src/backends/codex/e2e/providerScenarios.json
apps/cli/src/backends/codex/e2e/providerSpec.json
apps/cli/src/backends/gemini/e2e/providerScenarios.json
apps/cli/src/backends/gemini/e2e/providerSpec.json
apps/cli/src/backends/kilo/e2e/providerScenarios.json
apps/cli/src/backends/kilo/e2e/providerSpec.json
apps/cli/src/backends/kimi/e2e/providerScenarios.json
apps/cli/src/backends/kimi/e2e/providerSpec.json
apps/cli/src/backends/opencode/e2e/providerScenarios.json
apps/cli/src/backends/opencode/e2e/providerSpec.json
apps/cli/src/backends/pi/e2e/providerScenarios.json
apps/cli/src/backends/pi/e2e/providerSpec.json
apps/cli/src/backends/qwen/e2e/providerScenarios.json
apps/cli/src/backends/qwen/e2e/providerSpec.json
packages/tests/fixtures/cli-backends/codex_acp_stub/e2e/providerScenarios.json
packages/tests/fixtures/cli-backends/codex_acp_stub/e2e/providerSpec.json
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/suites/core-e2e/accountSettings.notifications.roundtrip.test.ts
packages/tests/suites/core-e2e/accountSettings.v2.plaintext.keyless.mtls.feat.auth.mtls.feat.encryption.plaintextStorage.feat.e2ee.keylessAccounts.e2e.test.ts
packages/tests/suites/core-e2e/agentState.multiDeviceReconnect.test.ts
packages/tests/suites/core-e2e/auth.mtls.keyless.plaintext.roundtrip.feat.auth.mtls.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/auth.pairing.desktopQrMobileScan.roundtrip.feat.auth.pairing.desktopQrMobileScan.e2e.test.ts
packages/tests/suites/core-e2e/automations.actions.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.crud.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.lifecycle.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/baselines.scoreShape.test.ts
packages/tests/suites/core-e2e/changes.catchupHints.test.ts
packages/tests/suites/core-e2e/claude.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/cliDist.sharedDeps.test.ts
packages/tests/suites/core-e2e/codex.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/daemon.stopDaemonFromHomeDir.portability.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.accountModeSwitch.keepsExistingSessionsReadable.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.defaultAccountMode.roundtrip.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.directShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.session.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.messageModeEnforcement.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.pendingQueueV2.materialize.roundtrip.feat.encryption.plaintextStorage.feat.sharing.pendingQueueV2.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.plaintextOnlyPolicy.guards.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.publicShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.public.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.roundtrip.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/ephemeralTasks.scmCommitMessage.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.planAndDelegate.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.resumableResume.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.review.triage.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/fakeClaude.hookForwarder.safe.test.ts
packages/tests/suites/core-e2e/fakeClaude.streamJsonInput.test.ts
packages/tests/suites/core-e2e/featureNegotiation.automations.enablement.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.emitsSocketUpdates.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.idempotencyKey.test.ts
packages/tests/suites/core-e2e/messages.socket.echoToSender.test.ts
packages/tests/suites/core-e2e/messages.socketAck.didWrite.test.ts
packages/tests/suites/core-e2e/messages.socketAck.schema.test.ts
packages/tests/suites/core-e2e/messages.socketIdempotency.noRebroadcast.test.ts
packages/tests/suites/core-e2e/opencode.acp.probeModels.capabilityInvoke.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.idempotency.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.socketRpc.test.ts
packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts
packages/tests/suites/core-e2e/permissions.lifecycle.encrypted.test.ts
packages/tests/suites/core-e2e/providers.baselines.selectKeys.test.ts
packages/tests/suites/core-e2e/providers.baselines.test.ts
packages/tests/suites/core-e2e/providers.harness.homeIsolation.test.ts
packages/tests/suites/core-e2e/providers.kilo.specPresence.test.ts
packages/tests/suites/core-e2e/providers.presets.test.ts
packages/tests/suites/core-e2e/providers.resumeMode.test.ts
packages/tests/suites/core-e2e/providers.sidechainWait.test.ts
packages/tests/suites/core-e2e/providers.toolSchemas.test.ts
packages/tests/suites/core-e2e/providers.traceSatisfaction.test.ts
packages/tests/suites/core-e2e/reconnect.midstreamStorm.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.agentMessages.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.test.ts
packages/tests/suites/core-e2e/rpc.permissionRoundtrip.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.sapling.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/serverLight.portRetry.test.ts
packages/tests/suites/core-e2e/sessions.list.catchup.test.ts
packages/tests/suites/core-e2e/sharing.public.e2ee.encryptedDataKeyRequired.feat.sharing.public.feat.sharing.contentKeys.e2e.test.ts
packages/tests/suites/core-e2e/sharing.session.e2ee.encryptedDataKeyRequired.feat.sharing.session.feat.sharing.contentKeys.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/structuredMessages.reviewComments.v1.feat.files.reviewComments.e2e.test.ts
packages/tests/suites/core-e2e/testkit.utils.test.ts
packages/tests/suites/core-e2e/tmux.attach.selectWindow.test.ts
packages/tests/suites/core-e2e/toolTraceJsonl.test.ts
packages/tests/suites/core-e2e/voice.leaseMint.accountScoped.feat.voice.test.ts
packages/tests/suites/core-e2e/voice.localTts.kokoro.settingsRoundtrip.feat.voice.test.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### E2E Core Slow — packages/tests (Vitest) (count: 144)

```text
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/suites/core-e2e/automations.existingSession.pendingBridge.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/automations.leaseTakeover.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/automations.offlineRecovery.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.argsAndPermissions.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.mcpConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.taskoutput.sidechains.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.acp.inFlightSteer.pendingQueue.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.localControl.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.resume.mcpStripsAcpState.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.failClosed.pending.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.codex.materialize.feat.connectedServices.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.quotas.roundtrip.feat.connectedServices.quotas.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.codex.tempHome.seedsConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.firstMessageNotDropped.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.buildPolicy.enforcement.slow.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.scopeAndFallback.feat.social.friends.slow.e2e.test.ts
packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/memory.hints.searchWindow.roundtrip.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.groupTarget.sessionListProjection.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.serverScopedOperationRouting.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.switch.authAndSockets.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.modelOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.slashCommandsExtraction.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.cli.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.daemon.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.http.crud.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.metadataUpdate.midTurn.slow.e2e.test.ts
packages/tests/suites/core-e2e/session.continueWithReplay.dataKeyHydration.slow.e2e.test.ts
packages/tests/suites/core-e2e/voice.agent.daemon.rpc.feat.voice.agent.slow.e2e.test.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### Providers — packages/tests (Vitest) (count: 255)

```text
packages/tests/baselines/providers/codex/permission_deny_outside_workspace.json
packages/tests/baselines/providers/codex/search_known_token.json
packages/tests/baselines/providers/codex/search_ls_equivalence.json
packages/tests/baselines/providers/kilo/acp_resume_fresh_session_imports_history.json
packages/tests/baselines/providers/kilo/acp_resume_load_session.json
packages/tests/baselines/providers/kilo/delete_file_in_workspace.json
packages/tests/baselines/providers/kilo/edit_result_includes_diff.json
packages/tests/baselines/providers/kilo/edit_write_file_and_cat.json
packages/tests/baselines/providers/kilo/execute_error_exit_2.json
packages/tests/baselines/providers/kilo/execute_trace_ok.json
packages/tests/baselines/providers/kilo/glob_list_files.json
packages/tests/baselines/providers/kilo/glob_tool_list_files.json
packages/tests/baselines/providers/kilo/kilo_task_subagent_reply.json
packages/tests/baselines/providers/kilo/mcp_change_title.json
packages/tests/baselines/providers/kilo/multi_file_edit_in_workspace.json
packages/tests/baselines/providers/kilo/multi_file_edit_in_workspace_includes_diff.json
packages/tests/baselines/providers/kilo/permission_deny_outside_workspace.json
packages/tests/baselines/providers/kilo/permission_surface_outside_workspace.json
packages/tests/baselines/providers/kilo/read_known_file.json
packages/tests/baselines/providers/kilo/read_missing_file_in_workspace.json
packages/tests/baselines/providers/kilo/search_known_token.json
packages/tests/baselines/providers/kilo/search_ls_equivalence.json
packages/tests/baselines/providers/opencode/acp_resume_fresh_session_imports_history.json
packages/tests/baselines/providers/opencode/acp_resume_load_session.json
packages/tests/baselines/providers/opencode/edit_result_includes_diff.json
packages/tests/baselines/providers/opencode/edit_write_file_and_cat.json
packages/tests/baselines/providers/opencode/execute_error_exit_2.json
packages/tests/baselines/providers/opencode/execute_trace_ok.json
packages/tests/baselines/providers/opencode/glob_list_files.json
packages/tests/baselines/providers/opencode/multi_file_edit_in_workspace.json
packages/tests/baselines/providers/opencode/multi_file_edit_in_workspace_includes_diff.json
packages/tests/baselines/providers/opencode/permission_deny_outside_workspace.json
packages/tests/baselines/providers/opencode/permission_deny_read_outside_workspace.json
packages/tests/baselines/providers/opencode/permission_surface_outside_workspace.json
packages/tests/baselines/providers/opencode/read_known_file.json
packages/tests/baselines/providers/opencode/read_missing_file_in_workspace.json
packages/tests/baselines/providers/opencode/search_known_token.json
packages/tests/baselines/providers/opencode/search_ls_equivalence.json
packages/tests/baselines/providers/opencode/task_subagent_reply.json
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/suites/providers/baselines.diff.test.ts
packages/tests/suites/providers/baselines.exampleSelection.test.ts
packages/tests/suites/providers/baselines.opencodeDialect.test.ts
packages/tests/suites/providers/baselines.selection.test.ts
packages/tests/suites/providers/baselines.shapeMatch.test.ts
packages/tests/suites/providers/baselines.shapeSubset.test.ts
packages/tests/suites/providers/capabilityProbe.rpcAckTimeoutBudget.test.ts
packages/tests/suites/providers/capabilityProbeFailure.test.ts
packages/tests/suites/providers/capabilityRetry.test.ts
packages/tests/suites/providers/cliAuth.permissions.test.ts
packages/tests/suites/providers/cliDistBuildCommand.test.ts
packages/tests/suites/providers/cliDistBuildLock.test.ts
packages/tests/suites/providers/daemon.controlServerClient.diagnostics.test.ts
packages/tests/suites/providers/daemon.sanitizeEnv.test.ts
packages/tests/suites/providers/daemon.stop.failureContext.test.ts
packages/tests/suites/providers/fakeClaudeFixture.helpers.test.ts
packages/tests/suites/providers/harness.buildProviderDevCommandArgs.test.ts
packages/tests/suites/providers/harness.cliDistAvailabilityWaitMs.test.ts
packages/tests/suites/providers/harness.cliDistPreflightRebuildPolicy.test.ts
packages/tests/suites/providers/harness.cliLogFatalDetection.test.ts
packages/tests/suites/providers/harness.codexPermissionArgs.test.ts
packages/tests/suites/providers/harness.daemonPolicy.test.ts
packages/tests/suites/providers/harness.fatalAgentMessage.test.ts
packages/tests/suites/providers/harness.hostAuthMirror.test.ts
packages/tests/suites/providers/harness.inFlightSteer.acpStub.e2e.test.ts
packages/tests/suites/providers/harness.inFlightSteer.codexAcp.e2e.test.ts
packages/tests/suites/providers/harness.inactivityTimeout.test.ts
packages/tests/suites/providers/harness.modelOverrideArgs.test.ts
packages/tests/suites/providers/harness.pendingDrainPolicy.test.ts
packages/tests/suites/providers/harness.permissionAutoApprove.test.ts
packages/tests/suites/providers/harness.permissionAutoApprovePolicy.test.ts
packages/tests/suites/providers/harness.permissionBlockTimeout.test.ts
packages/tests/suites/providers/harness.providerAvailability.test.ts
packages/tests/suites/providers/harness.sessionActiveWaitMs.test.ts
packages/tests/suites/providers/harness.tokenTelemetry.acpStub.e2e.test.ts
packages/tests/suites/providers/harness.tokenTelemetry.test.ts
packages/tests/suites/providers/harnessEnv.applyHomeIsolationEnv.test.ts
packages/tests/suites/providers/harnessSignals.stepGating.test.ts
packages/tests/suites/providers/http.waitForOkHealth.diagnostics.test.ts
packages/tests/suites/providers/presets.parallel.test.ts
packages/tests/suites/providers/processTree.test.ts
packages/tests/suites/providers/provider.matrix.test.ts
packages/tests/suites/providers/providerAuthSelection.test.ts
packages/tests/suites/providers/providerScenarioRegistry.references.test.ts
packages/tests/suites/providers/providerSpecs.auth.test.ts
packages/tests/suites/providers/providerSpecs.capabilityGating.test.ts
packages/tests/suites/providers/providerSpecs.codexAcpNpxFallback.test.ts
packages/tests/suites/providers/providerSpecs.kimiAuth.test.ts
packages/tests/suites/providers/providerSpecs.permissionModePromptMatrix.test.ts
packages/tests/suites/providers/providerSpecs.permissions.test.ts
packages/tests/suites/providers/providerSpecs.permissionsPassthrough.test.ts
packages/tests/suites/providers/providerSpecs.pi.test.ts
packages/tests/suites/providers/providerSpecs.requiredEnv.test.ts
packages/tests/suites/providers/providerSpecs.scenarioRegistry.authModes.test.ts
packages/tests/suites/providers/providerSpecs.scenarioRegistry.test.ts
packages/tests/suites/providers/providerSpecs.smokeTierNonEmpty.test.ts
packages/tests/suites/providers/providerSpecs.test.ts
packages/tests/suites/providers/runDir.diskSpaceGuard.test.ts
packages/tests/suites/providers/runDir.retention.test.ts
packages/tests/suites/providers/runExtendedDbDocker.script.test.ts
packages/tests/suites/providers/runProviders.script.test.ts
packages/tests/suites/providers/runProvidersParallel.script.test.ts
packages/tests/suites/providers/scenarioCatalog.abortContinuation.test.ts
packages/tests/suites/providers/scenarioCatalog.acpCapabilitiesAndModelSet.test.ts
packages/tests/suites/providers/scenarioCatalog.acpProbeModels.test.ts
packages/tests/suites/providers/scenarioCatalog.auggieReadKnownFilePath.test.ts
packages/tests/suites/providers/scenarioCatalog.auggieResume.test.ts
packages/tests/suites/providers/scenarioCatalog.claudePermissions.test.ts
packages/tests/suites/providers/scenarioCatalog.codexResumeInactivity.test.ts
packages/tests/suites/providers/scenarioCatalog.executeNormalization.test.ts
packages/tests/suites/providers/scenarioCatalog.inFlightSteer.test.ts
packages/tests/suites/providers/scenarioCatalog.kiloPermissionOutsideWorkspaceYolo.test.ts
packages/tests/suites/providers/scenarioCatalog.kiloResumeKey.test.ts
packages/tests/suites/providers/scenarioCatalog.kiloTaskContract.test.ts
packages/tests/suites/providers/scenarioCatalog.kimiPermissionModeNoPrompt.test.ts
packages/tests/suites/providers/scenarioCatalog.kimiReadKnownFileAutoApprove.test.ts
packages/tests/suites/providers/scenarioCatalog.kimiUnknownAliases.test.ts
packages/tests/suites/providers/scenarioCatalog.machineIds.test.ts
packages/tests/suites/providers/scenarioCatalog.opencodeSearchFallback.test.ts
packages/tests/suites/providers/scenarioCatalog.opencodeTaskContract.test.ts
packages/tests/suites/providers/scenarioCatalog.permissionModeMatrix.test.ts
packages/tests/suites/providers/scenarioCatalog.permissionSurfaceOutsideWorkspace.config.test.ts
packages/tests/suites/providers/scenarioCatalog.resumeAutoApprove.test.ts
packages/tests/suites/providers/scenarioSelection.acpProbeCapabilitiesSmoke.test.ts
packages/tests/suites/providers/scenarioSelection.authModes.test.ts
packages/tests/suites/providers/scenarioSelection.providersFromSpecs.test.ts
packages/tests/suites/providers/scenarioSelection.registry.test.ts
packages/tests/suites/providers/scenarios.acp.fs-search.test.ts
packages/tests/suites/providers/scenarios.acp.multiFileVerify.test.ts
packages/tests/suites/providers/scenarios.acp.permissions.test.ts
packages/tests/suites/providers/scenarios.acp.resume.test.ts
packages/tests/suites/providers/scenarios.acp.test.ts
packages/tests/suites/providers/scenarios.outsideWorkspacePathPolicy.test.ts
packages/tests/suites/providers/serverLight.retryPolicy.test.ts
packages/tests/suites/providers/sessions.pagination.test.ts
packages/tests/suites/providers/shape.normalizeBaseline.test.ts
packages/tests/suites/providers/socketClient.rpcRegister.test.ts
packages/tests/suites/providers/spawnProcess.runLoggedCommand.flush.test.ts
packages/tests/suites/providers/spawnProcess.runLoggedCommand.longRunning.test.ts
packages/tests/suites/providers/spawnProcess.runLoggedCommand.streamDrain.test.ts
packages/tests/suites/providers/spawnProcess.stop.test.ts
packages/tests/suites/providers/syntheticAgent.backoff.test.ts
packages/tests/suites/providers/syntheticAgent.rpcClient.test.ts
packages/tests/suites/providers/timing.waitFor.test.ts
packages/tests/suites/providers/tokenLedger.summary.test.ts
packages/tests/suites/providers/tooltrace.contract.test.ts
packages/tests/suites/providers/traceSatisfaction.importFilter.test.ts
packages/tests/suites/providers/uiMessages.post.test.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### Stress — packages/tests (Vitest) (count: 110)

```text
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/suites/stress/reconnect.chaos.test.ts
packages/tests/suites/stress/reconnect.repeat.test.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### UI E2E — packages/tests (Playwright) (count: 121)

```text
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/suites/ui-e2e/auth.mtls.autoRedirect.spec.ts
packages/tests/suites/ui-e2e/auth.mtls.terminalConnect.daemon.spec.ts
packages/tests/suites/ui-e2e/auth.oauth.keyed.github.restore.lostAccess.spec.ts
packages/tests/suites/ui-e2e/auth.oauth.keyless.autoRedirect.github.spec.ts
packages/tests/suites/ui-e2e/auth.oauth.provisioningChoice.optional.plain.github.spec.ts
packages/tests/suites/ui-e2e/auth.pairing.addPhone.desktopQrMobileScan.spec.ts
packages/tests/suites/ui-e2e/auth.terminalConnect.daemon.spec.ts
packages/tests/suites/ui-e2e/encryptionOptOut.modeSwitch.readBoth.spec.ts
packages/tests/suites/ui-e2e/encryptionOptOut.publicShare.plaintext.spec.ts
packages/tests/suites/ui-e2e/permissionPrompts.composerCard.jumpToTool.spec.ts
packages/tests/suites/ui-e2e/root.serverOverride.reachability.noManualRetry.spec.ts
packages/tests/suites/ui-e2e/session.panes.urlSync.backForward.spec.ts
packages/tests/suites/ui-e2e/settings.systemStatus.diagnosis.spec.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### Unit — apps/stack (node:test) (count: 464)

```text
apps/stack/bin/hstack.mjs
apps/stack/extras/swiftbar/hstack.sh
apps/stack/extras/swiftbar/lib/git.sh
apps/stack/extras/swiftbar/lib/utils.sh
apps/stack/extras/swiftbar/wt-pr.sh
apps/stack/package.json
apps/stack/scripts/auth.mjs
apps/stack/scripts/auth_force_flag.test.mjs
apps/stack/scripts/auth_help_cmd.test.mjs
apps/stack/scripts/auth_login_flow_in_tty.test.mjs
apps/stack/scripts/auth_login_force_default.test.mjs
apps/stack/scripts/auth_login_guided_server_no_expo.test.mjs
apps/stack/scripts/auth_login_method_override.test.mjs
apps/stack/scripts/auth_login_print_includes_configure_links.test.mjs
apps/stack/scripts/auth_login_respects_pinned_stack_port.test.mjs
apps/stack/scripts/auth_login_runtime_state_port.test.mjs
apps/stack/scripts/bundleWorkspaceDeps.mjs
apps/stack/scripts/bundleWorkspaceDeps.test.mjs
apps/stack/scripts/ci.mjs
apps/stack/scripts/ci.test.mjs
apps/stack/scripts/daemon.mjs
apps/stack/scripts/daemon.status_scope.test.mjs
apps/stack/scripts/daemon_dist_guard.test.mjs
apps/stack/scripts/daemon_server_scoped_state.test.mjs
apps/stack/scripts/daemon_stop_expected_pid.test.mjs
apps/stack/scripts/dev.mjs
apps/stack/scripts/dev_external_server_flags.test.mjs
apps/stack/scripts/doctor.mjs
apps/stack/scripts/doctor_cmd.test.mjs
apps/stack/scripts/doctor_ui_index_missing.test.mjs
apps/stack/scripts/eas.mjs
apps/stack/scripts/eas_platform_parsing.test.mjs
apps/stack/scripts/env.mjs
apps/stack/scripts/env_cmd.test.mjs
apps/stack/scripts/ghops.mjs
apps/stack/scripts/ghops.test.mjs
apps/stack/scripts/happier_help_passthrough.test.mjs
apps/stack/scripts/happier_server_url_scope.test.mjs
apps/stack/scripts/init.mjs
apps/stack/scripts/init_shim_invoked_cwd.test.mjs
apps/stack/scripts/logs.mjs
apps/stack/scripts/logs_cmd.test.mjs
apps/stack/scripts/mobile.mjs
apps/stack/scripts/mobile_dev_client.mjs
apps/stack/scripts/mobile_dev_client_help_smoke.test.mjs
apps/stack/scripts/mobile_prebuild_happyDir_defined.test.mjs
apps/stack/scripts/mobile_prebuild_sets_rct_metro_port.test.mjs
apps/stack/scripts/mobile_run_ios_uses_long_port_flag.test.mjs
apps/stack/scripts/orchestrated_stack_auth_flow.test.mjs
apps/stack/scripts/orchestrated_stack_auth_flow_resolve_port.test.mjs
apps/stack/scripts/orchestrated_stack_auth_flow_webapp_url.test.mjs
apps/stack/scripts/pack.mjs
apps/stack/scripts/pack.test.mjs
apps/stack/scripts/providers_cmd.mjs
apps/stack/scripts/provision/linux-ubuntu-provision.sh
apps/stack/scripts/provision/linux-ubuntu-provision.test.mjs
apps/stack/scripts/provision/macos-lima-vm.sh
apps/stack/scripts/provision/macos-lima-vm.test.mjs
apps/stack/scripts/repo_cli_activate.mjs
apps/stack/scripts/repo_cli_activate.test.mjs
apps/stack/scripts/repo_local.mjs
apps/stack/scripts/repo_local_wrapper.test.mjs
apps/stack/scripts/review_pr.mjs
apps/stack/scripts/review_pr.warm_base_deps.test.mjs
apps/stack/scripts/review_pr.workspace_cache.test.mjs
apps/stack/scripts/root_package_repo_local_scripts.test.mjs
apps/stack/scripts/run.mjs
apps/stack/scripts/run_script_with_stack_env.restart_port_reuse.test.mjs
apps/stack/scripts/sandbox_workspace_override.test.mjs
apps/stack/scripts/self.mjs
apps/stack/scripts/self_host.mjs
apps/stack/scripts/self_host_runtime.mjs
apps/stack/scripts/self_host_runtime.test.mjs
apps/stack/scripts/service.mjs
apps/stack/scripts/service_mode_help.test.mjs
apps/stack/scripts/setup.mjs
apps/stack/scripts/setup_dev_child_env.test.mjs
apps/stack/scripts/setup_local_repo_profile.test.mjs
apps/stack/scripts/setup_non_interactive_flag.test.mjs
apps/stack/scripts/setup_pr.mjs
apps/stack/scripts/setup_pr.mobile_scheme.test.mjs
apps/stack/scripts/setup_pr_orchestrated_auth_flow_util_import.test.mjs
apps/stack/scripts/stack.mjs
apps/stack/scripts/stack/command_arguments.mjs
apps/stack/scripts/stack/copy_auth_from_stack.mjs
apps/stack/scripts/stack/delegated_script_commands.mjs
apps/stack/scripts/stack/help_text.mjs
apps/stack/scripts/stack/port_reservation.mjs
apps/stack/scripts/stack/repo_checkout_resolution.mjs
apps/stack/scripts/stack/run_script_with_stack_env.mjs
apps/stack/scripts/stack/stack_daemon_command.mjs
apps/stack/scripts/stack/stack_delegated_help.mjs
apps/stack/scripts/stack/stack_environment.mjs
apps/stack/scripts/stack/stack_environment.sanitization.test.mjs
apps/stack/scripts/stack/stack_happier_passthrough_command.mjs
apps/stack/scripts/stack/stack_info_snapshot.mjs
apps/stack/scripts/stack/stack_mobile_install_command.mjs
apps/stack/scripts/stack/stack_resume_command.mjs
apps/stack/scripts/stack/stack_stop_command.mjs
apps/stack/scripts/stack/stack_workspace_command.mjs
apps/stack/scripts/stack/transient_repo_overrides.mjs
apps/stack/scripts/stack_audit_fix_light_env.test.mjs
apps/stack/scripts/stack_background_pinned_stack_json.test.mjs
apps/stack/scripts/stack_copy_auth_server_scoped.test.mjs
apps/stack/scripts/stack_create_dev_auth_seed_help_force.test.mjs
apps/stack/scripts/stack_eas_help.test.mjs
apps/stack/scripts/stack_editor_workspace_monorepo_root.test.mjs
apps/stack/scripts/stack_env_cmd.test.mjs
apps/stack/scripts/stack_guided_login_bundle_error_parse.test.mjs
apps/stack/scripts/stack_guided_login_does_not_preopen_browser.test.mjs
apps/stack/scripts/stack_guided_login_inner_invocation.test.mjs
apps/stack/scripts/stack_info_snapshot_running_status.test.mjs
apps/stack/scripts/stack_interactive_monorepo_group.test.mjs
apps/stack/scripts/stack_monorepo_defaults.test.mjs
apps/stack/scripts/stack_monorepo_repo_dev_token.test.mjs
apps/stack/scripts/stack_monorepo_server_light_from_happy_spec.test.mjs
apps/stack/scripts/stack_new_name_normalize_cmd.test.mjs
apps/stack/scripts/stack_pr_help_cmd.test.mjs
apps/stack/scripts/stack_pr_name_normalize_cmd.test.mjs
apps/stack/scripts/stack_server_flavors_defaults.test.mjs
apps/stack/scripts/stack_wt_list.test.mjs
apps/stack/scripts/start_ui_required_default.test.mjs
apps/stack/scripts/swiftbar_git_monorepo_cmd.test.mjs
apps/stack/scripts/swiftbar_utils_cmd.test.mjs
apps/stack/scripts/swiftbar_wt_pr_backcompat.test.mjs
apps/stack/scripts/systemd_unit_info.test.mjs
apps/stack/scripts/tailscale.mjs
apps/stack/scripts/tailscale_cmd_output.test.mjs
apps/stack/scripts/test_ci.mjs
apps/stack/scripts/test_cmd.mjs
apps/stack/scripts/test_cmd.test.mjs
apps/stack/scripts/test_integration.mjs
apps/stack/scripts/testkit/auth_testkit.mjs
apps/stack/scripts/testkit/doctor_testkit.mjs
apps/stack/scripts/testkit/monorepo_port_testkit.mjs
apps/stack/scripts/testkit/stack_archive_command_testkit.mjs
apps/stack/scripts/testkit/stack_new_monorepo_testkit.mjs
apps/stack/scripts/testkit/stack_script_command_testkit.mjs
apps/stack/scripts/testkit/stack_stop_sweeps_testkit.mjs
apps/stack/scripts/testkit/worktrees_monorepo_testkit.mjs
apps/stack/scripts/tui.mjs
apps/stack/scripts/tui_args_default_cmd.test.mjs
apps/stack/scripts/utils/auth/auth_force_flag.mjs
apps/stack/scripts/utils/auth/credentials_paths.mjs
apps/stack/scripts/utils/auth/credentials_paths.test.mjs
apps/stack/scripts/utils/auth/daemon_gate.mjs
apps/stack/scripts/utils/auth/daemon_gate.test.mjs
apps/stack/scripts/utils/auth/decode_jwt_payload_unsafe.mjs
apps/stack/scripts/utils/auth/dev_key.mjs
apps/stack/scripts/utils/auth/files.mjs
apps/stack/scripts/utils/auth/guided_pr_auth.mjs
apps/stack/scripts/utils/auth/guided_stack_web_login.mjs
apps/stack/scripts/utils/auth/handy_master_secret.mjs
apps/stack/scripts/utils/auth/interactive_stack_auth.mjs
apps/stack/scripts/utils/auth/login_ux.mjs
apps/stack/scripts/utils/auth/orchestrated_stack_auth_flow.mjs
apps/stack/scripts/utils/auth/sources.mjs
apps/stack/scripts/utils/auth/stable_scope_id.mjs
apps/stack/scripts/utils/auth/stable_scope_id.test.mjs
apps/stack/scripts/utils/auth/stack_guided_login.mjs
apps/stack/scripts/utils/cli/arg_values.mjs
apps/stack/scripts/utils/cli/arg_values.test.mjs
apps/stack/scripts/utils/cli/args.mjs
apps/stack/scripts/utils/cli/cli.mjs
apps/stack/scripts/utils/cli/cli_registry.mjs
apps/stack/scripts/utils/cli/cwd_scope.mjs
apps/stack/scripts/utils/cli/cwd_scope.test.mjs
apps/stack/scripts/utils/cli/flags.mjs
apps/stack/scripts/utils/cli/log_forwarder.mjs
apps/stack/scripts/utils/cli/normalize.mjs
apps/stack/scripts/utils/cli/prereqs.mjs
apps/stack/scripts/utils/cli/prereqs.test.mjs
apps/stack/scripts/utils/cli/progress.mjs
apps/stack/scripts/utils/cli/progress.test.mjs
apps/stack/scripts/utils/cli/smoke_help.mjs
apps/stack/scripts/utils/cli/verbosity.mjs
apps/stack/scripts/utils/cli/wizard.mjs
apps/stack/scripts/utils/cli/wizard_promptSelect.test.mjs
apps/stack/scripts/utils/cli/wizard_prompt_worktree_source_lazy.test.mjs
apps/stack/scripts/utils/cli/wizard_worktree_slug.test.mjs
apps/stack/scripts/utils/crypto/tokens.mjs
apps/stack/scripts/utils/dev/daemon.mjs
apps/stack/scripts/utils/dev/daemon_watch_resilience.test.mjs
apps/stack/scripts/utils/dev/expo_dev.buildEnv.test.mjs
apps/stack/scripts/utils/dev/expo_dev.mjs
apps/stack/scripts/utils/dev/expo_dev.test.mjs
apps/stack/scripts/utils/dev/expo_dev_restart_port_reservation.test.mjs
apps/stack/scripts/utils/dev/expo_dev_runtime_metadata.test.mjs
apps/stack/scripts/utils/dev/expo_dev_verbose_logs.test.mjs
apps/stack/scripts/utils/dev/resolveDevServerConnection.mjs
apps/stack/scripts/utils/dev/resolveDevServerConnection.test.mjs
apps/stack/scripts/utils/dev/server.mjs
apps/stack/scripts/utils/dev_auth_key.mjs
apps/stack/scripts/utils/edison/git_roots.mjs
apps/stack/scripts/utils/edison/git_roots.test.mjs
apps/stack/scripts/utils/env/config.mjs
apps/stack/scripts/utils/env/dotenv.mjs
apps/stack/scripts/utils/env/dotenv.test.mjs
apps/stack/scripts/utils/env/env.mjs
apps/stack/scripts/utils/env/env_file.mjs
apps/stack/scripts/utils/env/env_file.test.mjs
apps/stack/scripts/utils/env/env_local.mjs
apps/stack/scripts/utils/env/load_env_file.mjs
apps/stack/scripts/utils/env/read.mjs
apps/stack/scripts/utils/env/sandbox.mjs
apps/stack/scripts/utils/env/scrub_env.mjs
apps/stack/scripts/utils/env/scrub_env.test.mjs
apps/stack/scripts/utils/env/values.mjs
apps/stack/scripts/utils/expo/command.mjs
apps/stack/scripts/utils/expo/command_workspace_deps_built.test.mjs
apps/stack/scripts/utils/expo/expo.mjs
apps/stack/scripts/utils/expo/expo_shared_tmpdir.test.mjs
apps/stack/scripts/utils/expo/expo_state_running.test.mjs
apps/stack/scripts/utils/expo/metro_ports.mjs
apps/stack/scripts/utils/expo/metro_ports.test.mjs
apps/stack/scripts/utils/fs/atomic_dir_swap.mjs
apps/stack/scripts/utils/fs/atomic_dir_swap.test.mjs
apps/stack/scripts/utils/fs/file_has_content.mjs
apps/stack/scripts/utils/fs/fs.mjs
apps/stack/scripts/utils/fs/json.mjs
apps/stack/scripts/utils/fs/ops.mjs
apps/stack/scripts/utils/fs/package_json.mjs
apps/stack/scripts/utils/fs/tail.mjs
apps/stack/scripts/utils/git/default_branch.mjs
apps/stack/scripts/utils/git/default_branch.test.mjs
apps/stack/scripts/utils/git/dev_checkout.mjs
apps/stack/scripts/utils/git/dev_checkout.test.mjs
apps/stack/scripts/utils/git/fast_forward_to_remote.mjs
apps/stack/scripts/utils/git/fast_forward_to_remote.test.mjs
apps/stack/scripts/utils/git/git.mjs
apps/stack/scripts/utils/git/parse_name_status_z.mjs
apps/stack/scripts/utils/git/refs.mjs
apps/stack/scripts/utils/git/refs.test.mjs
apps/stack/scripts/utils/git/worktrees.mjs
apps/stack/scripts/utils/git/worktrees_monorepo.test.mjs
apps/stack/scripts/utils/git/worktrees_pathstyle.test.mjs
apps/stack/scripts/utils/llm/assist.mjs
apps/stack/scripts/utils/llm/codex_exec.mjs
apps/stack/scripts/utils/llm/codex_exec.test.mjs
apps/stack/scripts/utils/llm/hstack_runner.mjs
apps/stack/scripts/utils/llm/tools.mjs
apps/stack/scripts/utils/llm/tools.test.mjs
apps/stack/scripts/utils/menubar/swiftbar.mjs
apps/stack/scripts/utils/menubar/swiftbar.test.mjs
apps/stack/scripts/utils/mobile/config.mjs
apps/stack/scripts/utils/mobile/dev_client_install_invocation.mjs
apps/stack/scripts/utils/mobile/dev_client_install_invocation.test.mjs
apps/stack/scripts/utils/mobile/dev_client_links.mjs
apps/stack/scripts/utils/mobile/identifiers.mjs
apps/stack/scripts/utils/mobile/identifiers.test.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.test.mjs
apps/stack/scripts/utils/net/bind_mode.mjs
apps/stack/scripts/utils/net/dns.mjs
apps/stack/scripts/utils/net/lan_ip.mjs
apps/stack/scripts/utils/net/ports.mjs
apps/stack/scripts/utils/net/tcp_forward.mjs
apps/stack/scripts/utils/net/url.mjs
apps/stack/scripts/utils/net/url.test.mjs
apps/stack/scripts/utils/paths/canonical_home.mjs
apps/stack/scripts/utils/paths/canonical_home.test.mjs
apps/stack/scripts/utils/paths/localhost_host.mjs
apps/stack/scripts/utils/paths/localhost_host.test.mjs
apps/stack/scripts/utils/paths/paths.mjs
apps/stack/scripts/utils/paths/paths_env_win32.test.mjs
apps/stack/scripts/utils/paths/paths_monorepo.test.mjs
apps/stack/scripts/utils/paths/paths_server_flavors.test.mjs
apps/stack/scripts/utils/paths/runtime.mjs
apps/stack/scripts/utils/pglite_lock.mjs
apps/stack/scripts/utils/proc/commands.mjs
apps/stack/scripts/utils/proc/ensureWorkspacePackagesBuilt.test.mjs
apps/stack/scripts/utils/proc/exit_cleanup.mjs
apps/stack/scripts/utils/proc/happy_monorepo_deps.mjs
apps/stack/scripts/utils/proc/happy_monorepo_deps.test.mjs
apps/stack/scripts/utils/proc/ownership.mjs
apps/stack/scripts/utils/proc/ownership_killProcessGroupOwnedByStack.test.mjs
apps/stack/scripts/utils/proc/ownership_listPidsWithEnvNeedles.test.mjs
apps/stack/scripts/utils/proc/package_scripts.mjs
apps/stack/scripts/utils/proc/package_scripts.test.mjs
apps/stack/scripts/utils/proc/parallel.mjs
apps/stack/scripts/utils/proc/pids.mjs
apps/stack/scripts/utils/proc/pm.mjs
apps/stack/scripts/utils/proc/pm_spawn.integration.test.mjs
apps/stack/scripts/utils/proc/pm_stack_cache_env.test.mjs
apps/stack/scripts/utils/proc/proc.mjs
apps/stack/scripts/utils/proc/proc.test.mjs
apps/stack/scripts/utils/proc/terminate.mjs
apps/stack/scripts/utils/proc/terminate.test.mjs
apps/stack/scripts/utils/proc/watch.mjs
apps/stack/scripts/utils/review/augment_runner_integration.test.mjs
apps/stack/scripts/utils/review/base_ref.mjs
apps/stack/scripts/utils/review/base_ref.test.mjs
apps/stack/scripts/utils/review/chunks.mjs
apps/stack/scripts/utils/review/chunks.test.mjs
apps/stack/scripts/utils/review/detached_worktree.mjs
apps/stack/scripts/utils/review/detached_worktree.test.mjs
apps/stack/scripts/utils/review/findings.mjs
apps/stack/scripts/utils/review/findings.test.mjs
apps/stack/scripts/utils/review/head_slice.mjs
apps/stack/scripts/utils/review/head_slice.test.mjs
apps/stack/scripts/utils/review/instructions/deep.md
apps/stack/scripts/utils/review/prompts.mjs
apps/stack/scripts/utils/review/prompts.test.mjs
apps/stack/scripts/utils/review/run_reviewers_safe.mjs
apps/stack/scripts/utils/review/run_reviewers_safe.test.mjs
apps/stack/scripts/utils/review/runners/augment.mjs
apps/stack/scripts/utils/review/runners/augment.test.mjs
apps/stack/scripts/utils/review/runners/claude.mjs
apps/stack/scripts/utils/review/runners/claude.test.mjs
apps/stack/scripts/utils/review/runners/coderabbit.mjs
apps/stack/scripts/utils/review/runners/coderabbit.test.mjs
apps/stack/scripts/utils/review/runners/codex.mjs
apps/stack/scripts/utils/review/runners/codex.test.mjs
apps/stack/scripts/utils/review/slice_mode.mjs
apps/stack/scripts/utils/review/slice_mode.test.mjs
apps/stack/scripts/utils/review/sliced_runner.mjs
apps/stack/scripts/utils/review/sliced_runner.test.mjs
apps/stack/scripts/utils/review/slices.mjs
apps/stack/scripts/utils/review/slices.test.mjs
apps/stack/scripts/utils/review/targets.mjs
apps/stack/scripts/utils/review/targets.test.mjs
apps/stack/scripts/utils/review/tool_home_seed.mjs
apps/stack/scripts/utils/review/tool_home_seed.test.mjs
apps/stack/scripts/utils/review/uncommitted_ops.mjs
apps/stack/scripts/utils/review/uncommitted_ops.test.mjs
apps/stack/scripts/utils/sandbox/review_pr_sandbox.mjs
apps/stack/scripts/utils/server/apply_server_light_env_defaults.mjs
apps/stack/scripts/utils/server/flavor_scripts.mjs
apps/stack/scripts/utils/server/flavor_scripts.test.mjs
apps/stack/scripts/utils/server/infra/happy_server_infra.mjs
apps/stack/scripts/utils/server/mobile_api_url.mjs
apps/stack/scripts/utils/server/mobile_api_url.test.mjs
apps/stack/scripts/utils/server/port.mjs
apps/stack/scripts/utils/server/prisma_import.mjs
apps/stack/scripts/utils/server/prisma_import.test.mjs
apps/stack/scripts/utils/server/resolve_stack_server_port.mjs
apps/stack/scripts/utils/server/resolve_stack_server_port.test.mjs
apps/stack/scripts/utils/server/server.mjs
apps/stack/scripts/utils/server/ui_build_check.mjs
apps/stack/scripts/utils/server/ui_build_check.test.mjs
apps/stack/scripts/utils/server/ui_env.mjs
apps/stack/scripts/utils/server/ui_env.test.mjs
apps/stack/scripts/utils/server/urls.mjs
apps/stack/scripts/utils/server/validate.mjs
apps/stack/scripts/utils/server/validate.test.mjs
apps/stack/scripts/utils/service/autostart_darwin.mjs
apps/stack/scripts/utils/service/autostart_darwin.test.mjs
apps/stack/scripts/utils/service/autostart_darwin_keepalive.test.mjs
apps/stack/scripts/utils/service/service_manager.definition.test.mjs
apps/stack/scripts/utils/service/service_manager.mjs
apps/stack/scripts/utils/service/service_manager.plan.test.mjs
apps/stack/scripts/utils/service/service_manager.test.mjs
apps/stack/scripts/utils/service/stack_autostart_resolution.mjs
apps/stack/scripts/utils/service/stack_autostart_resolution.test.mjs
apps/stack/scripts/utils/service/systemd_service_unit.mjs
apps/stack/scripts/utils/service/systemd_service_unit.test.mjs
apps/stack/scripts/utils/service/windows_schtasks_wrapper.mjs
apps/stack/scripts/utils/service/windows_schtasks_wrapper.test.mjs
apps/stack/scripts/utils/setup/child_env.mjs
apps/stack/scripts/utils/setup/child_env.test.mjs
apps/stack/scripts/utils/stack/cli_identities.mjs
apps/stack/scripts/utils/stack/context.mjs
apps/stack/scripts/utils/stack/dirs.mjs
apps/stack/scripts/utils/stack/editor_workspace.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.port_validation.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.remote_validation.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.stack_name_validation.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config_testkit.mjs
apps/stack/scripts/utils/stack/names.mjs
apps/stack/scripts/utils/stack/names.test.mjs
apps/stack/scripts/utils/stack/pr_stack_name.mjs
apps/stack/scripts/utils/stack/runtime_state.mjs
apps/stack/scripts/utils/stack/stacks.mjs
apps/stack/scripts/utils/stack/startup.mjs
apps/stack/scripts/utils/stack/startup_server_light_dirs.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_generate.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_legacy.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_testkit.mjs
apps/stack/scripts/utils/stack/stop.mjs
apps/stack/scripts/utils/stack/terminal_usage_instructions.mjs
apps/stack/scripts/utils/stack/terminal_usage_instructions.test.mjs
apps/stack/scripts/utils/stack_context.mjs
apps/stack/scripts/utils/stack_runtime_state.mjs
apps/stack/scripts/utils/stacks.mjs
apps/stack/scripts/utils/tailscale/ip.mjs
apps/stack/scripts/utils/tauri/stack_overrides.mjs
apps/stack/scripts/utils/test/collect_test_files.mjs
apps/stack/scripts/utils/time/get_today_ymd.mjs
apps/stack/scripts/utils/tui/actions.mjs
apps/stack/scripts/utils/tui/actions.test.mjs
apps/stack/scripts/utils/tui/args.mjs
apps/stack/scripts/utils/tui/args.test.mjs
apps/stack/scripts/utils/tui/child_termination_plan.mjs
apps/stack/scripts/utils/tui/child_termination_plan.test.mjs
apps/stack/scripts/utils/tui/cleanup.mjs
apps/stack/scripts/utils/tui/daemon_auth_notice.mjs
apps/stack/scripts/utils/tui/daemon_auth_notice.test.mjs
apps/stack/scripts/utils/tui/daemon_autostart.mjs
apps/stack/scripts/utils/tui/daemon_autostart.test.mjs
apps/stack/scripts/utils/tui/daemon_pane_reconcile.mjs
apps/stack/scripts/utils/tui/daemon_pane_reconcile.test.mjs
apps/stack/scripts/utils/tui/script_pty_command.mjs
apps/stack/scripts/utils/tui/script_pty_command.test.mjs
apps/stack/scripts/utils/tui/stack_scope_env.mjs
apps/stack/scripts/utils/tui/stack_scope_env.test.mjs
apps/stack/scripts/utils/tui/stdin_handoff.mjs
apps/stack/scripts/utils/tui/stdin_handoff.test.mjs
apps/stack/scripts/utils/tui/summary_env.mjs
apps/stack/scripts/utils/tui/summary_env.test.mjs
apps/stack/scripts/utils/ui/ansi.mjs
apps/stack/scripts/utils/ui/box_line.mjs
apps/stack/scripts/utils/ui/box_line.test.mjs
apps/stack/scripts/utils/ui/browser.mjs
apps/stack/scripts/utils/ui/browser.test.mjs
apps/stack/scripts/utils/ui/clipboard.mjs
apps/stack/scripts/utils/ui/layout.mjs
apps/stack/scripts/utils/ui/qr.mjs
apps/stack/scripts/utils/ui/terminal_launcher.mjs
apps/stack/scripts/utils/ui/text.mjs
apps/stack/scripts/utils/ui/ui_export_env.mjs
apps/stack/scripts/utils/ui/ui_export_env.test.mjs
apps/stack/scripts/utils/update/auto_update_notice.mjs
apps/stack/scripts/utils/validate.mjs
apps/stack/scripts/utils/worktrees/reflink_copy_dir.mjs
apps/stack/scripts/utils/worktrees/seed_node_modules.mjs
apps/stack/scripts/utils/worktrees/seed_node_modules.test.mjs
apps/stack/scripts/utils/worktrees/yarn_install_guard.mjs
apps/stack/scripts/utils/worktrees/yarn_install_guard.test.mjs
apps/stack/scripts/worktrees.mjs
apps/stack/scripts/worktrees_cursor_monorepo_root.test.mjs
apps/stack/scripts/worktrees_list_specs_no_recurse.test.mjs
apps/stack/scripts/worktrees_monorepo_testkit.test.mjs
apps/stack/scripts/worktrees_monorepo_use_group.test.mjs
apps/stack/scripts/worktrees_status_default_target.test.mjs
apps/stack/tests/autoUpdateNotice.test.mjs
apps/stack/tests/dev-box-entrypoint-providers.test.mjs
apps/stack/tests/help-routing.test.mjs
apps/stack/tests/menubar-uninstall-legacy.test.mjs
apps/stack/tests/providers-install.test.mjs
apps/stack/tests/remote-daemon-setup.test.mjs
apps/stack/tests/remote-server-setup.test.mjs
apps/stack/tests/review-codex-model-alias.test.mjs
apps/stack/tests/review-type.test.mjs
apps/stack/tests/self-host-config.test.mjs
apps/stack/tests/self-host-env-overrides.test.mjs
apps/stack/tests/selfPreviewChannel.test.mjs
apps/stack/tests/selfStatus.test.mjs
apps/stack/tests/selfUpdateFailureOutput.test.mjs
apps/stack/tests/selfUpdatePackageOverride.test.mjs
apps/stack/tests/stack-duplicate-normalization.test.mjs
apps/stack/tests/stack-test-wrapper.test.mjs
apps/stack/tests/tauri-config-overrides.test.mjs
apps/stack/tests/testkit/remote_daemon_setup_testkit.mjs
apps/stack/tests/testkit/remote_server_setup_testkit.mjs
apps/stack/tests/testkit/self_update_testkit.mjs
apps/stack/tests/testkit/tempdir_testkit.mjs
docker/dev-box/entrypoint.sh
package.json
packages/cli-common/src/service/index.ts
packages/cli-common/src/service/launchd.ts
packages/cli-common/src/service/manager.ts
packages/cli-common/src/service/systemd.ts
packages/cli-common/src/service/windows.ts
```

### Integration — apps/stack (node:test) (count: 351)

```text
apps/stack/package.json
apps/stack/scripts/auth_copy_from_pglite_lock_in_use.integration.test.mjs
apps/stack/scripts/auth_copy_from_runCapture.integration.test.mjs
apps/stack/scripts/auth_status_server_validation.integration.test.mjs
apps/stack/scripts/daemon_invalid_auth_reseed_stack_name.integration.test.mjs
apps/stack/scripts/daemon_start_verification.integration.test.mjs
apps/stack/scripts/exit_cleanup_kills_detached_children_on_crash.integration.test.mjs
apps/stack/scripts/mobile_run_ios_passes_port.integration.test.mjs
apps/stack/scripts/monorepo_port.apply.integration.test.mjs
apps/stack/scripts/monorepo_port.conflicts.integration.test.mjs
apps/stack/scripts/monorepo_port.validation.integration.test.mjs
apps/stack/scripts/pglite_lock.integration.test.mjs
apps/stack/scripts/release_binary_smoke.integration.test.mjs
apps/stack/scripts/self_host_binary_smoke.integration.test.mjs
apps/stack/scripts/self_host_daemon.real.integration.test.mjs
apps/stack/scripts/self_host_launchd.real.integration.test.mjs
apps/stack/scripts/self_host_schtasks.real.integration.test.mjs
apps/stack/scripts/self_host_service_e2e_harness.mjs
apps/stack/scripts/self_host_systemd.real.integration.test.mjs
apps/stack/scripts/stack/command_arguments.mjs
apps/stack/scripts/stack/copy_auth_from_stack.mjs
apps/stack/scripts/stack/delegated_script_commands.mjs
apps/stack/scripts/stack/help_text.mjs
apps/stack/scripts/stack/port_reservation.mjs
apps/stack/scripts/stack/repo_checkout_resolution.mjs
apps/stack/scripts/stack/run_script_with_stack_env.mjs
apps/stack/scripts/stack/stack_daemon_command.mjs
apps/stack/scripts/stack/stack_delegated_help.mjs
apps/stack/scripts/stack/stack_environment.mjs
apps/stack/scripts/stack/stack_environment.sanitization.test.mjs
apps/stack/scripts/stack/stack_happier_passthrough_command.mjs
apps/stack/scripts/stack/stack_info_snapshot.mjs
apps/stack/scripts/stack/stack_mobile_install_command.mjs
apps/stack/scripts/stack/stack_resume_command.mjs
apps/stack/scripts/stack/stack_stop_command.mjs
apps/stack/scripts/stack/stack_workspace_command.mjs
apps/stack/scripts/stack/transient_repo_overrides.mjs
apps/stack/scripts/stack_archive_cmd.integration.test.mjs
apps/stack/scripts/stack_daemon_cmd.integration.test.mjs
apps/stack/scripts/stack_happy_cmd.integration.test.mjs
apps/stack/scripts/stack_resume_cmd.integration.test.mjs
apps/stack/scripts/stack_shorthand_cmd.integration.test.mjs
apps/stack/scripts/stack_stop_sweeps_legacy_infra_without_kind.integration.test.mjs
apps/stack/scripts/stack_stop_sweeps_when_runtime_missing.integration.test.mjs
apps/stack/scripts/stack_stop_sweeps_when_runtime_stale.integration.test.mjs
apps/stack/scripts/stopStackWithEnv_kills_ephemeral_runtime_pids_without_env_markers.integration.test.mjs
apps/stack/scripts/stopStackWithEnv_no_autosweep_when_runtime_missing.integration.test.mjs
apps/stack/scripts/stopStackWithEnv_sweeps_repo_local_stack_by_stackName_when_runtime_missing.integration.test.mjs
apps/stack/scripts/swiftbar_render_monorepo_wt_actions.integration.test.mjs
apps/stack/scripts/test_integration.mjs
apps/stack/scripts/testkit/auth_testkit.mjs
apps/stack/scripts/testkit/doctor_testkit.mjs
apps/stack/scripts/testkit/monorepo_port_testkit.mjs
apps/stack/scripts/testkit/stack_archive_command_testkit.mjs
apps/stack/scripts/testkit/stack_new_monorepo_testkit.mjs
apps/stack/scripts/testkit/stack_script_command_testkit.mjs
apps/stack/scripts/testkit/stack_stop_sweeps_testkit.mjs
apps/stack/scripts/testkit/worktrees_monorepo_testkit.mjs
apps/stack/scripts/tui_stopStackForTuiExit_no_autosweep.integration.test.mjs
apps/stack/scripts/utils/auth/auth_force_flag.mjs
apps/stack/scripts/utils/auth/credentials_paths.mjs
apps/stack/scripts/utils/auth/credentials_paths.test.mjs
apps/stack/scripts/utils/auth/daemon_gate.mjs
apps/stack/scripts/utils/auth/daemon_gate.test.mjs
apps/stack/scripts/utils/auth/decode_jwt_payload_unsafe.mjs
apps/stack/scripts/utils/auth/dev_key.mjs
apps/stack/scripts/utils/auth/files.mjs
apps/stack/scripts/utils/auth/guided_pr_auth.mjs
apps/stack/scripts/utils/auth/guided_stack_web_login.mjs
apps/stack/scripts/utils/auth/handy_master_secret.mjs
apps/stack/scripts/utils/auth/interactive_stack_auth.mjs
apps/stack/scripts/utils/auth/login_ux.mjs
apps/stack/scripts/utils/auth/orchestrated_stack_auth_flow.mjs
apps/stack/scripts/utils/auth/sources.mjs
apps/stack/scripts/utils/auth/stable_scope_id.mjs
apps/stack/scripts/utils/auth/stable_scope_id.test.mjs
apps/stack/scripts/utils/auth/stack_guided_login.mjs
apps/stack/scripts/utils/cli/arg_values.mjs
apps/stack/scripts/utils/cli/arg_values.test.mjs
apps/stack/scripts/utils/cli/args.mjs
apps/stack/scripts/utils/cli/cli.mjs
apps/stack/scripts/utils/cli/cli_registry.mjs
apps/stack/scripts/utils/cli/cwd_scope.mjs
apps/stack/scripts/utils/cli/cwd_scope.test.mjs
apps/stack/scripts/utils/cli/flags.mjs
apps/stack/scripts/utils/cli/log_forwarder.mjs
apps/stack/scripts/utils/cli/normalize.mjs
apps/stack/scripts/utils/cli/prereqs.mjs
apps/stack/scripts/utils/cli/prereqs.test.mjs
apps/stack/scripts/utils/cli/progress.mjs
apps/stack/scripts/utils/cli/progress.test.mjs
apps/stack/scripts/utils/cli/smoke_help.mjs
apps/stack/scripts/utils/cli/verbosity.mjs
apps/stack/scripts/utils/cli/wizard.mjs
apps/stack/scripts/utils/cli/wizard_promptSelect.test.mjs
apps/stack/scripts/utils/cli/wizard_prompt_worktree_source_lazy.test.mjs
apps/stack/scripts/utils/cli/wizard_worktree_slug.test.mjs
apps/stack/scripts/utils/crypto/tokens.mjs
apps/stack/scripts/utils/dev/daemon.mjs
apps/stack/scripts/utils/dev/daemon_watch_resilience.test.mjs
apps/stack/scripts/utils/dev/expo_dev.buildEnv.test.mjs
apps/stack/scripts/utils/dev/expo_dev.mjs
apps/stack/scripts/utils/dev/expo_dev.test.mjs
apps/stack/scripts/utils/dev/expo_dev_restart_port_reservation.test.mjs
apps/stack/scripts/utils/dev/expo_dev_runtime_metadata.test.mjs
apps/stack/scripts/utils/dev/expo_dev_verbose_logs.test.mjs
apps/stack/scripts/utils/dev/resolveDevServerConnection.mjs
apps/stack/scripts/utils/dev/resolveDevServerConnection.test.mjs
apps/stack/scripts/utils/dev/server.mjs
apps/stack/scripts/utils/dev_auth_key.mjs
apps/stack/scripts/utils/edison/git_roots.mjs
apps/stack/scripts/utils/edison/git_roots.test.mjs
apps/stack/scripts/utils/env/config.mjs
apps/stack/scripts/utils/env/dotenv.mjs
apps/stack/scripts/utils/env/dotenv.test.mjs
apps/stack/scripts/utils/env/env.mjs
apps/stack/scripts/utils/env/env_file.mjs
apps/stack/scripts/utils/env/env_file.test.mjs
apps/stack/scripts/utils/env/env_local.mjs
apps/stack/scripts/utils/env/load_env_file.mjs
apps/stack/scripts/utils/env/read.mjs
apps/stack/scripts/utils/env/sandbox.mjs
apps/stack/scripts/utils/env/scrub_env.mjs
apps/stack/scripts/utils/env/scrub_env.test.mjs
apps/stack/scripts/utils/env/values.mjs
apps/stack/scripts/utils/expo/command.mjs
apps/stack/scripts/utils/expo/command_workspace_deps_built.test.mjs
apps/stack/scripts/utils/expo/expo.mjs
apps/stack/scripts/utils/expo/expo_shared_tmpdir.test.mjs
apps/stack/scripts/utils/expo/expo_state_running.test.mjs
apps/stack/scripts/utils/expo/metro_ports.mjs
apps/stack/scripts/utils/expo/metro_ports.test.mjs
apps/stack/scripts/utils/fs/atomic_dir_swap.mjs
apps/stack/scripts/utils/fs/atomic_dir_swap.test.mjs
apps/stack/scripts/utils/fs/file_has_content.mjs
apps/stack/scripts/utils/fs/fs.mjs
apps/stack/scripts/utils/fs/json.mjs
apps/stack/scripts/utils/fs/ops.mjs
apps/stack/scripts/utils/fs/package_json.mjs
apps/stack/scripts/utils/fs/tail.mjs
apps/stack/scripts/utils/git/default_branch.mjs
apps/stack/scripts/utils/git/default_branch.test.mjs
apps/stack/scripts/utils/git/dev_checkout.mjs
apps/stack/scripts/utils/git/dev_checkout.test.mjs
apps/stack/scripts/utils/git/fast_forward_to_remote.mjs
apps/stack/scripts/utils/git/fast_forward_to_remote.test.mjs
apps/stack/scripts/utils/git/git.mjs
apps/stack/scripts/utils/git/parse_name_status_z.mjs
apps/stack/scripts/utils/git/refs.mjs
apps/stack/scripts/utils/git/refs.test.mjs
apps/stack/scripts/utils/git/worktrees.mjs
apps/stack/scripts/utils/git/worktrees_monorepo.test.mjs
apps/stack/scripts/utils/git/worktrees_pathstyle.test.mjs
apps/stack/scripts/utils/llm/assist.mjs
apps/stack/scripts/utils/llm/codex_exec.mjs
apps/stack/scripts/utils/llm/codex_exec.test.mjs
apps/stack/scripts/utils/llm/hstack_runner.mjs
apps/stack/scripts/utils/llm/tools.mjs
apps/stack/scripts/utils/llm/tools.test.mjs
apps/stack/scripts/utils/menubar/swiftbar.mjs
apps/stack/scripts/utils/menubar/swiftbar.test.mjs
apps/stack/scripts/utils/mobile/config.mjs
apps/stack/scripts/utils/mobile/dev_client_install_invocation.mjs
apps/stack/scripts/utils/mobile/dev_client_install_invocation.test.mjs
apps/stack/scripts/utils/mobile/dev_client_links.mjs
apps/stack/scripts/utils/mobile/identifiers.mjs
apps/stack/scripts/utils/mobile/identifiers.test.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.test.mjs
apps/stack/scripts/utils/net/bind_mode.mjs
apps/stack/scripts/utils/net/dns.mjs
apps/stack/scripts/utils/net/lan_ip.mjs
apps/stack/scripts/utils/net/ports.mjs
apps/stack/scripts/utils/net/tcp_forward.mjs
apps/stack/scripts/utils/net/url.mjs
apps/stack/scripts/utils/net/url.test.mjs
apps/stack/scripts/utils/paths/canonical_home.mjs
apps/stack/scripts/utils/paths/canonical_home.test.mjs
apps/stack/scripts/utils/paths/localhost_host.mjs
apps/stack/scripts/utils/paths/localhost_host.test.mjs
apps/stack/scripts/utils/paths/paths.mjs
apps/stack/scripts/utils/paths/paths_env_win32.test.mjs
apps/stack/scripts/utils/paths/paths_monorepo.test.mjs
apps/stack/scripts/utils/paths/paths_server_flavors.test.mjs
apps/stack/scripts/utils/paths/runtime.mjs
apps/stack/scripts/utils/pglite_lock.mjs
apps/stack/scripts/utils/proc/commands.mjs
apps/stack/scripts/utils/proc/ensureWorkspacePackagesBuilt.test.mjs
apps/stack/scripts/utils/proc/exit_cleanup.mjs
apps/stack/scripts/utils/proc/happy_monorepo_deps.mjs
apps/stack/scripts/utils/proc/happy_monorepo_deps.test.mjs
apps/stack/scripts/utils/proc/ownership.mjs
apps/stack/scripts/utils/proc/ownership_killProcessGroupOwnedByStack.test.mjs
apps/stack/scripts/utils/proc/ownership_listPidsWithEnvNeedles.test.mjs
apps/stack/scripts/utils/proc/package_scripts.mjs
apps/stack/scripts/utils/proc/package_scripts.test.mjs
apps/stack/scripts/utils/proc/parallel.mjs
apps/stack/scripts/utils/proc/pids.mjs
apps/stack/scripts/utils/proc/pm.mjs
apps/stack/scripts/utils/proc/pm_spawn.integration.test.mjs
apps/stack/scripts/utils/proc/pm_stack_cache_env.test.mjs
apps/stack/scripts/utils/proc/proc.mjs
apps/stack/scripts/utils/proc/proc.test.mjs
apps/stack/scripts/utils/proc/terminate.mjs
apps/stack/scripts/utils/proc/terminate.test.mjs
apps/stack/scripts/utils/proc/watch.mjs
apps/stack/scripts/utils/review/augment_runner_integration.test.mjs
apps/stack/scripts/utils/review/base_ref.mjs
apps/stack/scripts/utils/review/base_ref.test.mjs
apps/stack/scripts/utils/review/chunks.mjs
apps/stack/scripts/utils/review/chunks.test.mjs
apps/stack/scripts/utils/review/detached_worktree.mjs
apps/stack/scripts/utils/review/detached_worktree.test.mjs
apps/stack/scripts/utils/review/findings.mjs
apps/stack/scripts/utils/review/findings.test.mjs
apps/stack/scripts/utils/review/head_slice.mjs
apps/stack/scripts/utils/review/head_slice.test.mjs
apps/stack/scripts/utils/review/instructions/deep.md
apps/stack/scripts/utils/review/prompts.mjs
apps/stack/scripts/utils/review/prompts.test.mjs
apps/stack/scripts/utils/review/run_reviewers_safe.mjs
apps/stack/scripts/utils/review/run_reviewers_safe.test.mjs
apps/stack/scripts/utils/review/runners/augment.mjs
apps/stack/scripts/utils/review/runners/augment.test.mjs
apps/stack/scripts/utils/review/runners/claude.mjs
apps/stack/scripts/utils/review/runners/claude.test.mjs
apps/stack/scripts/utils/review/runners/coderabbit.mjs
apps/stack/scripts/utils/review/runners/coderabbit.test.mjs
apps/stack/scripts/utils/review/runners/codex.mjs
apps/stack/scripts/utils/review/runners/codex.test.mjs
apps/stack/scripts/utils/review/slice_mode.mjs
apps/stack/scripts/utils/review/slice_mode.test.mjs
apps/stack/scripts/utils/review/sliced_runner.mjs
apps/stack/scripts/utils/review/sliced_runner.test.mjs
apps/stack/scripts/utils/review/slices.mjs
apps/stack/scripts/utils/review/slices.test.mjs
apps/stack/scripts/utils/review/targets.mjs
apps/stack/scripts/utils/review/targets.test.mjs
apps/stack/scripts/utils/review/tool_home_seed.mjs
apps/stack/scripts/utils/review/tool_home_seed.test.mjs
apps/stack/scripts/utils/review/uncommitted_ops.mjs
apps/stack/scripts/utils/review/uncommitted_ops.test.mjs
apps/stack/scripts/utils/sandbox/review_pr_sandbox.mjs
apps/stack/scripts/utils/server/apply_server_light_env_defaults.mjs
apps/stack/scripts/utils/server/flavor_scripts.mjs
apps/stack/scripts/utils/server/flavor_scripts.test.mjs
apps/stack/scripts/utils/server/infra/happy_server_infra.mjs
apps/stack/scripts/utils/server/mobile_api_url.mjs
apps/stack/scripts/utils/server/mobile_api_url.test.mjs
apps/stack/scripts/utils/server/port.mjs
apps/stack/scripts/utils/server/prisma_import.mjs
apps/stack/scripts/utils/server/prisma_import.test.mjs
apps/stack/scripts/utils/server/resolve_stack_server_port.mjs
apps/stack/scripts/utils/server/resolve_stack_server_port.test.mjs
apps/stack/scripts/utils/server/server.mjs
apps/stack/scripts/utils/server/ui_build_check.mjs
apps/stack/scripts/utils/server/ui_build_check.test.mjs
apps/stack/scripts/utils/server/ui_env.mjs
apps/stack/scripts/utils/server/ui_env.test.mjs
apps/stack/scripts/utils/server/urls.mjs
apps/stack/scripts/utils/server/validate.mjs
apps/stack/scripts/utils/server/validate.test.mjs
apps/stack/scripts/utils/service/autostart_darwin.mjs
apps/stack/scripts/utils/service/autostart_darwin.test.mjs
apps/stack/scripts/utils/service/autostart_darwin_keepalive.test.mjs
apps/stack/scripts/utils/service/service_manager.definition.test.mjs
apps/stack/scripts/utils/service/service_manager.mjs
apps/stack/scripts/utils/service/service_manager.plan.test.mjs
apps/stack/scripts/utils/service/service_manager.test.mjs
apps/stack/scripts/utils/service/stack_autostart_resolution.mjs
apps/stack/scripts/utils/service/stack_autostart_resolution.test.mjs
apps/stack/scripts/utils/service/systemd_service_unit.mjs
apps/stack/scripts/utils/service/systemd_service_unit.test.mjs
apps/stack/scripts/utils/service/windows_schtasks_wrapper.mjs
apps/stack/scripts/utils/service/windows_schtasks_wrapper.test.mjs
apps/stack/scripts/utils/setup/child_env.mjs
apps/stack/scripts/utils/setup/child_env.test.mjs
apps/stack/scripts/utils/stack/cli_identities.mjs
apps/stack/scripts/utils/stack/context.mjs
apps/stack/scripts/utils/stack/dirs.mjs
apps/stack/scripts/utils/stack/editor_workspace.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.port_validation.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.remote_validation.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.stack_name_validation.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config_testkit.mjs
apps/stack/scripts/utils/stack/names.mjs
apps/stack/scripts/utils/stack/names.test.mjs
apps/stack/scripts/utils/stack/pr_stack_name.mjs
apps/stack/scripts/utils/stack/runtime_state.mjs
apps/stack/scripts/utils/stack/stacks.mjs
apps/stack/scripts/utils/stack/startup.mjs
apps/stack/scripts/utils/stack/startup_server_light_dirs.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_generate.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_legacy.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_testkit.mjs
apps/stack/scripts/utils/stack/stop.mjs
apps/stack/scripts/utils/stack/terminal_usage_instructions.mjs
apps/stack/scripts/utils/stack/terminal_usage_instructions.test.mjs
apps/stack/scripts/utils/stack_context.mjs
apps/stack/scripts/utils/stack_runtime_state.mjs
apps/stack/scripts/utils/stacks.mjs
apps/stack/scripts/utils/tailscale/ip.mjs
apps/stack/scripts/utils/tauri/stack_overrides.mjs
apps/stack/scripts/utils/test/collect_test_files.mjs
apps/stack/scripts/utils/time/get_today_ymd.mjs
apps/stack/scripts/utils/tui/actions.mjs
apps/stack/scripts/utils/tui/actions.test.mjs
apps/stack/scripts/utils/tui/args.mjs
apps/stack/scripts/utils/tui/args.test.mjs
apps/stack/scripts/utils/tui/child_termination_plan.mjs
apps/stack/scripts/utils/tui/child_termination_plan.test.mjs
apps/stack/scripts/utils/tui/cleanup.mjs
apps/stack/scripts/utils/tui/daemon_auth_notice.mjs
apps/stack/scripts/utils/tui/daemon_auth_notice.test.mjs
apps/stack/scripts/utils/tui/daemon_autostart.mjs
apps/stack/scripts/utils/tui/daemon_autostart.test.mjs
apps/stack/scripts/utils/tui/daemon_pane_reconcile.mjs
apps/stack/scripts/utils/tui/daemon_pane_reconcile.test.mjs
apps/stack/scripts/utils/tui/script_pty_command.mjs
apps/stack/scripts/utils/tui/script_pty_command.test.mjs
apps/stack/scripts/utils/tui/stack_scope_env.mjs
apps/stack/scripts/utils/tui/stack_scope_env.test.mjs
apps/stack/scripts/utils/tui/stdin_handoff.mjs
apps/stack/scripts/utils/tui/stdin_handoff.test.mjs
apps/stack/scripts/utils/tui/summary_env.mjs
apps/stack/scripts/utils/tui/summary_env.test.mjs
apps/stack/scripts/utils/ui/ansi.mjs
apps/stack/scripts/utils/ui/box_line.mjs
apps/stack/scripts/utils/ui/box_line.test.mjs
apps/stack/scripts/utils/ui/browser.mjs
apps/stack/scripts/utils/ui/browser.test.mjs
apps/stack/scripts/utils/ui/clipboard.mjs
apps/stack/scripts/utils/ui/layout.mjs
apps/stack/scripts/utils/ui/qr.mjs
apps/stack/scripts/utils/ui/terminal_launcher.mjs
apps/stack/scripts/utils/ui/text.mjs
apps/stack/scripts/utils/ui/ui_export_env.mjs
apps/stack/scripts/utils/ui/ui_export_env.test.mjs
apps/stack/scripts/utils/update/auto_update_notice.mjs
apps/stack/scripts/utils/validate.mjs
apps/stack/scripts/utils/worktrees/reflink_copy_dir.mjs
apps/stack/scripts/utils/worktrees/seed_node_modules.mjs
apps/stack/scripts/utils/worktrees/seed_node_modules.test.mjs
apps/stack/scripts/utils/worktrees/yarn_install_guard.mjs
apps/stack/scripts/utils/worktrees/yarn_install_guard.test.mjs
apps/stack/scripts/worktrees_archive_cmd.integration.test.mjs
apps/stack/tests/testkit/remote_daemon_setup_testkit.mjs
apps/stack/tests/testkit/remote_server_setup_testkit.mjs
apps/stack/tests/testkit/self_update_testkit.mjs
apps/stack/tests/testkit/tempdir_testkit.mjs
```

### Unit/Integration — packages/relay-server (node:test) (count: 8)

```text
packages/relay-server/package.json
packages/relay-server/scripts/bundleWorkspaceDeps.mjs
packages/relay-server/scripts/bundleWorkspaceDeps.test.mjs
packages/relay-server/src/checksums.test.mjs
packages/relay-server/src/minisign.verify.test.mjs
packages/relay-server/src/releaseAssets.test.mjs
packages/relay-server/src/runnerConfig.test.mjs
packages/relay-server/src/target.test.mjs
```

### Unit — packages/cli-common (node:test) (count: 11)

```text
packages/cli-common/package.json
packages/cli-common/tests/exports.test.mjs
packages/cli-common/tests/links.test.mjs
packages/cli-common/tests/providers.test.mjs
packages/cli-common/tests/service.test.mjs
packages/cli-common/tests/tailscale.serveStatus.test.mjs
packages/cli-common/tests/update.test.mjs
packages/cli-common/tests/vendorBundledPackageRuntimeDependencies.test.mjs
packages/cli-common/tests/workspaces.test.mjs
packages/cli-common/tsconfig.json
scripts/postinstall/shouldRunPostinstall.cjs
```

### Unit — packages/release-runtime (node:test) (count: 8)

```text
packages/release-runtime/package.json
packages/release-runtime/tests/assets.test.mjs
packages/release-runtime/tests/extractPlan.test.mjs
packages/release-runtime/tests/github.test.mjs
packages/release-runtime/tests/minisign.test.mjs
packages/release-runtime/tests/verifiedDownload.test.mjs
packages/release-runtime/tsconfig.json
scripts/postinstall/shouldRunPostinstall.cjs
```

### Release Contracts — scripts/release (node:test) (count: 292)

```text
.daggerignore
.github/actions/bootstrap-minisign/bootstrap-minisign.sh
.github/feature-policy/preview.json
.github/feature-policy/production.json
.github/workflows/build-tauri.yml
.github/workflows/build-ui-mobile-local.yml
.github/workflows/deploy.yml
.github/workflows/promote-branch.yml
.github/workflows/promote-docs.yml
.github/workflows/promote-server.yml
.github/workflows/promote-ui.yml
.github/workflows/promote-website.yml
.github/workflows/publish-docker.yml
.github/workflows/publish-github-release.yml
.github/workflows/publish-server-runtime.yml
.github/workflows/publish-ui-release.yml
.github/workflows/publish-ui-web.yml
.github/workflows/release.yml
apps/cli/package.json
apps/stack/scripts/remote_cmd.mjs
apps/ui/eas.json
apps/ui/tools/tauri/make-latest-json.mjs
apps/website/public/happier-release.pub
apps/website/public/install
apps/website/public/install-preview
apps/website/public/install-preview.ps1
apps/website/public/install-preview.sh
apps/website/public/install-server
apps/website/public/install-server.sh
apps/website/public/install.ps1
apps/website/public/install.sh
apps/website/public/self-host
apps/website/public/self-host-preview
apps/website/public/self-host-preview.ps1
apps/website/public/self-host-preview.sh
apps/website/public/self-host.ps1
apps/website/public/self-host.sh
dagger/src/index.ts
package.json
packages/protocol/scripts/generate-embedded-feature-policies.mjs
scripts/pipeline/checks/lib/checks-profile.mjs
scripts/pipeline/deploy/trigger-webhooks.mjs
scripts/pipeline/docker/assert-docker-can-run-linux-amd64.mjs
scripts/pipeline/docker/resolve-build-args.mjs
scripts/pipeline/docker/resolve-build-args.test.mjs
scripts/pipeline/expo/download-android-apk.mjs
scripts/pipeline/expo/eas-local-build-env.mjs
scripts/pipeline/expo/ensure-asc-api-key-file.mjs
scripts/pipeline/expo/native-build.mjs
scripts/pipeline/expo/publish-apk-release.mjs
scripts/pipeline/expo/rewrite-eas-local-build-artifact-path.mjs
scripts/pipeline/expo/sentry-upload-sourcemaps.mjs
scripts/pipeline/expo/sentry-upload-sourcemaps.test.mjs
scripts/pipeline/expo/stage-repo-for-dagger.mjs
scripts/pipeline/github/audit-release-assets.mjs
scripts/pipeline/github/commit-and-push.mjs
scripts/pipeline/github/lib/gh-release-commands.mjs
scripts/pipeline/github/promote-branch.mjs
scripts/pipeline/github/resolve-github-repo-slug.mjs
scripts/pipeline/npm/publish-tarball.mjs
scripts/pipeline/npm/release-packages.mjs
scripts/pipeline/npm/set-preview-versions.mjs
scripts/pipeline/release/build-cli-binaries.mjs
scripts/pipeline/release/build-hstack-binaries.mjs
scripts/pipeline/release/build-server-binaries.mjs
scripts/pipeline/release/build-ui-web-bundle.mjs
scripts/pipeline/release/bump-version.mjs
scripts/pipeline/release/bump-versions-dev.mjs
scripts/pipeline/release/component-registry.mjs
scripts/pipeline/release/compute-changed-components.mjs
scripts/pipeline/release/compute-deploy-plan.mjs
scripts/pipeline/release/lib/binary-release.mjs
scripts/pipeline/release/lib/manifests.mjs
scripts/pipeline/release/lib/rolling-release-notes.mjs
scripts/pipeline/release/lib/ui-web-bundle.mjs
scripts/pipeline/release/publish-cli-binaries.mjs
scripts/pipeline/release/publish-hstack-binaries.mjs
scripts/pipeline/release/publish-manifests.mjs
scripts/pipeline/release/publish-server-runtime.mjs
scripts/pipeline/release/publish-ui-web.mjs
scripts/pipeline/release/resolve-bump-plan.mjs
scripts/pipeline/release/sync-installers.mjs
scripts/pipeline/release/verify-artifacts.mjs
scripts/pipeline/run.mjs
scripts/pipeline/smoke/cli-smoke.mjs
scripts/pipeline/tauri/build-updater-artifacts.mjs
scripts/pipeline/tauri/collect-updater-artifacts.mjs
scripts/pipeline/tauri/ensure-signing-key-file.mjs
scripts/pipeline/tauri/notarize-macos-artifacts.mjs
scripts/pipeline/tauri/prepare-publish-assets.mjs
scripts/pipeline/tauri/validate-updater-pubkey.mjs
scripts/pipeline/testing/create-auth-credentials.mjs
scripts/release/.DS_Store
scripts/release/binary_release_package_entries.test.mjs
scripts/release/binary_release_pm_resolution.test.mjs
scripts/release/binary_release_targets.test.mjs
scripts/release/bootstrap_minisign_script.contract.test.mjs
scripts/release/build_tauri_artifact_names.contract.test.mjs
scripts/release/build_tauri_release_tags.workflow.contract.test.mjs
scripts/release/build_tauri_workflow.production_signing_gate.test.mjs
scripts/release/build_ui_mobile_local_passes_apple_api_private_key.workflow.contract.test.mjs
scripts/release/build_ui_mobile_local_uses_ui_mobile_release.workflow.contract.test.mjs
scripts/release/bump-version.server_runner.test.mjs
scripts/release/checks_profile_plan.contract.test.mjs
scripts/release/cli_build_uses_npx_pkgroll.contract.test.mjs
scripts/release/componentRegistry.test.mjs
scripts/release/compute-changed-components.test.mjs
scripts/release/dagger_daggerignore.contract.test.mjs
scripts/release/dagger_expo_android_local_build.contract.test.mjs
scripts/release/deploy_trigger_webhooks_script.contract.test.mjs
scripts/release/deploy_workflow.inputs_contract.test.mjs
scripts/release/deploy_workflow_push_caller.contract.test.mjs
scripts/release/deploy_workflow_uses_trigger_webhooks_script.contract.test.mjs
scripts/release/docker_publish.workflow.contract.test.mjs
scripts/release/eas_local_build_env.contract.test.mjs
scripts/release/eas_submit_android_tracks_configured.contract.test.mjs
scripts/release/eas_submit_preview_profile_configured.contract.test.mjs
scripts/release/ensure_asc_api_key_file.test.mjs
scripts/release/feature_policy_embedding.contract.test.mjs
scripts/release/gh_release_edit_args.contract.test.mjs
scripts/release/installers/happier-release.pub
scripts/release/installers/install-server
scripts/release/installers/install-server.sh
scripts/release/installers/install.ps1
scripts/release/installers/install.sh
scripts/release/installers/self-host.ps1
scripts/release/installers/self-host.sh
scripts/release/installers_asset_lookup_robustness.test.mjs
scripts/release/installers_cli_actions.test.mjs
scripts/release/installers_cli_etxtbsy_atomic_swap.test.mjs
scripts/release/installers_daemon_autostart.test.mjs
scripts/release/installers_default_channel_preview.test.mjs
scripts/release/installers_minisign_bootstrap_arch.test.mjs
scripts/release/installers_no_github_token.test.mjs
scripts/release/installers_path_update_guidance.test.mjs
scripts/release/installers_published_sync.test.mjs
scripts/release/installers_security.test.mjs
scripts/release/installers_self_host_actions.test.mjs
scripts/release/installers_self_host_channel_flag.test.mjs
scripts/release/installers_self_host_runtime_smoke.test.mjs
scripts/release/installers_self_host_tar_noise_and_guidance.test.mjs
scripts/release/installers_sync.test.mjs
scripts/release/installers_verbose_mode.contract.test.mjs
scripts/release/installers_windows_default_channel_preview.test.mjs
scripts/release/manifests.test.mjs
scripts/release/minisign_key_resolution.test.mjs
scripts/release/npm_e2e_smoke.contract.test.mjs
scripts/release/npm_release_run_tests_auto_defaults.contract.test.mjs
scripts/release/pipeline_checks_release_assets_e2e.contract.test.mjs
scripts/release/pipeline_deploy_cli.contract.test.mjs
scripts/release/pipeline_docker_amd64_emulation_hint.contract.test.mjs
scripts/release/pipeline_docker_publish.contract.test.mjs
scripts/release/pipeline_docker_publish_buildx_builder.contract.test.mjs
scripts/release/pipeline_docker_publish_cli.contract.test.mjs
scripts/release/pipeline_docker_publish_ghcr_uses_gh_cli.contract.test.mjs
scripts/release/pipeline_docker_publish_recovers_from_docker_down_on_macos.contract.test.mjs
scripts/release/pipeline_docker_publish_resolves_sha.contract.test.mjs
scripts/release/pipeline_docker_publish_retries_transient_failures.contract.test.mjs
scripts/release/pipeline_env_parse_dotenv_multiline.contract.test.mjs
scripts/release/pipeline_expo_dagger_staging_excludes.contract.test.mjs
scripts/release/pipeline_expo_dagger_staging_hardlink.contract.test.mjs
scripts/release/pipeline_expo_download_apk_cli.contract.test.mjs
scripts/release/pipeline_expo_download_apk_dry_run_missing_json.contract.test.mjs
scripts/release/pipeline_expo_native_build_cli.contract.test.mjs
scripts/release/pipeline_expo_native_build_cli_local_mode.contract.test.mjs
scripts/release/pipeline_expo_native_build_dagger_rewrites_artifact_path.contract.test.mjs
scripts/release/pipeline_expo_native_build_dagger_runtime.contract.test.mjs
scripts/release/pipeline_expo_native_build_ios_local_requires_fastlane.contract.test.mjs
scripts/release/pipeline_expo_native_build_ios_local_sets_utf8_locale.contract.test.mjs
scripts/release/pipeline_expo_native_build_local.contract.test.mjs
scripts/release/pipeline_expo_ota_cli.contract.test.mjs
scripts/release/pipeline_expo_publish_apk_release_cli.contract.test.mjs
scripts/release/pipeline_expo_submit_cli.contract.test.mjs
scripts/release/pipeline_expo_submit_interactive_auth.contract.test.mjs
scripts/release/pipeline_expo_submit_ios_asc_key.contract.test.mjs
scripts/release/pipeline_expo_submit_ios_bundle_mismatch.contract.test.mjs
scripts/release/pipeline_expo_submit_missing_path.contract.test.mjs
scripts/release/pipeline_expo_submit_path.contract.test.mjs
scripts/release/pipeline_expo_submit_path_cli.contract.test.mjs
scripts/release/pipeline_expo_submit_preview_allow_failure.contract.test.mjs
scripts/release/pipeline_expo_submit_profile_cli.contract.test.mjs
scripts/release/pipeline_git_clean_worktree.test.mjs
scripts/release/pipeline_github_audit_release_assets.contract.test.mjs
scripts/release/pipeline_github_commit_and_push.contract.test.mjs
scripts/release/pipeline_github_publish_release_cli.contract.test.mjs
scripts/release/pipeline_github_publish_release_local.contract.test.mjs
scripts/release/pipeline_help.contract.test.mjs
scripts/release/pipeline_npm_publish_cli.contract.test.mjs
scripts/release/pipeline_npm_publish_provenance_env.contract.test.mjs
scripts/release/pipeline_npm_publish_provenance_override.contract.test.mjs
scripts/release/pipeline_npm_publish_tarball.contract.test.mjs
scripts/release/pipeline_npm_release_cli.contract.test.mjs
scripts/release/pipeline_npm_release_pack_only_cli.contract.test.mjs
scripts/release/pipeline_npm_set_preview_versions_script.contract.test.mjs
scripts/release/pipeline_npm_set_preview_versions_write_false.contract.test.mjs
scripts/release/pipeline_promote_branch_cli.contract.test.mjs
scripts/release/pipeline_promote_branch_script.test.mjs
scripts/release/pipeline_promote_deploy_branch_cli.contract.test.mjs
scripts/release/pipeline_publish_binary_releases_cli.contract.test.mjs
scripts/release/pipeline_publish_server_runtime_cli.contract.test.mjs
scripts/release/pipeline_publish_ui_web_cli.contract.test.mjs
scripts/release/pipeline_release_bump_plan_cli.contract.test.mjs
scripts/release/pipeline_release_bump_plan_script.contract.test.mjs
scripts/release/pipeline_release_bump_versions_dev_cli.contract.test.mjs
scripts/release/pipeline_release_bump_versions_dev_script.contract.test.mjs
scripts/release/pipeline_release_cli.contract.test.mjs
scripts/release/pipeline_release_cli_preview_publishers.contract.test.mjs
scripts/release/pipeline_release_cli_with_npm.contract.test.mjs
scripts/release/pipeline_release_deploy_plan_script.contract.test.mjs
scripts/release/pipeline_release_npm_packages.contract.test.mjs
scripts/release/pipeline_release_npm_packages_pack_only.contract.test.mjs
scripts/release/pipeline_release_preview_publishes_binary_releases.contract.test.mjs
scripts/release/pipeline_release_wrapped_release_scripts_cli.contract.test.mjs
scripts/release/pipeline_run_github_audit_release_assets.contract.test.mjs
scripts/release/pipeline_run_github_commit_and_push.contract.test.mjs
scripts/release/pipeline_run_npm_set_preview_versions.contract.test.mjs
scripts/release/pipeline_run_release_wrapped_passthrough.contract.test.mjs
scripts/release/pipeline_run_smoke_cli.contract.test.mjs
scripts/release/pipeline_run_tauri_build_steps.contract.test.mjs
scripts/release/pipeline_run_tauri_validate_updater_pubkey.contract.test.mjs
scripts/release/pipeline_run_testing_create_auth_credentials.contract.test.mjs
scripts/release/pipeline_smoke_cli.contract.test.mjs
scripts/release/pipeline_tauri_build_updater_artifacts.contract.test.mjs
scripts/release/pipeline_tauri_collect_updater_artifacts.contract.test.mjs
scripts/release/pipeline_tauri_notarize_macos_artifacts.contract.test.mjs
scripts/release/pipeline_tauri_prepare_assets_cli.contract.test.mjs
scripts/release/pipeline_testing_create_auth_credentials_script.test.mjs
scripts/release/pipeline_ui_mobile_release_cli.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_environment_profile_guard.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_local_build_mode.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_publish_apk_auto.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_skip_apk_release.contract.test.mjs
scripts/release/promote_branch.workflow.contract.test.mjs
scripts/release/promote_docs_deploy_branch.workflow.contract.test.mjs
scripts/release/promote_server_deploy_branch.workflow.contract.test.mjs
scripts/release/promote_server_runtime_release.workflow.contract.test.mjs
scripts/release/promote_ui_deploy_branch.workflow.contract.test.mjs
scripts/release/promote_ui_mobile_tags.workflow.contract.test.mjs
scripts/release/promote_website_deploy_branch.workflow.contract.test.mjs
scripts/release/publish-manifests.signature.test.mjs
scripts/release/publish_cli_binaries_version_tags.contract.test.mjs
scripts/release/publish_github_release.workflow.contract.test.mjs
scripts/release/publish_hstack_binaries_version_tags.contract.test.mjs
scripts/release/publish_run_contracts_auto_defaults.contract.test.mjs
scripts/release/publish_server_runtime.workflow.contract.test.mjs
scripts/release/publish_server_runtime_version_tags.contract.test.mjs
scripts/release/publish_ui_web.workflow.contract.test.mjs
scripts/release/publish_ui_web_version_tags.contract.test.mjs
scripts/release/relay_server_publish_config.contract.test.mjs
scripts/release/release-assets-e2e/Dockerfile
scripts/release/release-assets-e2e/Dockerfile.remote-host
scripts/release/release-assets-e2e/Dockerfile.remote-host-systemd
scripts/release/release-assets-e2e/README.md
scripts/release/release-assets-e2e/bin/cli-smoke.sh
scripts/release/release-assets-e2e/bin/cli2-smoke.sh
scripts/release/release-assets-e2e/bin/remote-daemon-authenticated-cli-smoke.sh
scripts/release/release-assets-e2e/bin/remote-daemon-smoke.sh
scripts/release/release-assets-e2e/bin/remote-host-entrypoint.sh
scripts/release/release-assets-e2e/bin/remote-host-systemd-entrypoint.sh
scripts/release/release-assets-e2e/bin/remote-server-smoke.sh
scripts/release/release-assets-e2e/bin/stack-entrypoint.sh
scripts/release/release-assets-e2e/bin/terminal-auth-approve.cjs
scripts/release/release-assets-e2e/compose.dockerhub.yml
scripts/release/release-assets-e2e/compose.local-monorepo.yml
scripts/release/release-assets-e2e/compose.remote.yml
scripts/release/release-assets-e2e/compose.yml
scripts/release/release-assets-e2e/prepare-local-monorepo.mjs
scripts/release/release-assets-e2e/prepare-local-monorepo.test.mjs
scripts/release/release-assets-e2e/run.sh
scripts/release/release-assets-e2e/run_help.test.mjs
scripts/release/release_actor_guard_action.contract.test.mjs
scripts/release/release_dev_to_main_workflow.inputs_contract.test.mjs
scripts/release/release_local_orchestrator_logic.contract.test.mjs
scripts/release/release_orchestrator_preview.contract.test.mjs
scripts/release/release_titles.workflow.contract.test.mjs
scripts/release/rolling_release_notes.contract.test.mjs
scripts/release/server_postinstall_runner.contract.test.mjs
scripts/release/tauri_signing_key_file.test.mjs
scripts/release/tauri_validate_updater_pubkey_script.test.mjs
scripts/release/tests_workflow.binary_smoke_timeout.contract.test.mjs
scripts/release/tests_workflow.daemon_e2e_lane.contract.test.mjs
scripts/release/tests_workflow.installers_preview_smoke.contract.test.mjs
scripts/release/tests_workflow.installers_smoke.contract.test.mjs
scripts/release/tests_workflow.self_host_daemon.contract.test.mjs
scripts/release/ui_eas_apk_profiles.contract.test.mjs
scripts/release/ui_postinstall_runner.contract.test.mjs
scripts/release/ui_web_bundle.test.mjs
scripts/release/workflow_node_version_policy.contract.test.mjs
scripts/release/workflow_pipeline_prereqs.contract.test.mjs
scripts/release/workflow_secret_hardening.contract.test.mjs
scripts/release/workflows_node_script_paths.contract.test.mjs
scripts/release/workspaces.contract.test.mjs
```

### Website — apps/website (count: 3)

```text
apps/website/index.release.html
apps/website/package.json
apps/website/tests/index.release.test.js
```


---

## Appendix B — Hotspot index (derived mechanically from tracker fields)

This appendix is generated from the per-file tracker analyses. It is intentionally mechanical (pattern-based), so it may include some false positives, but it is designed to ensure we do not miss work.

**Flags:**
- `UNWIRED`: tracker text contains “unwired” or “dead”
- `BRITTLE_HIGH`: tracker includes “Brittleness risks: high” (or “very high”)
- `SLOW_HIGH`: tracker includes “Speed/flakiness risks: high” (or “very high”)
- `DUPLICATION`: tracker “Duplication candidates” field exists and is not “none”


### Shared infra reviews (completed)

- Total audited files: 29
- UNWIRED: 1
- BRITTLE_HIGH: 5
- SLOW_HIGH: 7
- DUPLICATION: 29

**UNWIRED**

```text
packages/tests/vitest.core.config.ts
```

**BRITTLE_HIGH**

```text
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-extended-db-docker.mjs
apps/ui/sources/dev/vitestSetup.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
```

**SLOW_HIGH**

```text
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
```

**DUPLICATION**

```text
scripts/testing/featureTestGating.ts
vitest.config.ts
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
apps/stack/scripts/test_ci.mjs
apps/stack/scripts/test_integration.mjs
apps/stack/scripts/utils/test/collect_test_files.mjs
apps/cli/src/test-setup.ts
apps/cli/src/vitestSetup.ts
apps/ui/sources/dev/vitestSetup.ts
apps/ui/vitest.config.ts
apps/ui/vitest.integration.config.ts
apps/cli/vitest.config.ts
apps/cli/vitest.integration.config.ts
apps/cli/vitest.slow.config.ts
apps/server/vitest.config.ts
apps/server/vitest.integration.config.ts
apps/server/vitest.dbcontract.config.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
packages/tests/playwright.ui.config.mjs
```

### Unassigned test-like files (inventory gap)

- Total audited files: 4
- UNWIRED: 4
- BRITTLE_HIGH: 0
- SLOW_HIGH: 0
- DUPLICATION: 4

**UNWIRED**

```text
apps/cli/scripts/prepack-script.test.mjs
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
```

**DUPLICATION**

```text
apps/cli/scripts/prepack-script.test.mjs
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
```

### CI wiring review (completed)

- Total audited files: 15
- UNWIRED: 1
- BRITTLE_HIGH: 5
- SLOW_HIGH: 3
- DUPLICATION: 15

**UNWIRED**

```text
apps/stack/.github/workflows/typecheck.yml
```

**BRITTLE_HIGH**

```text
.github/workflows/tests.yml
.github/workflows/issue-triage-manual.yml
.github/workflows/issue-triage.yml
.github/workflows/release-npm.yml
.github/workflows/roadmap-add-to-project.yml
```

**SLOW_HIGH**

```text
.github/workflows/extended-db-tests.yml
.github/workflows/stress-tests.yml
.github/workflows/release-npm.yml
```

**DUPLICATION**

```text
.github/workflows/tests.yml
.github/workflows/extended-db-tests.yml
.github/workflows/providers-contracts.yml
.github/workflows/stress-tests.yml
apps/stack/.github/workflows/typecheck.yml
.github/workflows/cli-smoke-test.yml
.github/workflows/deploy-on-deploy-branch.yml
.github/workflows/issue-triage-manual.yml
.github/workflows/issue-triage.yml
.github/workflows/release-actor-guard.yml
.github/workflows/release-npm.yml
.github/workflows/release-verify.yml
.github/workflows/roadmap-add-to-project.yml
.github/workflows/roadmap-bootstrap-labels.yml
.github/workflows/tests-dispatch.yml
```

### Unit — packages/protocol (Vitest)

- Total audited files: 114
- UNWIRED: 0
- BRITTLE_HIGH: 32
- SLOW_HIGH: 0
- DUPLICATION: 99

**BRITTLE_HIGH**

```text
packages/protocol/src/actions/actionSpecs.test.ts
packages/protocol/src/executionRuns.test.ts
packages/protocol/src/features.payload.test.ts
packages/protocol/src/scmPolicy.test.ts
packages/protocol/src/sessionControl/contract.test.ts
packages/tests/baselines/session-control/auth_status.ok.json
packages/tests/baselines/session-control/server_add.ok.json
packages/tests/baselines/session-control/server_current.ok.json
packages/tests/baselines/session-control/server_list.ok.json
packages/tests/baselines/session-control/server_remove.ok.json
packages/tests/baselines/session-control/server_set.ok.json
packages/tests/baselines/session-control/server_test.ok.json
packages/tests/baselines/session-control/server_use.ok.json
packages/tests/baselines/session-control/session_actions_describe.ok.json
packages/tests/baselines/session-control/session_actions_list.ok.json
packages/tests/baselines/session-control/session_create.ok.json
packages/tests/baselines/session-control/session_history.ok.json
packages/tests/baselines/session-control/session_list.ok.json
packages/tests/baselines/session-control/session_run_action.ok.json
packages/tests/baselines/session-control/session_run_get.ok.json
packages/tests/baselines/session-control/session_run_list.ok.json
packages/tests/baselines/session-control/session_run_send.ok.json
packages/tests/baselines/session-control/session_run_start.ok.json
packages/tests/baselines/session-control/session_run_stop.ok.json
packages/tests/baselines/session-control/session_run_stream_cancel.ok.json
packages/tests/baselines/session-control/session_run_stream_read.ok.json
packages/tests/baselines/session-control/session_run_stream_start.ok.json
packages/tests/baselines/session-control/session_run_wait.ok.json
packages/tests/baselines/session-control/session_send.ok.json
packages/tests/baselines/session-control/session_status.ok.json
packages/tests/baselines/session-control/session_stop.ok.json
packages/tests/baselines/session-control/session_wait.ok.json
```

**DUPLICATION**

```text
packages/protocol/scripts/generate-embedded-feature-policies.mjs
.github/feature-policy/preview.json
.github/feature-policy/production.json
packages/protocol/src/features/embeddedFeaturePolicies.generated.ts
packages/protocol/src/account/settings/accountSettingsStoredContentEnvelope.test.ts
packages/protocol/src/features/payload/capabilities/encryptionCapabilities.test.ts
packages/protocol/src/storage/storedJsonContentEnvelope.test.ts
packages/protocol/src/account/profile.connectedServicesV2.test.ts
packages/protocol/src/account/settings/accountSettings.test.ts
packages/protocol/src/actions/actionDraftSeed.test.ts
packages/protocol/src/actions/actionExecutor.inventory.test.ts
packages/protocol/src/actions/actionExecutor.memory.test.ts
packages/protocol/src/actions/actionExecutor.reviewStart.test.ts
packages/protocol/src/actions/actionIds.test.ts
packages/protocol/src/actions/actionInputElevenLabsToolSchema.test.ts
packages/protocol/src/actions/actionInputHintsRuntime.test.ts
packages/protocol/src/actions/actionInputJsonSchema.test.ts
packages/protocol/src/actions/actionSettings.test.ts
packages/protocol/src/actions/actionSpecs.test.ts
packages/protocol/src/bugReports.fallback.test.ts
packages/protocol/src/bugReports.reporter.test.ts
packages/protocol/src/bugReports.similarIssues.test.ts
packages/protocol/src/bugReports.submit.test.ts
packages/protocol/src/changes.automation.test.ts
packages/protocol/src/common/asyncTtlCache.test.ts
packages/protocol/src/common/probedResourceCache.test.ts
packages/protocol/src/connect/connectedServiceErrors.test.ts
packages/protocol/src/connect/connectedServiceQuotaSnapshot.test.ts
packages/protocol/src/connect/connectedServiceSchemas.test.ts
packages/protocol/src/crypto/accountScopedCipher.test.ts
packages/protocol/src/crypto/boxBundle.test.ts
packages/protocol/src/crypto/encryptedDataKeyEnvelopeV1.test.ts
packages/protocol/src/crypto/terminalProvisioningV2.test.ts
packages/protocol/src/daemonExecutionRuns.test.ts
packages/protocol/src/diagnostics/doctorSnapshot.test.ts
packages/protocol/src/env/parseBooleanEnv.test.ts
packages/protocol/src/esmImportCycle.test.ts
packages/protocol/src/executionRuns.streaming.test.ts
packages/protocol/src/executionRuns.test.ts
packages/protocol/src/features.payload.test.ts
packages/protocol/src/features/buildPolicy.test.ts
packages/protocol/src/features/catalog.test.ts
packages/protocol/src/features/decision.test.ts
packages/protocol/src/features/embeddedFeaturePolicy.test.ts
packages/protocol/src/features/featureDecisionEngine.test.ts
packages/protocol/src/features/serverEnabledBit.test.ts
packages/protocol/src/index.exports.test.ts
packages/protocol/src/installables.test.ts
packages/protocol/src/memory/memorySearch.test.ts
packages/protocol/src/memory/memorySettings.test.ts
packages/protocol/src/reviews/reviewEngines.test.ts
packages/protocol/src/reviews/reviewStart.test.ts
packages/protocol/src/rpc.daemonExecutionRuns.test.ts
packages/protocol/src/rpc.executionRuns.test.ts
packages/protocol/src/rpc.memory.test.ts
packages/protocol/src/rpc.scm.test.ts
packages/protocol/src/rpc.sessionReplay.test.ts
packages/protocol/src/rpcErrors.test.ts
packages/protocol/src/scm.contract.test.ts
packages/protocol/src/scmCapabilities.test.ts
packages/protocol/src/scmPathScope.test.ts
packages/protocol/src/scmPolicy.test.ts
packages/protocol/src/serverControl/contract.test.ts
packages/protocol/src/sessionContinueWithReplay.test.ts
packages/protocol/src/sessionControl/baselines.test.ts
packages/protocol/src/sessionControl/contract.test.ts
packages/protocol/src/sessionMessages/sessionMessageMeta.test.ts
packages/protocol/src/sessionMessages/sessionStoredMessageContent.test.ts
packages/protocol/src/sessionMetadata/metadataOverridesV1.test.ts
packages/protocol/src/sessionMetadata/terminalMetadata.test.ts
packages/protocol/src/structuredMessages/sessionSummaryShardV1.test.ts
packages/protocol/src/updates.automation.test.ts
packages/protocol/src/updates.sharing.test.ts
packages/protocol/src/voiceActions.test.ts
packages/protocol/package.json
packages/tests/baselines/session-control/auth_status.ok.json
packages/tests/baselines/session-control/server_add.ok.json
packages/tests/baselines/session-control/server_current.ok.json
packages/tests/baselines/session-control/server_list.ok.json
packages/tests/baselines/session-control/server_remove.ok.json
packages/tests/baselines/session-control/server_set.ok.json
packages/tests/baselines/session-control/server_use.ok.json
packages/tests/baselines/session-control/session_actions_describe.ok.json
packages/tests/baselines/session-control/session_actions_list.ok.json
packages/tests/baselines/session-control/session_create.ok.json
packages/tests/baselines/session-control/session_history.ok.json
packages/tests/baselines/session-control/session_list.ok.json
packages/tests/baselines/session-control/session_run_action.ok.json
packages/tests/baselines/session-control/session_run_get.ok.json
packages/tests/baselines/session-control/session_run_list.ok.json
packages/tests/baselines/session-control/session_run_start.ok.json
packages/tests/baselines/session-control/session_run_stream_cancel.ok.json
packages/tests/baselines/session-control/session_run_stream_read.ok.json
packages/tests/baselines/session-control/session_run_stream_start.ok.json
packages/tests/baselines/session-control/session_run_wait.ok.json
packages/tests/baselines/session-control/session_send.ok.json
packages/tests/baselines/session-control/session_status.ok.json
packages/tests/baselines/session-control/session_wait.ok.json
packages/protocol/src/features/payload/capabilities/capabilitiesSchema.server.test.ts
```

### Unit — packages/agents (Vitest via repo-root vitest.config.ts)

- Total audited files: 7
- UNWIRED: 0
- BRITTLE_HIGH: 0
- SLOW_HIGH: 0
- DUPLICATION: 7

**DUPLICATION**

```text
packages/agents/src/providers/cliInstallSpecs.spec.ts
packages/agents/src/sessionControls/publish.spec.ts
packages/agents/src/sessions/replay/happierReplayPrompt.spec.ts
packages/agents/src/voice/voiceAgentPrompt.spec.ts
packages/agents/package.json
scripts/testing/featureTestGating.ts
vitest.config.ts
```

### Unit — apps/ui (Vitest)

- Total audited files: 1159
- UNWIRED: 8
- BRITTLE_HIGH: 150
- SLOW_HIGH: 4
- DUPLICATION: 1070

**UNWIRED**

```text
apps/ui/sources/sync/api/social/apiFriends.githubRequired.feat.social.friends.test.ts
apps/ui/sources/sync/domains/features/featureDecisionRuntime.feat.voice.agent.test.ts
apps/ui/sources/sync/engine/social/syncFriends.feat.social.friends.test.ts
apps/ui/sources/sync/reducer/reducer.spec.ts
apps/ui/sources/dev/testRunner.ts
apps/ui/sources/sync/__testdata__/trace_0.json
apps/ui/sources/sync/__testdata__/trace_1.json
apps/ui/sources/sync/__testdata__/trace_2.json
```

**BRITTLE_HIGH**

```text
apps/ui/sources/__tests__/app/home.externalAuthStart.spec.tsx
apps/ui/sources/components/account/restore/RestoreScanComputerQrView.featureDisabled.spec.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.permissionRequestLocation.test.tsx
apps/ui/sources/components/sessions/files/content/ChangedFilesReview.flashListExtraData.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.pinOnContentChange.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.unpinnedNoWheel.test.tsx
apps/ui/sources/components/settings/SettingsView.connectTerminal.native.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerSettingsScreenController.canonicalUrlAdoption.test.tsx
apps/ui/sources/components/tools/shell/views/timeline/ToolTimelineRowHeader.test.tsx
apps/ui/sources/hooks/session/useUserMessageHistory.navigatorStability.test.tsx
apps/ui/sources/sync/store/hooks.useMessagesByIds.test.tsx
apps/ui/sources/sync/store/hooks.useSessionMessages.test.tsx
apps/ui/sources/voice/output/playAudioBytesWithStopper.spec.ts
apps/ui/sources/voice/output/speakAssistantText.spec.ts
apps/ui/sources/__tests__/app/_layout.test.ts
apps/ui/sources/__tests__/app/machine/machineDetails.capabilitiesRequestStability.test.ts
apps/ui/sources/__tests__/app/machine/machineDetails.executionRuns.test.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.serverIdSwitch.test.tsx
apps/ui/sources/__tests__/app/new/pick/machine.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.stackOptionsStability.test.ts
apps/ui/sources/__tests__/app/new/pick/profile-edit.headerButtons.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.setOptionsLoop.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.stackOptionsStability.test.ts
apps/ui/sources/__tests__/voice/settings/localDirectSection.unhandledRejection.test.tsx
apps/ui/sources/agents/prompt/systemPrompt.test.ts
apps/ui/sources/agents/registry/registryCore.test.ts
apps/ui/sources/app/(app)/friends/search.request-status.test.tsx
apps/ui/sources/app/(app)/index.signupMethods.spec.tsx
apps/ui/sources/app/(app)/new/pick/machine.serverScope.spec.tsx
apps/ui/sources/app/(app)/restore/index.spec.tsx
apps/ui/sources/app/(app)/server.savedServers.spec.tsx
apps/ui/sources/app/(app)/session/[id]/commit.test.tsx
apps/ui/sources/app/(app)/session/[id]/files.test.tsx
apps/ui/sources/app/(app)/settings/account.addYourPhoneGrouping.test.tsx
apps/ui/sources/app/(app)/settings/account.username.test.tsx
apps/ui/sources/app/(app)/settings/session.subAgentGate.test.tsx
apps/ui/sources/app/(app)/settings/voice.support.spec.tsx
apps/ui/sources/app/_layout.init.spec.tsx
apps/ui/sources/auth/providers/github/oauth.auth.spec.tsx
apps/ui/sources/components/navigation/ConnectionStatusControl.popover.test.ts
apps/ui/sources/components/sessions/agentInput/AgentInput.abortButtonVisibility.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.modelOptionsOverride.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.sendButtonAccessibility.test.tsx
apps/ui/sources/components/sessions/files/content/ChangedFilesReview.test.tsx
apps/ui/sources/components/sessions/files/views/SessionCommitDetailsView.test.tsx
apps/ui/sources/components/sessions/files/views/SessionRepositoryTreeBrowserView.toolbar.test.tsx
apps/ui/sources/components/sessions/guidance/SessionGettingStartedGuidance.view.test.tsx
apps/ui/sources/components/sessions/new/components/NewSessionSimplePanel.modelOptionsOverride.test.tsx
apps/ui/sources/components/sessions/new/components/NewSessionWizard.attachments.feat.attachments.uploads.test.tsx
apps/ui/sources/components/sessions/new/components/WizardSectionHeaderRow.test.ts
apps/ui/sources/components/sessions/new/hooks/useCreateNewSession.acpSessionModeSeed.test.ts
apps/ui/sources/components/sessions/new/hooks/useCreateNewSession.permissionSeed.test.ts
apps/ui/sources/components/sessions/panes/SessionDetailsPanel.activeTabFallback.test.tsx
apps/ui/sources/components/sessions/panes/SessionDetailsPanel.autoPinOnEdit.test.tsx
apps/ui/sources/components/sessions/panes/SessionRightPanel.gitSubTabs.test.tsx
apps/ui/sources/components/sessions/panes/git/SessionRightPanelGitView.inactiveResume.test.tsx
apps/ui/sources/components/sessions/reviews/messages/ReviewCommentsMessageCard.test.tsx
apps/ui/sources/components/sessions/shell/SessionGroupDragList.rowHeight.test.tsx
apps/ui/sources/components/sessions/shell/SessionItem.hoverPinAffordance.test.tsx
apps/ui/sources/components/sessions/shell/SessionItem.tags.addNewTag.test.tsx
apps/ui/sources/components/sessions/shell/SessionItem.tags.layout.test.tsx
apps/ui/sources/components/sessions/shell/SessionView.attachmentsGating.test.tsx
apps/ui/sources/components/sessions/shell/SessionView.sendAttachmentsResumable.feat.attachments.uploads.test.tsx
apps/ui/sources/components/sessions/shell/SessionsList.pinningAndReorder.test.tsx
apps/ui/sources/components/sessions/transcript/ChatHeaderView.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.initialScrollBehavior.test.tsx
apps/ui/sources/components/sessions/transcript/MessageView.structured.test.tsx
apps/ui/sources/components/settings/SettingsView.multiServerMachines.test.tsx
apps/ui/sources/components/settings/bugReports/BugReportDiagnosticsPreviewModal.test.tsx
apps/ui/sources/components/settings/sourceControl/SourceControlSettingsView.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/DiffView.controlsRow.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/DiffView.fileListVirtualization.test.tsx
apps/ui/sources/components/tools/renderers/fileOps/DiffView.reviewComments.test.tsx
apps/ui/sources/components/tools/renderers/workflow/AskUserQuestionView.test.ts
apps/ui/sources/components/tools/renderers/workflow/collectTaskLikeTools.test.ts
apps/ui/sources/components/tools/shell/permissions/PermissionFooter.codexDecision.test.tsx
apps/ui/sources/components/tools/shell/permissions/PermissionFooter.stopAbortsRun.test.tsx
apps/ui/sources/components/tools/shell/permissions/PermissionPromptCard.preview.test.tsx
apps/ui/sources/components/tools/shell/views/ToolFullView.inference.test.ts
apps/ui/sources/components/tools/shell/views/ToolFullView.taskTranscript.test.tsx
apps/ui/sources/components/tools/shell/views/ToolTimelineRow.minimalFallback.test.tsx
apps/ui/sources/components/tools/shell/views/ToolTimelineRow.tapAction.test.tsx
apps/ui/sources/components/tools/shell/views/ToolTimelineRow.titleFallback.test.tsx
apps/ui/sources/components/tools/shell/views/ToolTimelineRow.unknownCollapse.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.acpKindFallback.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.detailLevelCompact.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.detailLevelFull.singleRenderer.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.detailLevelTitle.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.diffHeaderActions.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.minimalStructuredFallback.test.ts
apps/ui/sources/components/tools/shell/views/ToolView.permissionDenied.test.tsx
apps/ui/sources/components/tools/shell/views/ToolView.tapActionExpand.test.tsx
apps/ui/sources/components/ui/code/blocks/CodeBlockView.web.test.tsx
apps/ui/sources/components/ui/code/view/CodeLineRow.test.tsx
apps/ui/sources/components/ui/code/view/CodeLinesView.test.tsx
apps/ui/sources/components/ui/feedback/desktopUpdateBannerModel.test.ts
apps/ui/sources/components/ui/forms/dropdown/DropdownMenu.test.ts
apps/ui/sources/components/ui/lists/Item.subtitleNormalization.test.tsx
apps/ui/sources/components/ui/popover/Popover.nativePortal.test.ts
apps/ui/sources/components/ui/popover/Popover.test.ts
apps/ui/sources/components/voice/surface/VoiceSurface.test.tsx
apps/ui/sources/hooks/server/connectedServices/useConnectedServiceQuotaBadges.test.ts
apps/ui/sources/hooks/server/useFriendsIdentityReadiness.test.ts
apps/ui/sources/hooks/session/useConnectTerminal.authRedirect.test.tsx
apps/ui/sources/modal/components/BaseModal.test.ts
apps/ui/sources/scm/operations/remoteFeedback.test.ts
apps/ui/sources/scm/scmRepositoryService.test.ts
apps/ui/sources/scm/scmStatusSync.polling.test.ts
apps/ui/sources/sync/domains/features/featureDecisionRuntime.test.ts
apps/ui/sources/sync/domains/input/slashCommands/executeSessionComposerResolution.test.ts
apps/ui/sources/sync/domains/server/serverProfiles.test.ts
apps/ui/sources/sync/domains/session/listing/sessionListViewData.test.ts
apps/ui/sources/sync/domains/settings/settings.providerPlugins.test.ts
apps/ui/sources/sync/domains/settings/settings.spec.ts
apps/ui/sources/sync/domains/settings/voiceSettings.spec.ts
apps/ui/sources/sync/engine/pending/pendingQueueV2.updatePendingMessageV2.test.ts
apps/ui/sources/sync/engine/settings/syncSettings.accountSettingsCipher.test.ts
apps/ui/sources/sync/engine/settings/syncSettings.localOnlyServerSelection.test.ts
apps/ui/sources/sync/reducer/messageToEvent.test.ts
apps/ui/sources/sync/reducer/reducer.spec.ts
apps/ui/sources/sync/runtime/orchestration/concurrentSessionCache.socketRouting.test.ts
apps/ui/sources/sync/sync.create.initialAwaitTimeout.test.ts
apps/ui/sources/text/userFacingTextScan.sources.test.ts
apps/ui/sources/utils/platform/deviceCalculations.test.ts
apps/ui/sources/utils/strings/toSnakeCase.test.ts
apps/ui/sources/utils/system/requestReview.test.ts
apps/ui/sources/utils/timing/debounce.test.ts
apps/ui/sources/voice/agent/VoiceAgentSessionController.persistence.spec.ts
apps/ui/sources/voice/agent/VoiceAgentSessionController.streaming.spec.ts
apps/ui/sources/voice/kokoro/runtime/synthesizeKokoroWav.native.spec.ts
apps/ui/sources/voice/kokoro/runtime/synthesizeKokoroWav.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.agent.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.tts.spec.ts
apps/ui/sources/voice/session/VoiceSessionRuntime.spec.tsx
apps/ui/sources/voice/settings/panels/LocalConversationSection.hooksInvariant.test.ts
apps/ui/sources/voice/settings/panels/LocalConversationSection.test.tsx
apps/ui/sources/voice/settings/panels/RealtimeElevenLabsSection.test.tsx
apps/ui/sources/voice/settings/panels/localTts/LocalNeuralTtsSettings.native.spec.tsx
apps/ui/sources/voice/settings/panels/localTts/LocalNeuralTtsSettings.web.spec.tsx
apps/ui/sources/voice/tools/handlers.spec.ts
apps/ui/app.config.js
apps/ui/sources/auth/providers/github/test/oauthReturnHarness.ts
apps/ui/sources/voice/local/localVoiceEngine.testHarness.ts
apps/ui/sources/dev/reactNativeInternalStub.ts
apps/ui/sources/dev/testRunner.ts
apps/ui/sources/dev/vitestRnShim.ts
```

**SLOW_HIGH**

```text
apps/ui/sources/encryption/base64.test.ts
apps/ui/sources/text/userFacingTextScan.sources.test.ts
apps/ui/sources/voice/local/localVoiceEngine.agent.spec.ts
apps/ui/sources/voice/local/localVoiceEngine.testHarness.ts
```

**DUPLICATION**

```text
apps/ui/sources/__tests__/app/home.externalAuthStart.spec.tsx
apps/ui/sources/app/(app)/restore/index.mobile.featureDisabled.spec.tsx
apps/ui/sources/app/(app)/restore/index.webDesktop.spec.tsx
apps/ui/sources/app/(app)/restore/index.webPhone.spec.tsx
apps/ui/sources/app/(app)/scan/account.spec.tsx
apps/ui/sources/app/(app)/scan/terminal.spec.tsx
apps/ui/sources/components/account/restore/RestoreScanComputerQrView.alreadyRequested.spec.tsx
apps/ui/sources/components/account/restore/RestoreScanComputerQrView.featureDisabled.spec.tsx
apps/ui/sources/components/account/restore/RestoreScanComputerQrView.webPhone.spec.tsx
apps/ui/sources/components/navigation/ConnectionStatusControl.label.test.tsx
apps/ui/sources/components/qr/QrCodeScannerView.test.tsx
apps/ui/sources/components/sessions/agentInput/AgentInput.permissionRequestLocation.test.tsx
apps/ui/sources/components/sessions/agentInput/recipient/useSessionRecipientState.test.ts
apps/ui/sources/components/sessions/files/content/ChangedFilesReview.flashListExtraData.test.tsx
apps/ui/sources/components/sessions/files/content/review/buildChangedFilesReviewRows.test.ts
apps/ui/sources/components/sessions/files/content/review/imagePreviewCache.test.ts
apps/ui/sources/components/sessions/files/content/review/resolveReviewPrefetchWindow.test.ts
apps/ui/sources/components/sessions/files/content/review/useChangedFilesReviewDiffLoading.test.ts
apps/ui/sources/components/sessions/files/views/sessionFileDetails/refreshSessionFileDetails.multiFileDiff.test.ts
apps/ui/sources/components/sessions/panes/SessionDetailsPanel.closeTabOnce.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.pinOnContentChange.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.unpinnedNoWheel.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.forwardPrefetch.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.thinkingExpansionControlled.test.tsx
apps/ui/sources/components/sessions/transcript/ChatList.turnThinkingExpansionWiring.test.tsx
apps/ui/sources/components/sessions/transcript/TranscriptList.flashListV2.test.tsx
apps/ui/sources/components/sessions/transcript/TranscriptList.thinkingExpansionControlled.test.tsx
apps/ui/sources/components/sessions/transcript/thinking/ThinkingTimelineRow.test.tsx
apps/ui/sources/components/sessions/transcript/turns/TurnView.thinkingExpansionControlled.test.tsx
apps/ui/sources/components/settings/SettingsView.connectTerminal.native.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerAutoAddFromRoute.canonicalUrl.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerSettingsScreenController.canonicalUrlAdoption.test.tsx
apps/ui/sources/components/settings/server/hooks/useServerSettingsScreenController.insecureHttpWarning.test.tsx
apps/ui/sources/components/settings/session/TranscriptRenderingAdvancedSettingsView.performance.test.tsx
apps/ui/sources/components/tools/shell/views/timeline/ToolTimelineRowHeader.test.tsx
apps/ui/sources/components/ui/code/blocks/CodeBlockViewFrame.test.tsx
apps/ui/sources/components/ui/code/editor/bridge/resolveCodeMirrorWebViewLanguageSpec.test.ts
apps/ui/sources/components/ui/code/editor/codeEditorTypes.test.ts
apps/ui/sources/components/ui/media/SimpleSyntaxHighlighter.test.tsx
apps/ui/sources/hooks/session/useUserMessageHistory.navigatorStability.test.tsx
apps/ui/sources/hooks/session/useUserMessageHistory.sessionMessagesSelector.test.ts
apps/ui/sources/scm/diff/extractUnifiedDiffForSingleFile.test.ts
apps/ui/sources/scm/diffCache/scmDiffCache.test.ts
apps/ui/sources/scm/diffCache/scmDiffPrefetchScheduler.test.ts
apps/ui/sources/scm/diffCache/useScmDiffCacheLimits.test.tsx
apps/ui/sources/scm/refresh/useScmAdaptivePolling.test.tsx
apps/ui/sources/scm/refresh/workspaceMutationDetection/extractWorkspaceMutations.test.ts
apps/ui/sources/scm/refresh/workspaceMutationIngestion.test.ts
apps/ui/sources/scm/refresh/workspaceMutationInvalidator.test.ts
apps/ui/sources/sync/api/account/apiConnectedServicesQuotasV3.test.ts
apps/ui/sources/sync/domains/input/participants/resolveParticipantRoutedSend.test.ts
apps/ui/sources/sync/domains/server/url/serverUrlClassification.test.ts
apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts
apps/ui/sources/sync/engine/sessions/sessionMessageApplyCoalescer.test.ts
apps/ui/sources/sync/runtime/orchestration/applyMessageCatchUpDecision.test.ts
apps/ui/sources/sync/runtime/orchestration/messageCatchUpPolicy.test.ts
apps/ui/sources/sync/runtime/orchestration/runTasksWithLimit.test.ts
apps/ui/sources/sync/runtime/orchestration/runWithInFlightDedupe.test.ts
apps/ui/sources/sync/runtime/syncTuning.test.ts
apps/ui/sources/sync/store/domains/messages.reset.test.ts
apps/ui/sources/sync/store/hooks.useMessagesByIds.test.tsx
apps/ui/sources/sync/store/hooks.useSessionMessages.test.tsx
apps/ui/sources/utils/code/normalizeCodeLanguageId.test.ts
apps/ui/sources/utils/platform/webMobileHeuristics.test.ts
apps/ui/sources/utils/sessions/permissions/resolvePermissionToolCallLocations.test.ts
apps/ui/sources/utils/sessions/sortNormalizedMessagesOldestFirst.test.ts
apps/ui/sources/utils/system/sentry.bugReportReplay.test.ts
apps/ui/sources/utils/system/sentry.optOut.test.ts
apps/ui/sources/utils/timing/pauseController.test.ts
apps/ui/sources/utils/ui/toTestIdSafeValue.test.ts
apps/ui/sources/app/(app)/mtls.restoreRequired.spec.tsx
apps/ui/sources/app/(app)/oauth/oauthReturn.provisioningChoice.spec.tsx
apps/ui/sources/sync/api/account/apiAccountEncryptionMode.test.ts
apps/ui/sources/sync/api/account/apiConnectedServicesV3.test.ts
apps/ui/sources/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount.test.ts
apps/ui/sources/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount.test.ts
apps/ui/sources/sync/engine/account/syncAccount.settingsV2.plain.test.ts
apps/ui/sources/sync/ops/account/buildAccountEncryptionMigrateToE2eeRequest.test.ts
apps/ui/sources/sync/ops/account/buildAccountEncryptionMigrateToPlainRequest.test.ts
apps/ui/sources/text/_default.test.ts
apps/ui/sources/voice/output/GoogleCloudTtsController.spec.ts
apps/ui/sources/voice/output/KokoroTtsController.spec.ts
apps/ui/sources/voice/output/playAudioBytesWithStopper.spec.ts
apps/ui/sources/voice/output/speakAssistantText.spec.ts
apps/ui/sources/__tests__/app/_layout.test.ts
apps/ui/sources/__tests__/app/machine/machineDetails.capabilitiesRequestStability.test.ts
apps/ui/sources/__tests__/app/machine/machineDetails.executionRuns.test.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.revokeMachine.test.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.serverIdSwitch.test.tsx
apps/ui/sources/__tests__/app/new/index.blockingGuidance.test.tsx
apps/ui/sources/__tests__/app/new/pick/machine.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.stackOptionsStability.test.ts
apps/ui/sources/__tests__/app/new/pick/path.test.ts
apps/ui/sources/__tests__/app/new/pick/profile-edit.headerButtons.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.secretRequirementNavigation.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.setOptionsLoop.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.stackOptionsStability.test.ts
apps/ui/sources/__tests__/app/settings/profiles.nativeNavigation.test.ts
apps/ui/sources/__tests__/app/share/publicShareViewer.plaintext.test.tsx
apps/ui/sources/__tests__/config/appConfig.easDefaults.test.ts
apps/ui/sources/__tests__/install/ensureNohoistPeerLinks.test.ts
apps/ui/sources/__tests__/install/resolveUiPostinstallTasks.test.ts
apps/ui/sources/__tests__/install/shouldRunPostinstall.test.ts
apps/ui/sources/__tests__/voice/settings/localDirectSection.unhandledRejection.test.tsx
apps/ui/sources/agents/catalog/advancedModes.test.ts
apps/ui/sources/agents/catalog/agentPickerOptions.test.ts
apps/ui/sources/agents/catalog/catalog.test.ts
apps/ui/sources/agents/catalog/enabled.test.ts
apps/ui/sources/agents/catalog/providerDetailsInfo.test.ts
apps/ui/sources/agents/catalog/resolve.test.ts
apps/ui/sources/agents/prompt/systemPrompt.test.ts
apps/ui/sources/agents/providers/_registry/providerSettingsRegistry.test.ts
apps/ui/sources/agents/providers/claude/core.test.ts
apps/ui/sources/agents/providers/pi/thinking.test.ts
apps/ui/sources/agents/registry/registryCore.test.ts
apps/ui/sources/agents/registry/registryUiBehavior.newSession.test.ts
apps/ui/sources/agents/registry/registryUiBehavior.payload.test.ts
apps/ui/sources/agents/registry/registryUiBehavior.resume.test.ts
apps/ui/sources/agents/runtime/acpRuntimeResume.test.ts
apps/ui/sources/agents/runtime/resumeCapabilities.test.ts
apps/ui/sources/app/(app)/account.legacyRedirect.spec.tsx
apps/ui/sources/app/(app)/changelog.featureGate.test.tsx
apps/ui/sources/app/(app)/friends/index.redirect.test.tsx
apps/ui/sources/app/(app)/friends/search.request-status.test.tsx
apps/ui/sources/app/(app)/index.autoRedirect.spec.tsx
apps/ui/sources/app/(app)/index.autoRedirect.web.spec.tsx
apps/ui/sources/app/(app)/index.pendingTerminalIntent.spec.tsx
apps/ui/sources/app/(app)/index.signupMethods.spec.tsx
apps/ui/sources/app/(app)/new/pick/machine.serverScope.spec.tsx
apps/ui/sources/app/(app)/new/pick/server.headerOptions.test.tsx
apps/ui/sources/app/(app)/new/pick/server.targeting.spec.tsx
apps/ui/sources/app/(app)/oauth/oauthReturn.keyless.spec.tsx
apps/ui/sources/app/(app)/oauth/oauthReturn.providerAlreadyLinked.spec.tsx
apps/ui/sources/app/(app)/restore/index.mobile.spec.tsx
apps/ui/sources/app/(app)/restore/index.spec.tsx
apps/ui/sources/app/(app)/restore/lost-access.spec.tsx
apps/ui/sources/app/(app)/restore/manual.spec.tsx
apps/ui/sources/app/(app)/rootLayout.friendsHeaderRight.test.tsx
apps/ui/sources/app/(app)/rootLayout.notifications.spec.tsx
apps/ui/sources/app/(app)/rootLayout.serverOverride.spec.tsx
apps/ui/sources/app/(app)/rootLayout.voiceGate.spec.tsx
apps/ui/sources/app/(app)/runs.test.tsx
apps/ui/sources/app/(app)/search.memoryRpc.test.tsx
apps/ui/sources/app/(app)/server.savedServers.spec.tsx
apps/ui/sources/app/(app)/server.webActions.spec.tsx
apps/ui/sources/app/(app)/session/[id]/commit.test.tsx
apps/ui/sources/app/(app)/session/[id]/file.screen.sessionPath.test.tsx
apps/ui/sources/app/(app)/session/[id]/files.test.tsx
apps/ui/sources/app/(app)/session/[id]/log.test.tsx
apps/ui/sources/app/(app)/session/[id]/runs.test.tsx
apps/ui/sources/app/(app)/session/[id]/runs/[runId].test.tsx
apps/ui/sources/app/(app)/session/[id]/runs/new.guidancePreview.test.tsx
apps/ui/sources/app/(app)/session/[id]/runs/new.test.tsx
apps/ui/sources/app/(app)/session/[id]/sharing.permission.test.tsx
apps/ui/sources/app/(app)/session/sessionIdParamParsing.spec.tsx
apps/ui/sources/app/(app)/settings/account.addYourPhoneGrouping.test.tsx
apps/ui/sources/app/(app)/settings/account.encryptionModeToggle.test.tsx
apps/ui/sources/app/(app)/settings/account.secretKeyCopy.test.tsx
apps/ui/sources/app/(app)/settings/account.username.test.tsx
apps/ui/sources/app/(app)/settings/appearance.sessionList.spec.tsx
apps/ui/sources/app/(app)/settings/features.gating.spec.tsx
apps/ui/sources/app/(app)/settings/features.webSessionSettingsMove.test.tsx
apps/ui/sources/app/(app)/settings/memory.enableSwitch.test.tsx
apps/ui/sources/app/(app)/settings/providers/providerSettingsScreen.test.tsx
apps/ui/sources/app/(app)/settings/session.actionsEntry.test.tsx
apps/ui/sources/app/(app)/settings/session.permissionsEntry.test.tsx
apps/ui/sources/app/(app)/settings/session.subAgentGate.test.tsx
apps/ui/sources/app/(app)/settings/session.thinkingDisplayMode.test.tsx
apps/ui/sources/app/(app)/settings/session.toolRenderingEntry.test.tsx
apps/ui/sources/app/(app)/settings/session.webFeaturesMoved.test.tsx
apps/ui/sources/app/(app)/settings/voice.deviceTtsTest.spec.tsx
apps/ui/sources/app/(app)/settings/voice.support.spec.tsx
apps/ui/sources/app/(app)/terminal/connect.hashParamsOrder.spec.tsx
apps/ui/sources/app/(app)/terminal/connect.unauthRedirect.spec.tsx
apps/ui/sources/app/(app)/terminal/index.authButtons.spec.tsx
apps/ui/sources/app/(app)/terminal/index.legacyFallback.spec.tsx
apps/ui/sources/app/(app)/terminal/index.unauthRedirect.spec.tsx
apps/ui/sources/app/_layout.init.spec.tsx
apps/ui/sources/auth/context/AuthContext.login.test.tsx
apps/ui/sources/auth/flows/approve.test.ts
apps/ui/sources/auth/flows/buildDataKeyCredentialsForToken.test.ts
apps/ui/sources/auth/flows/getToken.keyChallengeGate.test.ts
apps/ui/sources/auth/flows/qrWait.v2Fallback.test.ts
apps/ui/sources/auth/oauth/contentKeyBinding.test.ts
apps/ui/sources/auth/pairing/pairingUrl.test.ts
apps/ui/sources/auth/providers/externalAuthUrl.test.ts
apps/ui/sources/auth/providers/externalOAuthProvider.test.ts
apps/ui/sources/auth/providers/github/index.spec.ts
apps/ui/sources/auth/providers/github/oauth.auth.spec.tsx
apps/ui/sources/auth/providers/github/oauth.connect.spec.tsx
apps/ui/sources/auth/providers/registry.fallback.spec.ts
apps/ui/sources/auth/recovery/secretKeyBackup.robustness.spec.ts
apps/ui/sources/auth/recovery/secretKeyBackup.validation.spec.ts
apps/ui/sources/auth/storage/tokenStorage.pendingExternalAuth.test.ts
apps/ui/sources/auth/storage/tokenStorage.pendingExternalConnect.test.ts
apps/ui/sources/auth/storage/tokenStorage.serverScopeMismatch.test.ts
... +870 more
```

### Integration — apps/ui (Vitest)

- Total audited files: 83
- UNWIRED: 4
- BRITTLE_HIGH: 4
- SLOW_HIGH: 1
- DUPLICATION: 83

**UNWIRED**

```text
apps/ui/sources/dev/testRunner.ts
apps/ui/sources/sync/__testdata__/trace_0.json
apps/ui/sources/sync/__testdata__/trace_1.json
apps/ui/sources/sync/__testdata__/trace_2.json
```

**BRITTLE_HIGH**

```text
apps/ui/sources/__tests__/app/machine/machineDetails.capabilitiesRequestStability.test.ts
apps/ui/sources/__tests__/voice/settings/localDirectSection.unhandledRejection.test.tsx
apps/ui/sources/dev/testRunner.ts
apps/ui/sources/dev/vitestRnShim.ts
```

**SLOW_HIGH**

```text
apps/ui/sources/hooks/session/files/useFilesScmOperations.integration.test.ts
```

**DUPLICATION**

```text
apps/ui/sources/sync/ops/sessions.serverScoped.integration.test.ts
apps/ui/sources/hooks/session/files/useFileScmStageActions.integration.test.ts
apps/ui/sources/hooks/session/files/useFilesScmOperations.integration.test.ts
apps/ui/sources/hooks/session/files/useScmCommitHistory.integration.test.ts
apps/ui/sources/sync/ops/capabilities.serverScoped.integration.test.ts
apps/ui/sources/sync/ops/machines.serverScoped.integration.test.ts
apps/ui/sources/sync/ops/sessions.sapling.integration.test.ts
apps/ui/sources/sync/ops/sessions.scm.integration.test.ts
apps/ui/package.json
apps/ui/sources/__tests__/app/_layout.test.ts
apps/ui/sources/__tests__/app/machine/machineDetails.capabilitiesRequestStability.test.ts
apps/ui/sources/__tests__/app/machine/machineDetails.executionRuns.test.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.revokeMachine.test.tsx
apps/ui/sources/__tests__/app/machine/machineDetails.serverIdSwitch.test.tsx
apps/ui/sources/__tests__/app/new/index.blockingGuidance.test.tsx
apps/ui/sources/__tests__/app/new/pick/machine.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/path.stackOptionsStability.test.ts
apps/ui/sources/__tests__/app/new/pick/path.test.ts
apps/ui/sources/__tests__/app/new/pick/profile-edit.headerButtons.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.secretRequirementNavigation.test.ts
apps/ui/sources/__tests__/app/new/pick/profile.setOptionsLoop.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.presentation.test.ts
apps/ui/sources/__tests__/app/new/pick/secret.stackOptionsStability.test.ts
apps/ui/sources/__tests__/app/new/pick/testHarness.ts
apps/ui/sources/__tests__/app/settings/profiles.nativeNavigation.test.ts
apps/ui/sources/__tests__/app/share/publicShareViewer.plaintext.test.tsx
apps/ui/sources/__tests__/config/appConfig.easDefaults.test.ts
apps/ui/sources/__tests__/config/fixtures/app.local.fixture.cjs
apps/ui/sources/__tests__/install/ensureNohoistPeerLinks.test.ts
apps/ui/sources/__tests__/install/resolveUiPostinstallTasks.test.ts
apps/ui/sources/__tests__/install/shouldRunPostinstall.test.ts
apps/ui/sources/__tests__/voice/settings/localDirectSection.unhandledRejection.test.tsx
apps/ui/sources/dev/abortControllerPolyfillStub.ts
apps/ui/sources/dev/appConfig.routerIgnore.spec.ts
apps/ui/sources/dev/babelConfigAliases.test.ts
apps/ui/sources/dev/expoAudioStub.ts
apps/ui/sources/dev/expoClipboardStub.ts
apps/ui/sources/dev/expoConstantsStub.ts
apps/ui/sources/dev/expoLinearGradientStub.ts
apps/ui/sources/dev/expoLocalizationStub.ts
apps/ui/sources/dev/expoModulesCoreStub.ts
apps/ui/sources/dev/expoNotificationsStub.ts
apps/ui/sources/dev/expoRouterStub.ts
apps/ui/sources/dev/expoSpeechRecognitionStub.ts
apps/ui/sources/dev/expoSpeechStub.ts
apps/ui/sources/dev/expoStub.ts
apps/ui/sources/dev/jsdom.d.ts
apps/ui/sources/dev/metro.config.fontfaceobserver.spec.ts
apps/ui/sources/dev/reactNativeDeviceInfoStub.ts
apps/ui/sources/dev/reactNativeGestureHandlerStub.ts
apps/ui/sources/dev/reactNativeInternalStub.ts
apps/ui/sources/dev/reactNativePurchasesStub.ts
apps/ui/sources/dev/reactNativePurchasesUiStub.ts
apps/ui/sources/dev/reactNativeStub.ts
apps/ui/sources/dev/reactNativeVirtualizedListsStub.ts
apps/ui/sources/dev/reactNativeWebviewStub.ts
apps/ui/sources/dev/rnEncryptionStub.ts
apps/ui/sources/dev/stackScreenInlineOptions.test.ts
apps/ui/sources/dev/testRunner.ts
apps/ui/sources/dev/testkit/rootLayoutTestkit.ts
apps/ui/sources/dev/unistylesStyleSheetImports.test.ts
apps/ui/sources/dev/vitestIntegrationConfig.test.ts
apps/ui/sources/dev/vitestRnShim.test.ts
apps/ui/sources/dev/vitestRnShim.ts
apps/ui/sources/dev/vitestSetup.ts
apps/ui/sources/sync/__testdata__/trace_0.json
apps/ui/sources/sync/__testdata__/trace_1.json
apps/ui/sources/sync/__testdata__/trace_2.json
apps/ui/sources/sync/ops/__tests__/gitRepoHarness.initBareRemote.test.ts
apps/ui/sources/sync/ops/__tests__/gitRepoHarness.initRepo.test.ts
apps/ui/sources/sync/ops/__tests__/gitRepoHarness.ts
apps/ui/sources/sync/ops/__tests__/saplingRepoHarness.ts
apps/ui/sources/sync/ops/__tests__/sessionAbort.test.ts
apps/ui/sources/sync/ops/__tests__/sessionArchive.serverScope.test.ts
apps/ui/sources/sync/ops/__tests__/sessionDelete.serverScope.test.ts
apps/ui/sources/sync/ops/__tests__/sessionStop.serverScope.test.ts
apps/ui/sources/sync/ops/__tests__/sessionStop.test.ts
apps/ui/sources/sync/ops/__tests__/spawnSessionPayload.test.ts
apps/ui/vitest.config.ts
apps/ui/vitest.integration.config.ts
scripts/testing/featureTestGating.ts
```

### Unit — apps/cli (Vitest)

- Total audited files: 733
- UNWIRED: 9
- BRITTLE_HIGH: 82
- SLOW_HIGH: 15
- DUPLICATION: 691

**UNWIRED**

```text
apps/cli/src/daemon/sessionRunnerLock.test.ts
apps/cli/src/api/sessionClient.v2ChangesFeatureFlag.test.ts
apps/cli/src/daemon/executionRunRegistry.test.ts
apps/cli/src/daemon/findRunningTrackedSessionById.test.ts
apps/cli/src/daemon/sessions/reattachFromMarkers.test.ts
apps/cli/src/daemon/sessions/visibleConsoleSpawnWaiter.test.ts
packages/tests/suites/providers/claude.agentTeams.toolNames.realProbe.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
```

**BRITTLE_HIGH**

```text
apps/cli/src/backends/claude/claudeLocalLauncher.agentTeamsEnv.test.ts
apps/cli/src/backends/claude/loop.agentTeamsEnv.test.ts
apps/cli/src/capabilities/deps/codexAcp.win32NpmShim.test.ts
apps/cli/src/capabilities/deps/codexMcpResume.win32NpmShim.test.ts
apps/cli/src/cli/commands/server.selfHealCapabilities.test.ts
apps/cli/src/daemon/startDaemon.sessionRunnerLockDedupe.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.promptUsage.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionUpdate.maxUpdates.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.historyImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/agent/executionRuns/runtime/ExecutionRunManager.test.ts
apps/cli/src/agent/localControl/__tests__/discardPendingBeforeSwitchToLocal.test.ts
apps/cli/src/agent/runtime/permission/permissionModeFromMetadata.test.ts
apps/cli/src/agent/runtime/waitForMessagesOrPending.test.ts
apps/cli/src/agent/tools/normalization/families/diff.schema.test.ts
apps/cli/src/agent/tools/normalization/fixtures.v1.catalog.test.ts
apps/cli/src/agent/tools/trace/toolTraceFixturesAllowlist.test.ts
apps/cli/src/api/api.test.ts
apps/cli/src/api/apiMachine.connectOrder.test.ts
apps/cli/src/api/apiMachine.v2ChangesReconnect.test.ts
apps/cli/src/api/machine/rpcHandlers.test.ts
apps/cli/src/api/sessionClient.afterSeqCatchUp.test.ts
apps/cli/src/api/sessionClient.test.ts
apps/cli/src/api/sessionClient.v2ChangesFeatureFlag.test.ts
apps/cli/src/backends/auggie/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/claude/claudeLocal.test.ts
apps/cli/src/backends/claude/cli/command.version.test.ts
apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.postResultStreaming.test.ts
apps/cli/src/backends/claude/sdk/query.signalCleanup.test.ts
apps/cli/src/backends/claude/utils/permissionHandler.toolTrace.test.ts
apps/cli/src/backends/claude/utils/sessionScanner.onMessageErrors.test.ts
apps/cli/src/backends/claude/utils/sessionScanner.test.ts
apps/cli/src/backends/codex/__tests__/rolloutToolNameMapping.test.ts
apps/cli/src/backends/codex/cli/command.test.ts
apps/cli/src/backends/codex/codexMcpClient.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutDiscovery.test.ts
apps/cli/src/backends/codex/utils/formatCodexEventForUi.test.ts
apps/cli/src/backends/gemini/acp/transport.test.ts
apps/cli/src/backends/gemini/cli/command.model.test.ts
apps/cli/src/backends/gemini/utils/formatGeminiErrorForUi.test.ts
apps/cli/src/backends/kilo/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/kilo/acp/transport.test.ts
apps/cli/src/backends/kimi/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/opencode/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/opencode/acp/transport.test.ts
apps/cli/src/backends/opencode/runOpenCode.test.ts
apps/cli/src/backends/pi/acp/runtime.permissionMode.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.authReloadContinue.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.ensureProcessRecovery.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.loadSession.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.promptFailure.test.ts
apps/cli/src/backends/qwen/acp/runtime.permissionMode.test.ts
apps/cli/src/capabilities/probes/acpProbe.spawnError.test.ts
apps/cli/src/capabilities/probes/agentModelsProbe.staticOnly.test.ts
apps/cli/src/capabilities/registry/toolExecutionRuns.feat.execution.runs.test.ts
apps/cli/src/cli/commands/daemon.multiAll.test.ts
apps/cli/src/cli/commands/daemon.startLogging.test.ts
apps/cli/src/cli/commands/server.addFlow.test.ts
apps/cli/src/cli/commands/server.postAdd.test.ts
apps/cli/src/cli/commands/session/actions/json.contract.test.ts
apps/cli/src/cli/runBackendSessionCliCommand.test.ts
apps/cli/src/cli/runtime/update/binarySelfUpdate.test.ts
apps/cli/src/daemon/ensureDaemon.startup.test.ts
apps/cli/src/daemon/servicePlan.test.ts
apps/cli/src/daemon/sessions/reattachFromMarkers.test.ts
apps/cli/src/diagnostics/bugReportArtifacts.test.ts
apps/cli/src/mcp/happierMcpToolCatalog.test.ts
apps/cli/src/persistence.readSettings.activeServerOverride.test.ts
apps/cli/src/rpc/handlers/capabilities.probeModels.cwd.test.ts
apps/cli/src/rpc/handlers/capabilities.probeModes.cwd.test.ts
apps/cli/src/rpc/handlers/executionRuns.feat.execution.runs.test.ts
apps/cli/src/sessionControl/resolveSessionId.longPrefix.test.ts
apps/cli/src/terminal/attachment/terminalFallbackMessage.test.ts
apps/cli/src/terminal/tmux/startHappyHeadlessInTmux.test.ts
apps/cli/src/ui/auth.nonInteractiveBoth.test.ts
apps/cli/src/ui/qrcode.test.ts
packages/tests/suites/providers/claude.agentTeams.toolNames.realProbe.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.diffRead.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/test-setup.ts
```

**SLOW_HIGH**

```text
apps/cli/src/agent/acp/__tests__/AcpBackend.initDelay.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.waitForResponseComplete.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/backends/claude/utils/sessionScanner.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.authReloadContinue.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.ensureProcessRecovery.test.ts
apps/cli/src/backends/pi/rpc/PiRpcBackend.promptFailure.test.ts
apps/cli/src/cli/commands/daemon.multiAll.test.ts
packages/tests/suites/providers/claude.agentTeams.toolNames.realProbe.test.ts
apps/cli/scripts/buildSharedDeps.mjs
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteFlows.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteGuards.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/test-setup.ts
```

**DUPLICATION**

```text
apps/cli/src/agent/executionRuns/runtime/turnDelivery.test.ts
apps/cli/src/agent/permissions/BasePermissionHandler.pushNotifications.test.ts
apps/cli/src/agent/reviews/engines/coderabbit/CodeRabbitReviewBackend.win32CmdShim.test.ts
apps/cli/src/api/session/agentStateRecords.test.ts
apps/cli/src/backends/claude/claudeLocalLauncher.agentTeamsEnv.test.ts
apps/cli/src/backends/claude/claudeUnhandledRejectionPolicy.test.ts
apps/cli/src/backends/claude/loop.agentTeamsEnv.test.ts
apps/cli/src/backends/claude/utils/mcpConfigMerge.test.ts
apps/cli/src/backends/claude/utils/participantRouting/formatClaudeTeamRoutedPrompt.test.ts
apps/cli/src/backends/claude/utils/participantRouting/parseParticipantMessageMeta.test.ts
apps/cli/src/capabilities/deps/codexAcp.win32NpmShim.test.ts
apps/cli/src/capabilities/deps/codexMcpResume.win32NpmShim.test.ts
apps/cli/src/capabilities/snapshots/cliSnapshot.win32CmdShim.test.ts
apps/cli/src/cli/commands/auth/login.printConfigureLinks.test.ts
apps/cli/src/cli/commands/daemon.installAlias.test.ts
apps/cli/src/cli/commands/server.selfHealCapabilities.test.ts
apps/cli/src/cli/runBackendSessionCliCommand.lock.test.ts
apps/cli/src/configuration.apiServerUrl.test.ts
apps/cli/src/configuration.serverSelection.localUrlSafety.test.ts
apps/cli/src/daemon/sessionRunnerLock.test.ts
apps/cli/src/daemon/sessions/isSessionRunnerActive.test.ts
apps/cli/src/daemon/sessions/stopSession.test.ts
apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.explicitEnvKeys.test.ts
apps/cli/src/daemon/spawn/spawnRequestCoalescer.test.ts
apps/cli/src/daemon/startDaemon.sessionRunnerLockDedupe.test.ts
apps/cli/src/persistence.schemaV6Migration.test.ts
apps/cli/src/server/serverCapabilities.test.ts
apps/cli/src/server/serverProfiles.localUrlSafety.test.ts
apps/cli/src/server/serverUrlClassification.test.ts
apps/cli/src/settings/notifications/permissionRequestPushNotifier.test.ts
apps/cli/src/utils/collections/lru.test.ts
apps/cli/scripts/__tests__/buildSharedDeps.test.ts
apps/cli/scripts/__tests__/bundleWorkspaceDeps.test.ts
apps/cli/scripts/__tests__/happierBinPreflightHoistedNodeModules.test.ts
apps/cli/scripts/__tests__/happierDependencyPreflight.test.ts
apps/cli/scripts/__tests__/publishBundledDependencies.test.ts
apps/cli/scripts/__tests__/ripgrep_launcher.test.ts
apps/cli/scripts/__tests__/vitestLaneSeparation.test.ts
apps/cli/scripts/buildOutputs.spawnHooks.test.ts
apps/cli/scripts/claude_version_utils.findClaudeInPath.win32.test.ts
apps/cli/scripts/claude_version_utils.test.ts
apps/cli/scripts/claude_version_utils.win32Reliability.test.ts
apps/cli/scripts/rmDist.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.acpFs.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.authenticate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.configOptions.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.dispose.killsProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsMethods.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.initDelay.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionDeniedCleanup.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionSeed.toolCallUpdateFallback.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.promptUsage.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.responseCompletionError.idle.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModels.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModes.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionUpdate.maxUpdates.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.stderrArtifacts.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.toolCallUpdate.kindInference.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.usageUpdate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.waitForResponseComplete.test.ts
apps/cli/src/agent/acp/__tests__/createAcpFilteredStdoutReadable.multiline.test.ts
apps/cli/src/agent/acp/__tests__/killProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.capture.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.captureErrors.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.destroyedWrite.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.test.ts
apps/cli/src/agent/acp/__tests__/sessionUpdateHandlers.test.ts
apps/cli/src/agent/acp/bridge/__tests__/acpCommonHandlers.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplayHistory.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplaySidechain.test.ts
apps/cli/src/agent/acp/permissions/__tests__/permissionRequest.test.ts
apps/cli/src/agent/acp/runtime/__tests__/abortAcpRuntimeTurnIfNeeded.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.configOptions.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.historyImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.modelOutputStreaming.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.pendingPump.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sessionModels.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sidechainImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.thinkingState.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.tokenCountForwarding.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.traceMarkers.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.turnHooks.test.ts
apps/cli/src/agent/acp/updates/__tests__/content.test.ts
apps/cli/src/agent/acp/updates/__tests__/events.test.ts
apps/cli/src/agent/acp/updates/__tests__/messages.test.ts
apps/cli/src/agent/adapters/MessageAdapter.toolIsError.test.ts
apps/cli/src/agent/executionRuns/profiles/delegate/DelegateProfile.test.ts
apps/cli/src/agent/executionRuns/profiles/plan/PlanProfile.test.ts
apps/cli/src/agent/executionRuns/profiles/review/ReviewProfile.test.ts
apps/cli/src/agent/executionRuns/runtime/ExecutionRunManager.runRegistry.test.ts
apps/cli/src/agent/executionRuns/runtime/ExecutionRunManager.test.ts
apps/cli/src/agent/executionRuns/runtime/createExecutionRunBackend.coderabbit.test.ts
apps/cli/src/agent/localControl/__tests__/confirmDiscardBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/createLocalRemoteModeController.test.ts
apps/cli/src/agent/localControl/__tests__/discardPendingBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/discardQueuedAndPendingForLocalSwitch.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.startAtEndErrors.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.test.ts
apps/cli/src/agent/permissions/BasePermissionHandler.allowlist.test.ts
apps/cli/src/agent/permissions/BasePermissionHandler.toolTrace.test.ts
apps/cli/src/agent/permissions/CodexLikePermissionHandler.metadataSync.test.ts
apps/cli/src/agent/permissions/CodexLikePermissionHandler.test.ts
apps/cli/src/agent/permissions/CodexLikePermissionHandler.toolTrace.test.ts
apps/cli/src/agent/permissions/ProviderEnforcedPermissionHandler.test.ts
apps/cli/src/agent/permissions/createProviderEnforcedPermissionHandler.test.ts
apps/cli/src/agent/permissions/permissionToolIdentifier.test.ts
apps/cli/src/agent/permissions/shellCommandAllowlist.test.ts
apps/cli/src/agent/reviews/engines/coderabbit/buildCodeRabbitEnv.test.ts
apps/cli/src/agent/reviews/engines/coderabbit/readCodeRabbitReviewConfig.test.ts
apps/cli/src/agent/reviews/engines/coderabbit/runWithRateLimitRetries.test.ts
apps/cli/src/agent/runtime/acpConfigOptionOverrideSync.test.ts
apps/cli/src/agent/runtime/acpConfigOptionOverridesMetadata.test.ts
apps/cli/src/agent/runtime/acpSessionModeOverrideSync.test.ts
apps/cli/src/agent/runtime/createHappierMcpBridge.test.ts
apps/cli/src/agent/runtime/createSessionMetadata.test.ts
apps/cli/src/agent/runtime/initializeBackendApiContext.test.ts
apps/cli/src/agent/runtime/initializeBackendRunSession.test.ts
apps/cli/src/agent/runtime/mergeSessionMetadataForStartup.test.ts
apps/cli/src/agent/runtime/modeMessageQueue.test.ts
apps/cli/src/agent/runtime/modelOverridePrecedence.test.ts
apps/cli/src/agent/runtime/modelOverrideSync.test.ts
apps/cli/src/agent/runtime/permission/bindPermissionModeQueue.inFlightSteer.test.ts
apps/cli/src/agent/runtime/permission/bindPermissionModeQueue.test.ts
apps/cli/src/agent/runtime/permission/permissionModeFromMetadata.test.ts
apps/cli/src/agent/runtime/permission/permissionModeFromUserMessage.test.ts
apps/cli/src/agent/runtime/permission/permissionModeMetadata.test.ts
apps/cli/src/agent/runtime/permission/permissionModeStateSync.test.ts
apps/cli/src/agent/runtime/permission/startupPermissionModeSeed.test.ts
apps/cli/src/agent/runtime/permissionIntentPrecedence.test.ts
apps/cli/src/agent/runtime/permissionModeForAgent.test.ts
apps/cli/src/agent/runtime/queueSpecialCommands.test.ts
apps/cli/src/agent/runtime/runPermissionModePromptLoop.test.ts
apps/cli/src/agent/runtime/runStandardAcpProvider.test.ts
apps/cli/src/agent/runtime/runnerTerminationHandlers.test.ts
apps/cli/src/agent/runtime/runtimeOverridesSynchronizer.test.ts
apps/cli/src/agent/runtime/sendReadyWithPushNotification.test.ts
apps/cli/src/agent/runtime/sessionAttach.test.ts
apps/cli/src/agent/runtime/sessionControlsPublishShared.test.ts
apps/cli/src/agent/runtime/signalForwarding.test.ts
apps/cli/src/agent/runtime/startup/DeferredApiSessionClient.test.ts
apps/cli/src/agent/runtime/startup/startupCoordinator.test.ts
apps/cli/src/agent/runtime/startupMetadataUpdate.test.ts
apps/cli/src/agent/runtime/startupSideEffects.test.ts
apps/cli/src/agent/runtime/subprocessArtifacts.test.ts
apps/cli/src/agent/runtime/waitForMessagesOrPending.test.ts
apps/cli/src/agent/runtime/waitForNextPermissionModeMessage.test.ts
apps/cli/src/agent/tools/normalization/canonicalizeToolNameV2.mapping.test.ts
apps/cli/src/agent/tools/normalization/families/diff.schema.test.ts
apps/cli/src/agent/tools/normalization/families/diff.test.ts
apps/cli/src/agent/tools/normalization/families/edit.test.ts
apps/cli/src/agent/tools/normalization/families/execute.kilo.test.ts
apps/cli/src/agent/tools/normalization/families/read.kilo.test.ts
apps/cli/src/agent/tools/normalization/families/search.kilo.test.ts
apps/cli/src/agent/tools/normalization/families/task.test.ts
apps/cli/src/agent/tools/normalization/families/write.test.ts
apps/cli/src/agent/tools/normalization/fixtures.v1.calls.test.ts
apps/cli/src/agent/tools/normalization/fixtures.v1.catalog.test.ts
apps/cli/src/agent/tools/normalization/fixtures.v1.results.test.ts
apps/cli/src/agent/tools/normalization/index.test.ts
apps/cli/src/agent/tools/normalization/protocolSchemas.test.ts
apps/cli/src/agent/tools/trace/curateToolTraceFixtures.test.ts
apps/cli/src/agent/tools/trace/extractToolTraceFixtures.test.ts
apps/cli/src/agent/tools/trace/resolveStackToolTraceDir.test.ts
apps/cli/src/agent/tools/trace/toolTrace.test.ts
apps/cli/src/agent/transport/utils/jsonStdoutFilter.test.ts
apps/cli/src/agent/voice/agent/VoiceAgentManager.test.ts
apps/cli/src/agent/voice/agent/permissionPolicy.test.ts
apps/cli/src/agent/voice/agent/voiceAgentPrompts.test.ts
apps/cli/src/api/api.connectedServicesV2.test.ts
apps/cli/src/api/api.connectedServicesQuotasV3.test.ts
apps/cli/src/api/api.loopbackUrl.test.ts
apps/cli/src/api/api.plaintextSessionCreate.test.ts
apps/cli/src/api/api.sessionDataEncryptionKey.test.ts
apps/cli/src/api/api.test.ts
apps/cli/src/api/apiMachine.connectOrder.test.ts
apps/cli/src/api/apiMachine.loopbackUrl.test.ts
apps/cli/src/api/apiMachine.spawnSession.test.ts
apps/cli/src/api/apiMachine.transports.test.ts
apps/cli/src/api/apiMachine.v2ChangesReconnect.test.ts
apps/cli/src/api/changes.test.ts
apps/cli/src/api/client/encryptionKey.test.ts
apps/cli/src/api/client/loopbackUrl.test.ts
apps/cli/src/api/client/serializeAxiosErrorForLog.test.ts
apps/cli/src/api/encryption.boxBundle.test.ts
apps/cli/src/api/encryption.libsodiumDecryptForSecretKey.test.ts
apps/cli/src/api/machine/ensureMachineRegistered.test.ts
apps/cli/src/api/machine/rpcHandlers.memory.deepSearch.test.ts
apps/cli/src/api/machine/rpcHandlers.test.ts
apps/cli/src/api/pushNotificationData.test.ts
apps/cli/src/api/pushNotifications.fetchPushTokens.test.ts
apps/cli/src/api/pushNotifications.sendToAllDevices.test.ts
apps/cli/src/api/pushTicketLogSummary.test.ts
apps/cli/src/api/session/acpMessageEnvelope.test.ts
apps/cli/src/api/session/acpTokenCountUsage.test.ts
apps/cli/src/api/session/acpTokenCountUsageReport.test.ts
apps/cli/src/api/session/fetchEncryptedTranscriptWindow.test.ts
apps/cli/src/api/session/sessionClient.echoToSender.test.ts
apps/cli/src/api/session/sessionMessageCatchUp.plain.test.ts
... +491 more
```

### Integration — apps/cli (Vitest)

- Total audited files: 184
- UNWIRED: 2
- BRITTLE_HIGH: 38
- SLOW_HIGH: 16
- DUPLICATION: 174

**UNWIRED**

```text
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
```

**BRITTLE_HIGH**

```text
apps/cli/src/api/offline/serverConnectionErrors.integration.test.ts
apps/cli/src/api/sessionClient.changesCursorIsolation.integration.test.ts
apps/cli/src/api/sessionClient.codexMissingToolMapping.integration.test.ts
apps/cli/src/backends/claude/claudeRemoteLauncher.integration.test.ts
apps/cli/src/backends/claude/runClaude.fastStart.integration.test.ts
apps/cli/src/backends/codex/cli/capability.loadSession.e2e.test.ts
apps/cli/src/backends/codex/runCodex.acpResumePreflight.integration.test.ts
apps/cli/src/backends/codex/runCodex.fastStart.integration.test.ts
apps/cli/src/backends/opencode/cli/capability.loadSession.e2e.test.ts
apps/cli/src/cli/commands/session/delegate/start.integration.test.ts
apps/cli/src/cli/commands/session/plan/start.integration.test.ts
apps/cli/src/cli/commands/session/review/start.integration.test.ts
apps/cli/src/cli/commands/session/send.integration.test.ts
apps/cli/src/cli/commands/session/voiceAgent/start.feat.voice.agent.integration.test.ts
apps/cli/src/daemon/daemon.integration.test.ts
apps/cli/src/daemon/pidSafety.real.integration.test.ts
apps/cli/src/daemon/reattach.real.integration.test.ts
apps/cli/src/daemon/startDaemon.automation.integration.test.ts
apps/cli/src/integrations/difftastic/index.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.diffRead.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.patchAndValidation.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/ui/auth.noninteractive.claim.integration.test.ts
packages/tests/suites/ui-e2e/session.sourceControl.reviewScroll.spec.ts
packages/tests/suites/ui-e2e/session.transcript.catchup.smallReconnect.spec.ts
apps/cli/.env.integration-test
apps/cli/src/utils/spawnHappyCLI.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.promptUsage.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionUpdate.maxUpdates.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.historyImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/agent/localControl/__tests__/discardPendingBeforeSwitchToLocal.test.ts
apps/cli/src/backends/codex/__tests__/rolloutToolNameMapping.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutDiscovery.test.ts
apps/cli/src/test-setup.ts
```

**SLOW_HIGH**

```text
apps/cli/src/backends/claude/runClaude.fastStart.integration.test.ts
apps/cli/src/backends/codex/cli/capability.loadSession.e2e.test.ts
apps/cli/src/backends/codex/runCodex.fastStart.integration.test.ts
apps/cli/src/daemon/daemon.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.diffRead.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.patchAndValidation.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteFlows.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteGuards.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
packages/tests/suites/ui-e2e/session.sourceControl.reviewScroll.spec.ts
packages/tests/suites/ui-e2e/session.transcript.catchup.smallReconnect.spec.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.initDelay.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.waitForResponseComplete.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/test-setup.ts
```

**DUPLICATION**

```text
apps/cli/src/api/offline/serverConnectionErrors.integration.test.ts
apps/cli/src/api/sessionClient.changesCursorIsolation.integration.test.ts
apps/cli/src/api/sessionClient.codexMissingToolMapping.integration.test.ts
apps/cli/src/api/sessionClient.pendingQueueV2.integration.test.ts
apps/cli/src/backends/claude/claudeLocalLauncher.integration.test.ts
apps/cli/src/backends/claude/claudeRemoteLauncher.integration.test.ts
apps/cli/src/backends/claude/executionRuns/claudeSdkExecutionRunSidechain.integration.test.ts
apps/cli/src/backends/claude/runClaude.fastStart.integration.test.ts
apps/cli/src/backends/codex/cli/capability.loadSession.e2e.test.ts
apps/cli/src/backends/codex/codexLocalLauncher.integration.test.ts
apps/cli/src/backends/codex/localControl/createLocalControlSupportResolver.integration.test.ts
apps/cli/src/backends/codex/runCodex.acpResumePreflight.integration.test.ts
apps/cli/src/backends/codex/runCodex.fastStart.integration.test.ts
apps/cli/src/backends/kilo/cli/capability.loadSession.e2e.test.ts
apps/cli/src/backends/opencode/cli/capability.loadSession.e2e.test.ts
apps/cli/src/capabilities/probes/agentModelsProbe.integration.test.ts
apps/cli/src/cli/commands/auth.pairRemote.integration.test.ts
apps/cli/src/cli/commands/auth.pairing.integration.test.ts
apps/cli/src/cli/commands/resume.integration.test.ts
apps/cli/src/cli/commands/session/archive.integration.test.ts
apps/cli/src/cli/commands/session/create.integration.test.ts
apps/cli/src/cli/commands/session/create.plain.integration.test.ts
apps/cli/src/cli/commands/session/delegate/start.integration.test.ts
apps/cli/src/cli/commands/session/executionRunGet.integration.test.ts
apps/cli/src/cli/commands/session/history.integration.test.ts
apps/cli/src/cli/commands/session/list.integration.test.ts
apps/cli/src/cli/commands/session/plan/start.integration.test.ts
apps/cli/src/cli/commands/session/review/start.integration.test.ts
apps/cli/src/cli/commands/session/run/action.integration.test.ts
apps/cli/src/cli/commands/session/run/send.integration.test.ts
apps/cli/src/cli/commands/session/run/start.integration.test.ts
apps/cli/src/cli/commands/session/run/stop.integration.test.ts
apps/cli/src/cli/commands/session/run/stream.integration.test.ts
apps/cli/src/cli/commands/session/run/wait.integration.test.ts
apps/cli/src/cli/commands/session/runList.integration.test.ts
apps/cli/src/cli/commands/session/send.integration.test.ts
apps/cli/src/cli/commands/session/send.plain.integration.test.ts
apps/cli/src/cli/commands/session/setModel.integration.test.ts
apps/cli/src/cli/commands/session/setPermissionMode.integration.test.ts
apps/cli/src/cli/commands/session/setTitle.integration.test.ts
apps/cli/src/cli/commands/session/status.integration.test.ts
apps/cli/src/cli/commands/session/stop.integration.test.ts
apps/cli/src/cli/commands/session/voiceAgent/start.feat.voice.agent.integration.test.ts
apps/cli/src/cli/commands/session/wait.integration.test.ts
apps/cli/src/daemon/automation/automationWorker.feat.automations.integration.test.ts
apps/cli/src/daemon/controlClient.pidSafety.integration.test.ts
apps/cli/src/daemon/daemon.integration.test.ts
apps/cli/src/daemon/multiDaemon.integration.test.ts
apps/cli/src/daemon/pidSafety.real.integration.test.ts
apps/cli/src/daemon/reattach.real.integration.test.ts
apps/cli/src/daemon/startDaemon.automation.integration.test.ts
apps/cli/src/daemon/startDaemon.noninteractiveAuth.integration.test.ts
apps/cli/src/daemon/startDaemon.tmuxSpawn.integration.test.ts
apps/cli/src/integrations/difftastic/index.integration.test.ts
apps/cli/src/integrations/ripgrep/index.integration.test.ts
apps/cli/src/integrations/tmux/tmux.real.integration.test.ts
apps/cli/src/mcp/startHappyServer.integration.test.ts
apps/cli/src/rpc/handlers/registerSessionHandlers.capabilities.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.changeDiscard.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.diffRead.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.historyRevert.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.patchAndValidation.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteFlows.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteGuards.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteSetup.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.workingDirectoryTilde.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/session/replay/hydrateReplayDialogFromTranscript.integration.test.ts
apps/cli/src/ui/auth.legacyServerFallback.integration.test.ts
apps/cli/src/ui/auth.noninteractive.claim.integration.test.ts
apps/cli/src/utils/spawnHappyCLI.invocation.integration.test.ts
packages/tests/suites/ui-e2e/session.sourceControl.reviewScroll.spec.ts
packages/tests/suites/ui-e2e/session.transcript.catchup.reconnect.spec.ts
packages/tests/suites/ui-e2e/session.transcript.catchup.smallReconnect.spec.ts
apps/cli/.env.integration-test
apps/cli/src/backends/codex/codexLocalLauncher.testkit.ts
apps/cli/src/agent/acp/runtime/createAcpRuntime.testkit.ts
apps/cli/package.json
apps/cli/src/utils/spawnHappyCLI.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
apps/cli/scripts/__tests__/buildSharedDeps.test.ts
apps/cli/scripts/__tests__/bundleWorkspaceDeps.test.ts
apps/cli/scripts/__tests__/childProcessOptions.test.ts
apps/cli/scripts/__tests__/happierBinPreflightHoistedNodeModules.test.ts
apps/cli/scripts/__tests__/happierDependencyPreflight.test.ts
apps/cli/scripts/__tests__/publishBundledDependencies.test.ts
apps/cli/scripts/__tests__/ripgrep_launcher.test.ts
apps/cli/scripts/__tests__/vitestLaneSeparation.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.acpFs.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.authenticate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.configOptions.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.dispose.killsProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsEnabled.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsMethods.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.initDelay.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionDeniedCleanup.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionSeed.toolCallUpdateFallback.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.promptUsage.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.responseCompletionError.idle.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModels.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModes.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionUpdate.maxUpdates.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.stderrArtifacts.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.toolCallUpdate.kindInference.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.usageUpdate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.waitForResponseComplete.test.ts
apps/cli/src/agent/acp/__tests__/createAcpFilteredStdoutReadable.multiline.test.ts
apps/cli/src/agent/acp/__tests__/killProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.capture.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.captureErrors.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.destroyedWrite.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.test.ts
apps/cli/src/agent/acp/__tests__/sessionUpdateHandlers.test.ts
apps/cli/src/agent/acp/bridge/__tests__/acpCommonHandlers.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplayHistory.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplaySidechain.test.ts
apps/cli/src/agent/acp/permissions/__tests__/permissionRequest.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.configOptions.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.historyImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.modelOutputStreaming.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.pendingPump.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sessionModels.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sidechainImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.thinkingState.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.tokenCountForwarding.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.traceMarkers.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.turnHooks.test.ts
apps/cli/src/agent/acp/updates/__tests__/content.test.ts
apps/cli/src/agent/acp/updates/__tests__/events.test.ts
apps/cli/src/agent/acp/updates/__tests__/messages.test.ts
apps/cli/src/agent/localControl/__tests__/confirmDiscardBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/createLocalRemoteModeController.test.ts
apps/cli/src/agent/localControl/__tests__/discardPendingBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/discardQueuedAndPendingForLocalSwitch.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.startAtEndErrors.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.test.ts
apps/cli/src/api/testkit/sessionClientTestkit.ts
apps/cli/src/backends/codex/__tests__/buildCodexMcpStartConfigForMessage.test.ts
apps/cli/src/backends/codex/__tests__/emitReadyIfIdle.test.ts
apps/cli/src/backends/codex/__tests__/extractCodexToolErrorText.test.ts
apps/cli/src/backends/codex/__tests__/extractMcpToolCallResultOutput.test.ts
apps/cli/src/backends/codex/__tests__/resolveCodexMessageModel.test.ts
apps/cli/src/backends/codex/__tests__/resumeSessionIdConsumption.test.ts
apps/cli/src/backends/codex/__tests__/rolloutToolNameMapping.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.lifecycle.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.test.ts
apps/cli/src/backends/codex/localControl/__tests__/createLocalControlSupportResolver.test.ts
apps/cli/src/backends/codex/localControl/__tests__/localControlSupport.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutDiscovery.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutMapper.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
apps/cli/src/scm/rpc/__tests__/testRpcHarness.ts
apps/cli/src/subprocess/supervision/__tests__/backoff.test.ts
apps/cli/src/subprocess/supervision/__tests__/exitClassifier.test.ts
apps/cli/src/subprocess/supervision/__tests__/managedChildProcess.waitForTermination.test.ts
apps/cli/src/subprocess/supervision/__tests__/restartController.test.ts
apps/cli/src/subprocess/supervision/__tests__/supervisedProcess.unhandledRejection.test.ts
apps/cli/src/test-setup.ts
apps/cli/src/testkit/backends/permissionHandler.ts
apps/cli/src/testkit/backends/sessionMetadata.ts
apps/cli/src/testkit/backends/transport.ts
apps/cli/src/testkit/env.testkit.ts
apps/cli/src/ui/testkit/authNonInteractiveGlobals.testkit.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.test.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.testkit.ts
apps/cli/src/utils/__tests__/runtime.test.ts
apps/cli/src/utils/__tests__/runtimeIntegration.test.ts
apps/cli/src/vitestSetup.ts
apps/cli/vitest.integration.config.ts
scripts/testing/featureTestGating.ts
```

### Slow — apps/cli (Vitest)

- Total audited files: 123
- UNWIRED: 8
- BRITTLE_HIGH: 16
- SLOW_HIGH: 11
- DUPLICATION: 113

**UNWIRED**

```text
apps/cli/src/api/sessionClient.longOfflineReconnect.slow.test.ts
apps/cli/src/backends/codex/acp/runtime.permissionMode.slow.test.ts
apps/cli/src/cli/commands/auth.methodFlag.slow.test.ts
apps/cli/src/cli/runtime/update/runtimeReexec.wiring.slow.test.ts
apps/cli/src/daemon/daemon.spawnStop.stress.slow.test.ts
apps/cli/package.json
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
```

**BRITTLE_HIGH**

```text
apps/cli/src/api/sessionClient.longOfflineReconnect.slow.test.ts
apps/cli/src/cli/runtime/update/runtimeReexec.wiring.slow.test.ts
apps/cli/src/daemon/daemon.spawnStop.stress.slow.test.ts
apps/cli/src/test-setup.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.promptUsage.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionUpdate.maxUpdates.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.historyImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/agent/localControl/__tests__/discardPendingBeforeSwitchToLocal.test.ts
apps/cli/src/backends/codex/__tests__/rolloutToolNameMapping.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutDiscovery.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.diffRead.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/test-setup.ts
```

**SLOW_HIGH**

```text
apps/cli/src/cli/runtime/update/runtimeReexec.wiring.slow.test.ts
apps/cli/src/daemon/daemon.spawnStop.stress.slow.test.ts
apps/cli/src/test-setup.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.initDelay.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.waitForResponseComplete.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteFlows.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteGuards.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/test-setup.ts
```

**DUPLICATION**

```text
apps/cli/src/api/sessionClient.longOfflineReconnect.slow.test.ts
apps/cli/src/backends/codex/acp/runtime.permissionMode.slow.test.ts
apps/cli/src/cli/commands/auth.methodFlag.slow.test.ts
apps/cli/src/cli/runtime/update/runtimeReexec.wiring.slow.test.ts
apps/cli/src/daemon/daemon.spawnStop.stress.slow.test.ts
apps/cli/vitest.slow.config.ts
apps/cli/src/test-setup.ts
scripts/testing/featureTestGating.ts
apps/cli/.env.integration-test
apps/cli/package.json
apps/cli/scripts/__tests__/buildSharedDeps.test.ts
apps/cli/scripts/__tests__/bundleWorkspaceDeps.test.ts
apps/cli/scripts/__tests__/happierBinPreflightHoistedNodeModules.test.ts
apps/cli/scripts/__tests__/happierDependencyPreflight.test.ts
apps/cli/scripts/__tests__/publishBundledDependencies.test.ts
apps/cli/scripts/__tests__/ripgrep_launcher.test.ts
apps/cli/scripts/__tests__/vitestLaneSeparation.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.acpFs.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.authenticate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.configOptions.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.dispose.killsProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsEnabled.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.fsMethods.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.initDelay.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionDeniedCleanup.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.permissionSeed.toolCallUpdateFallback.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.promptUsage.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.responseCompletionError.idle.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModels.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionModes.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.sessionUpdate.maxUpdates.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.stderrArtifacts.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.toolCallUpdate.kindInference.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.usageUpdate.test.ts
apps/cli/src/agent/acp/__tests__/AcpBackend.waitForResponseComplete.test.ts
apps/cli/src/agent/acp/__tests__/createAcpFilteredStdoutReadable.multiline.test.ts
apps/cli/src/agent/acp/__tests__/killProcessTree.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.capture.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.captureErrors.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.destroyedWrite.test.ts
apps/cli/src/agent/acp/__tests__/nodeToWebStreams.test.ts
apps/cli/src/agent/acp/__tests__/sessionUpdateHandlers.test.ts
apps/cli/src/agent/acp/bridge/__tests__/acpCommonHandlers.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplayHistory.test.ts
apps/cli/src/agent/acp/history/__tests__/importAcpReplaySidechain.test.ts
apps/cli/src/agent/acp/permissions/__tests__/permissionRequest.test.ts
apps/cli/src/agent/acp/runtime/__tests__/abortAcpRuntimeTurnIfNeeded.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.configOptions.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.historyImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.process.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.inFlightSteer.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.modelOutputStreaming.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.pendingPump.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sessionModels.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sidechainImport.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.thinkingState.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.tokenCountForwarding.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.traceMarkers.test.ts
apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.turnHooks.test.ts
apps/cli/src/agent/acp/updates/__tests__/content.test.ts
apps/cli/src/agent/acp/updates/__tests__/events.test.ts
apps/cli/src/agent/acp/updates/__tests__/messages.test.ts
apps/cli/src/agent/localControl/__tests__/confirmDiscardBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/createLocalRemoteModeController.test.ts
apps/cli/src/agent/localControl/__tests__/discardPendingBeforeSwitchToLocal.test.ts
apps/cli/src/agent/localControl/__tests__/discardQueuedAndPendingForLocalSwitch.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.startAtEndErrors.test.ts
apps/cli/src/agent/localControl/__tests__/jsonlFollower.test.ts
apps/cli/src/api/testkit/sessionClientTestkit.ts
apps/cli/src/backends/codex/__tests__/buildCodexMcpStartConfigForMessage.test.ts
apps/cli/src/backends/codex/__tests__/emitReadyIfIdle.test.ts
apps/cli/src/backends/codex/__tests__/extractCodexToolErrorText.test.ts
apps/cli/src/backends/codex/__tests__/extractMcpToolCallResultOutput.test.ts
apps/cli/src/backends/codex/__tests__/resolveCodexMessageModel.test.ts
apps/cli/src/backends/codex/__tests__/resumeSessionIdConsumption.test.ts
apps/cli/src/backends/codex/__tests__/rolloutToolNameMapping.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.lifecycle.test.ts
apps/cli/src/backends/codex/localControl/__tests__/codexRolloutMirror.test.ts
apps/cli/src/backends/codex/localControl/__tests__/createLocalControlSupportResolver.test.ts
apps/cli/src/backends/codex/localControl/__tests__/localControlSupport.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutDiscovery.test.ts
apps/cli/src/backends/codex/localControl/__tests__/rolloutMapper.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.test.ts
apps/cli/src/daemon/testkit/realIntegration.testkit.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.changeDiscard.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.commitCreate.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.diffRead.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.historyRevert.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.patchAndValidation.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteFlows.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteGuards.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.remoteSetup.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmRpc.workingDirectoryTilde.integration.test.ts
apps/cli/src/scm/rpc/__tests__/scmSapling.integration.test.ts
apps/cli/src/scm/rpc/__tests__/testRpcHarness.ts
apps/cli/src/subprocess/supervision/__tests__/backoff.test.ts
apps/cli/src/subprocess/supervision/__tests__/exitClassifier.test.ts
apps/cli/src/subprocess/supervision/__tests__/managedChildProcess.waitForTermination.test.ts
apps/cli/src/subprocess/supervision/__tests__/restartController.test.ts
apps/cli/src/subprocess/supervision/__tests__/supervisedProcess.unhandledRejection.test.ts
apps/cli/src/test-setup.ts
apps/cli/src/testkit/backends/permissionHandler.ts
apps/cli/src/testkit/backends/sessionMetadata.ts
apps/cli/src/testkit/backends/transport.ts
apps/cli/src/testkit/env.testkit.ts
apps/cli/src/ui/testkit/authNonInteractiveGlobals.testkit.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.test.ts
apps/cli/src/ui/testkit/axiosFastifyAdapter.testkit.ts
apps/cli/src/utils/__tests__/runtime.test.ts
apps/cli/src/utils/__tests__/runtimeIntegration.test.ts
apps/cli/src/vitestSetup.ts
apps/cli/vitest.slow.config.ts
scripts/testing/featureTestGating.ts
```

### Unit — apps/server (Vitest)

- Total audited files: 165
- UNWIRED: 3
- BRITTLE_HIGH: 23
- SLOW_HIGH: 2
- DUPLICATION: 162

**UNWIRED**

```text
apps/server/sources/storage/blob/processImage.spec.ts
apps/server/vitest.config.ts
scripts/testing/featureTestGating.ts
```

**BRITTLE_HIGH**

```text
apps/server/scripts/migrationsConsistency.spec.ts
apps/server/scripts/mysqlBaselineMigration.spec.ts
apps/server/sources/app/api/routes/dev/devRoutes.spec.ts
apps/server/sources/app/api/routes/share/publicShareRoutes.optionalAuth.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.secure.spec.ts
apps/server/sources/app/artifacts/artifactWriteService.spec.ts
apps/server/sources/app/changes/accountChangeCleanup.spec.ts
apps/server/sources/app/feed/feedPost.changes.spec.ts
apps/server/sources/app/kv/kvMutate.changes.spec.ts
apps/server/sources/app/oauth/providers/oidc/oidcDiscovery.timeout.spec.ts
apps/server/sources/app/presence/presenceRedisQueue.worker.spec.ts
apps/server/sources/app/presence/sessionCache.machinePresence.spec.ts
apps/server/sources/app/presence/sessionCache.sessionPresence.spec.ts
apps/server/sources/app/session/sessionDelete.changes.spec.ts
apps/server/sources/app/session/sessionWriteService.spec.ts
apps/server/sources/app/social/friends.changes.spec.ts
apps/server/sources/app/social/usernameUpdate.changes.spec.ts
apps/server/sources/storage/blob/files.spec.ts
apps/server/sources/utils/process/processHandlers.spec.ts
apps/server/sources/utils/runtime/forever.backoffAbort.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.testkit.ts
apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts
apps/server/sources/testkit/startServerMocks.ts
```

**SLOW_HIGH**

```text
apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.ts
```

**DUPLICATION**

```text
apps/server/sources/app/api/routes/auth/registerPairingAuthRoutes.rateLimit.spec.ts
apps/server/sources/app/api/utils/enableErrorHandlers.sentry.spec.ts
apps/server/sources/app/integrations/tailscale/tailscaleServePublicUrlInference.test.ts
apps/server/sources/app/integrations/tailscale/tailscaleServeStatusParse.test.ts
apps/server/sources/app/monitoring/sentry.spec.ts
apps/server/sources/app/auth/keyless/resolveKeylessAutoProvisionEligibility.test.ts
apps/server/sources/app/features/e2ee/resolveKeylessAccountsEnabled.test.ts
apps/server/scripts/dev.fullArgs.spec.ts
apps/server/scripts/dev.lightPlan.spec.ts
apps/server/scripts/generateClients.spec.ts
apps/server/scripts/migrate.light.deployPlan.spec.ts
apps/server/scripts/migrationsConsistency.spec.ts
apps/server/scripts/mysqlBaselineMigration.spec.ts
apps/server/scripts/run-server.sh.test.ts
apps/server/scripts/schemaSync.spec.ts
apps/server/sources/app/api/api.listenHost.spec.ts
apps/server/sources/app/api/routes/accessKeys/accessKeysRoutes.put.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/artifacts/artifactsRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/automations/automationRoutes.feat.automations.spec.ts
apps/server/sources/app/api/routes/changes/changesRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/changes/changesRoutes.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oauthExternal.rateLimit.feat.connectedServices.spec.ts
apps/server/sources/app/api/routes/connect/connectedServicesV2/exchangeConnectedServiceOauthTokens.test.ts
apps/server/sources/app/api/routes/connect/oauthExternal/createExternalAuthorizeUrl.spec.ts
apps/server/sources/app/api/routes/dev/devRoutes.spec.ts
apps/server/sources/app/api/routes/diagnostics/bugReportDiagnosticsRoutes.spec.ts
apps/server/sources/app/api/routes/features/featuresRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/feed/feedRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/kv/kvRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/pendingRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.listing.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.messages.afterSeq.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.messages.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.messagesByLocalId.rateLimit.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v1sessions.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2archive.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2archivedSessions.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2messages.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2patch.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2sessionById.spec.ts
apps/server/sources/app/api/routes/session/sessionRoutes.v2sessions.spec.ts
apps/server/sources/app/api/routes/share/publicShareRoutes.optionalAuth.spec.ts
apps/server/sources/app/api/routes/share/shareRoutes.changes.spec.ts
apps/server/sources/app/api/routes/share/shareRoutes.rateLimit.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.complete.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.rateLimit.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.secure.spec.ts
apps/server/sources/app/api/socket/sessionUpdateHandler.spec.ts
apps/server/sources/app/api/uiConfig.spec.ts
apps/server/sources/app/api/utils/apiRateLimitCatalog.spec.ts
apps/server/sources/app/api/utils/apiRateLimitPolicy.spec.ts
apps/server/sources/app/api/utils/enableAuthentication.spec.ts
apps/server/sources/app/api/utils/enableErrorHandlers.spec.ts
apps/server/sources/app/api/utils/enableServeUi.spec.ts
apps/server/sources/app/artifacts/artifactWriteService.spec.ts
apps/server/sources/app/auth/auth.oauthState.fallback.spec.ts
apps/server/sources/app/auth/auth.oauthState.spec.ts
apps/server/sources/app/auth/auth.persistentSeedCompatibility.spec.ts
apps/server/sources/app/auth/auth.tokenCache.spec.ts
apps/server/sources/app/auth/authPolicy.interval.spec.ts
apps/server/sources/app/auth/authPolicy.offboardingEnabled.spec.ts
apps/server/sources/app/auth/authPolicy.offboardingMode.spec.ts
apps/server/sources/app/auth/protocol.authErrors.spec.ts
apps/server/sources/app/auth/providers/github/socialProfile.spec.ts
apps/server/sources/app/auth/providers/identityProviders/registry.spec.ts
apps/server/sources/app/auth/providers/mtls/mtlsIdentity.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcProviderConfig.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcProviderModuleFactory.spec.ts
apps/server/sources/app/automations/automationAssignmentService.test.ts
apps/server/sources/app/automations/automationClaimService.test.ts
apps/server/sources/app/automations/automationRunQueueService.test.ts
apps/server/sources/app/automations/automationSchedulingService.test.ts
apps/server/sources/app/automations/automationSummaryService.test.ts
apps/server/sources/app/automations/automationValidation.feat.automations.test.ts
apps/server/sources/app/changes/accountChangeCleanup.spec.ts
apps/server/sources/app/changes/markAccountChanged.spec.ts
apps/server/sources/app/events/eventRouter.protocol.spec.ts
apps/server/sources/app/events/eventRouter.rooms.spec.ts
apps/server/sources/app/events/sharingEvents.spec.ts
apps/server/sources/app/features/attachmentsUploadsFeature.feat.attachments.uploads.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.methods.connectAction.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.methods.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.mtls.autoRedirect.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.oauthKeyless.autoRedirect.spec.ts
apps/server/sources/app/features/authFeature.feat.auth.ui.recoveryKeyReminder.spec.ts
apps/server/sources/app/features/automationsFeature.feat.automations.spec.ts
apps/server/sources/app/features/bugReportsFeature.feat.bugReports.spec.ts
apps/server/sources/app/features/catalog/readFeatureEnv.test.ts
apps/server/sources/app/features/catalog/resolveServerFeaturePayload.spec.ts
apps/server/sources/app/features/catalog/serverFeatureGate.spec.ts
apps/server/sources/app/features/connectedServicesFeature.feat.connectedServices.spec.ts
apps/server/sources/app/features/friendsFeature.feat.social.friends.spec.ts
apps/server/sources/app/features/serverFeatureRegistry.test.ts
apps/server/sources/app/features/updatesFeature.feat.updates.ota.spec.ts
apps/server/sources/app/features/voiceFeature.feat.voice.spec.ts
apps/server/sources/app/feed/feedPost.changes.spec.ts
apps/server/sources/app/kv/kvMutate.changes.spec.ts
apps/server/sources/app/oauth/pkce.spec.ts
apps/server/sources/app/oauth/providers/github.timeout.spec.ts
apps/server/sources/app/oauth/providers/oidc/oidcDiscovery.timeout.spec.ts
apps/server/sources/app/oauth/providers/oidc/oidcOAuthProvider.spec.ts
apps/server/sources/app/oauth/providers/registry.spec.ts
apps/server/sources/app/presence/presenceBatcher.spec.ts
apps/server/sources/app/presence/presenceMode.spec.ts
apps/server/sources/app/presence/presenceRecorder.spec.ts
apps/server/sources/app/presence/presenceRedisQueue.worker.spec.ts
apps/server/sources/app/presence/sessionCache.machinePresence.spec.ts
apps/server/sources/app/presence/sessionCache.sessionPresence.spec.ts
apps/server/sources/app/presence/timeout.spec.ts
apps/server/sources/app/session/messageContent/normalizeIncomingSessionMessageContent.spec.ts
apps/server/sources/app/session/pending/pendingMessageService.spec.ts
apps/server/sources/app/session/sessionDelete.changes.spec.ts
apps/server/sources/app/session/sessionWriteService.spec.ts
apps/server/sources/app/share/accessControl.spec.ts
apps/server/sources/app/share/accessLogger.spec.ts
apps/server/sources/app/share/sessionParticipants.spec.ts
apps/server/sources/app/social/friendAdd.misconfig.spec.ts
apps/server/sources/app/social/friendNotification.spec.ts
apps/server/sources/app/social/friends.changes.spec.ts
apps/server/sources/app/social/friendsPolicy.spec.ts
apps/server/sources/app/social/usernamePolicy.spec.ts
apps/server/sources/app/social/usernameUpdate.changes.spec.ts
apps/server/sources/app/voice/voiceSessionLeaseCleanup.spec.ts
apps/server/sources/config/backends.spec.ts
apps/server/sources/config/env.spec.ts
apps/server/sources/flavors/light/env.spec.ts
apps/server/sources/flavors/light/files.spec.ts
apps/server/sources/flavors/light/sqliteMigrations.spec.ts
apps/server/sources/startServer.role.spec.ts
apps/server/sources/storage/blob/files.spec.ts
apps/server/sources/storage/blob/processImage.spec.ts
apps/server/sources/storage/inTx.spec.ts
apps/server/sources/storage/locks/pgliteLock.spec.ts
apps/server/sources/storage/prisma.generatedClients.spec.ts
apps/server/sources/storage/prisma.spec.ts
apps/server/sources/utils/collections/lru.spec.ts
apps/server/sources/utils/logging/log.transportTargets.spec.ts
apps/server/sources/utils/network/urlSafety.spec.ts
apps/server/sources/utils/process/processHandlers.spec.ts
apps/server/sources/utils/process/shutdown.spec.ts
apps/server/sources/utils/runtime/delay.spec.ts
apps/server/sources/utils/runtime/forever.backoffAbort.spec.ts
apps/server/sources/utils/strings/separateName.spec.ts
apps/server/sources/voice/elevenLabsEnv.spec.ts
apps/server/package.json
apps/server/sources/app/api/utils/enableAuthentication.ts
apps/server/sources/app/api/routes/session/sessionRoutes.testkit.ts
apps/server/sources/app/api/testkit/appLifecycle.ts
apps/server/sources/app/api/testkit/env.ts
apps/server/sources/app/api/testkit/oidcStub.ts
apps/server/sources/app/api/testkit/routeHarness.ts
apps/server/sources/app/api/testkit/socketHarness.ts
apps/server/sources/app/api/testkit/sqliteFastify.ts
apps/server/sources/app/api/testkit/txHarness.ts
apps/server/sources/app/social/socialTestHarness.ts
apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.ts
apps/server/sources/testkit/startServerMocks.ts
apps/server/vitest.config.ts
scripts/testing/featureTestGating.ts
```

### Integration — apps/server (Vitest)

- Total audited files: 94
- UNWIRED: 5
- BRITTLE_HIGH: 23
- SLOW_HIGH: 33
- DUPLICATION: 93

**UNWIRED**

```text
apps/server/sources/app/api/routes/account/accountRoutes.encryption.keylessRejectE2ee.feat.e2ee.keylessAccounts.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthParams.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.vendorTokenDelete.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/user/friendsGithubGate.feat.social.friends.integration.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.integration.spec.ts
```

**BRITTLE_HIGH**

```text
apps/server/sources/app/api/routes/account/accountRoutes.encryption.keylessRejectE2ee.feat.e2ee.keylessAccounts.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.encryption.migrate.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.accountAuth.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.mtls.feat.auth.mtls.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.policy.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.terminalAuth.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV2.feat.connectedServices.quotas.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV3.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV3.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV2.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthCallback.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.keyless.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubCallback.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubUsernameFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcAllowlist.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcAuthFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcRefreshToken.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcUserInfo.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/features/featuresRoutes.integration.spec.ts
apps/server/sources/app/api/utils/enableAuthentication.authPolicy.integration.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcOffboardingRefresh.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.ts
```

**SLOW_HIGH**

```text
apps/server/sources/app/api/routes/account/accountRoutes.encryption.keylessRejectE2ee.feat.e2ee.keylessAccounts.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.encryption.migrate.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.accountAuth.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.mtls.feat.auth.mtls.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.pairingAuth.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.policy.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.terminalAuth.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV2.feat.connectedServices.quotas.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV3.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV3.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV2.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthCallback.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.keyless.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthParams.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubCallback.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubCallback.oauthStateAuthFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcAllowlist.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcAuthFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcRefreshToken.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcUserInfo.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.vendorTokens.presence.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/push/pushRoutes.clientServerUrl.integration.spec.ts
apps/server/sources/app/api/routes/share/publicShareRoutes.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/user/friendsGithubGate.feat.social.friends.integration.spec.ts
apps/server/sources/app/api/routes/user/userRoutes.badges.integration.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.integration.spec.ts
apps/server/sources/app/api/socket.authPolicy.integration.spec.ts
apps/server/sources/app/api/utils/enableAuthentication.authPolicy.integration.spec.ts
apps/server/sources/app/auth/enforceLoginEligibility.accountDisabled.integration.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcOffboardingRefresh.integration.spec.ts
apps/server/sources/app/session/pending/pendingMessageService.sharedSession.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.ts
```

**DUPLICATION**

```text
apps/server/sources/app/api/routes/account/accountRoutes.changes.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.encryption.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.encryption.keylessRejectE2ee.feat.e2ee.keylessAccounts.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.encryption.migrate.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.settingsV2.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.identityVisibility.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.profile.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/account/accountRoutes.v2usage.integration.spec.ts
apps/server/sources/app/api/routes/account/accountUsername.feat.social.friends.integration.spec.ts
apps/server/sources/app/api/routes/artifacts/artifactsRoutes.changes.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.accountAuth.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.mtls.feat.auth.mtls.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.pairingAuth.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.policy.integration.spec.ts
apps/server/sources/app/api/routes/auth/authRoutes.terminalAuth.integration.spec.ts
apps/server/sources/app/api/routes/automations/automationDaemonRoutes.feat.automations.integration.spec.ts
apps/server/sources/app/api/routes/changes/changesRoutes.automation.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV2.feat.connectedServices.quotas.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesQuotasV3.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV3.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.connectedServicesV2.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthCallback.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthFinalize.keyless.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.externalAuthParams.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubCallback.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubCallback.oauthStateAuthFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.githubUsernameFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcAllowlist.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcAuthFlow.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcRefreshToken.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.oidcUserInfo.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.vendorTokenDelete.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/connect/connectRoutes.vendorTokens.presence.feat.connectedServices.integration.spec.ts
apps/server/sources/app/api/routes/features/featuresRoutes.integration.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.changes.integration.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.claimExisting.integration.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.revoke.integration.spec.ts
apps/server/sources/app/api/routes/machines/machinesRoutes.updateExisting.integration.spec.ts
apps/server/sources/app/api/routes/push/pushRoutes.clientServerUrl.integration.spec.ts
apps/server/sources/app/api/routes/session/pendingRoutes.delete.integration.spec.ts
apps/server/sources/app/api/routes/session/pendingRoutes.enqueue.integration.spec.ts
apps/server/sources/app/api/routes/session/pendingRoutes.materialize.integration.spec.ts
apps/server/sources/app/api/routes/share/publicShareRoutes.changes.integration.spec.ts
apps/server/sources/app/api/routes/share/publicShareRoutes.plaintext.integration.spec.ts
apps/server/sources/app/api/routes/user/friendsGithubGate.feat.social.friends.integration.spec.ts
apps/server/sources/app/api/routes/user/userRoutes.badges.integration.spec.ts
apps/server/sources/app/api/routes/voice/voiceRoutes.feat.voice.integration.spec.ts
apps/server/sources/app/api/socket.authPolicy.integration.spec.ts
apps/server/sources/app/api/socket.redisAdapter.integration.spec.ts
apps/server/sources/app/api/socket/artifactUpdateHandler.changes.integration.spec.ts
apps/server/sources/app/api/socket/machineUpdateHandler.changes.integration.spec.ts
apps/server/sources/app/api/socket/rpcHandler.integration.spec.ts
apps/server/sources/app/api/socket/sessionUpdateHandler.changes.integration.spec.ts
apps/server/sources/app/api/socket/sessionUpdateHandler.sessionState.changes.integration.spec.ts
apps/server/sources/app/api/socket/sessionUpdateHandler.versionMismatch.integration.spec.ts
apps/server/sources/app/api/utils/enableAuthentication.authPolicy.integration.spec.ts
apps/server/sources/app/api/utils/enableMonitoring.integration.spec.ts
apps/server/sources/app/api/utils/logRedaction.integration.spec.ts
apps/server/sources/app/auth/auth.oauthState.ttl.integration.spec.ts
apps/server/sources/app/auth/enforceLoginEligibility.accountDisabled.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubConnect.changes.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubConnect.identityCollision.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubConnect.tokenStorage.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubDisconnect.changes.integration.spec.ts
apps/server/sources/app/auth/providers/github/githubLoginEligibility.upstreamFailure.integration.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcIdentityProvider.connect.integration.spec.ts
apps/server/sources/app/auth/providers/oidc/oidcOffboardingRefresh.integration.spec.ts
apps/server/sources/app/automations/automationClaimService.integration.spec.ts
apps/server/sources/app/automations/automationCrudService.integration.spec.ts
apps/server/sources/app/automations/automationRunService.integration.spec.ts
apps/server/sources/app/events/eventRouter.sessionRoomIsolation.integration.spec.ts
apps/server/sources/app/presence/presenceRedisQueue.integration.spec.ts
apps/server/sources/app/session/pending/pendingMessageService.sharedSession.integration.spec.ts
apps/server/sources/startServer.dbProvider.integration.spec.ts
apps/server/sources/startServer.lightShutdownOrder.integration.spec.ts
apps/server/sources/startServer.redisOptional.integration.spec.ts
apps/server/sources/startServer.voiceLeaseCleanup.integration.spec.ts
apps/server/sources/storage/prisma.pglite.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts
apps/server/package.json
apps/server/sources/app/api/testkit/appLifecycle.ts
apps/server/sources/app/api/testkit/env.ts
apps/server/sources/app/api/testkit/oidcStub.ts
apps/server/sources/app/api/testkit/routeHarness.ts
apps/server/sources/app/api/socket.env.testHelper.ts
apps/server/sources/app/api/testkit/socketHarness.ts
apps/server/sources/app/api/testkit/sqliteFastify.ts
apps/server/sources/app/api/testkit/txHarness.ts
apps/server/sources/testkit/lightSqliteHarness.ts
apps/server/sources/testkit/startServerMocks.ts
apps/server/vitest.integration.config.ts
scripts/testing/featureTestGating.ts
```

### DB Contract — apps/server (Vitest)

- Total audited files: 15
- UNWIRED: 0
- BRITTLE_HIGH: 1
- SLOW_HIGH: 1
- DUPLICATION: 14

**BRITTLE_HIGH**

```text
apps/server/sources/testkit/lightSqliteHarness.ts
```

**SLOW_HIGH**

```text
apps/server/sources/testkit/lightSqliteHarness.ts
```

**DUPLICATION**

```text
apps/server/sources/storage/dbcontract/portability.dbcontract.spec.ts
apps/server/package.json
apps/server/sources/app/api/testkit/appLifecycle.ts
apps/server/sources/app/api/testkit/env.ts
apps/server/sources/app/api/testkit/oidcStub.ts
apps/server/sources/app/api/testkit/routeHarness.ts
apps/server/sources/app/api/testkit/socketHarness.ts
apps/server/sources/app/api/testkit/sqliteFastify.ts
apps/server/sources/app/api/testkit/txHarness.ts
apps/server/sources/testkit/lightSqliteHarness.integration.spec.ts
apps/server/sources/testkit/lightSqliteHarness.ts
apps/server/sources/testkit/startServerMocks.ts
apps/server/vitest.dbcontract.config.ts
scripts/testing/featureTestGating.ts
```

### E2E Core — packages/tests (Vitest)

- Total audited files: 209
- UNWIRED: 167
- BRITTLE_HIGH: 54
- SLOW_HIGH: 39
- DUPLICATION: 201

**UNWIRED**

```text
packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.failClosed.pending.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.codex.materialize.feat.connectedServices.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.quotas.roundtrip.feat.connectedServices.quotas.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.codex.tempHome.seedsConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.firstMessageNotDropped.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.stopDaemonFromHomeDir.portability.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.accountModeSwitch.keepsExistingSessionsReadable.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.directShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.session.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/ephemeralTasks.scmCommitMessage.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.planAndDelegate.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.resumableResume.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.review.triage.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/fakeClaude.hookForwarder.safe.test.ts
packages/tests/suites/core-e2e/fakeClaude.streamJsonInput.test.ts
packages/tests/suites/core-e2e/featureNegotiation.automations.enablement.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.buildPolicy.enforcement.slow.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.scopeAndFallback.feat.social.friends.slow.e2e.test.ts
packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/memory.hints.searchWindow.roundtrip.slow.e2e.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.emitsSocketUpdates.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.idempotencyKey.test.ts
packages/tests/suites/core-e2e/messages.socket.echoToSender.test.ts
packages/tests/suites/core-e2e/messages.socketAck.didWrite.test.ts
packages/tests/suites/core-e2e/messages.socketAck.schema.test.ts
packages/tests/suites/core-e2e/messages.socketIdempotency.noRebroadcast.test.ts
packages/tests/suites/core-e2e/multiServer.groupTarget.sessionListProjection.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.serverScopedOperationRouting.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.switch.authAndSockets.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.modelOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.probeModels.capabilityInvoke.test.ts
packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.slashCommandsExtraction.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.cli.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.daemon.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.http.crud.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.idempotency.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.socketRpc.test.ts
packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts
packages/tests/suites/core-e2e/permissions.lifecycle.encrypted.test.ts
packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.metadataUpdate.midTurn.slow.e2e.test.ts
packages/tests/suites/core-e2e/providers.baselines.selectKeys.test.ts
packages/tests/suites/core-e2e/providers.baselines.test.ts
packages/tests/suites/core-e2e/providers.harness.homeIsolation.test.ts
packages/tests/suites/core-e2e/providers.kilo.specPresence.test.ts
packages/tests/suites/core-e2e/providers.presets.test.ts
packages/tests/suites/core-e2e/providers.resumeMode.test.ts
packages/tests/suites/core-e2e/providers.sidechainWait.test.ts
packages/tests/suites/core-e2e/providers.toolSchemas.test.ts
packages/tests/suites/core-e2e/providers.traceSatisfaction.test.ts
packages/tests/suites/core-e2e/reconnect.midstreamStorm.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.agentMessages.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.test.ts
packages/tests/suites/core-e2e/rpc.permissionRoundtrip.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.sapling.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/serverLight.portRetry.test.ts
packages/tests/suites/core-e2e/session.continueWithReplay.dataKeyHydration.slow.e2e.test.ts
packages/tests/suites/core-e2e/sessions.list.catchup.test.ts
packages/tests/suites/core-e2e/sharing.public.e2ee.encryptedDataKeyRequired.feat.sharing.public.feat.sharing.contentKeys.e2e.test.ts
packages/tests/suites/core-e2e/sharing.session.e2ee.encryptedDataKeyRequired.feat.sharing.session.feat.sharing.contentKeys.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/structuredMessages.reviewComments.v1.feat.files.reviewComments.e2e.test.ts
packages/tests/suites/core-e2e/testkit.utils.test.ts
packages/tests/suites/core-e2e/tmux.attach.selectWindow.test.ts
packages/tests/suites/core-e2e/toolTraceJsonl.test.ts
packages/tests/suites/core-e2e/voice.agent.daemon.rpc.feat.voice.agent.slow.e2e.test.ts
packages/tests/suites/core-e2e/voice.leaseMint.accountScoped.feat.voice.test.ts
packages/tests/suites/core-e2e/voice.localTts.kokoro.settingsRoundtrip.feat.voice.test.ts
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

**BRITTLE_HIGH**

```text
packages/tests/suites/core-e2e/auth.pairing.desktopQrMobileScan.roundtrip.feat.auth.pairing.desktopQrMobileScan.e2e.test.ts
packages/tests/suites/core-e2e/automations.leaseTakeover.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.argsAndPermissions.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.mcpConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.taskoutput.sidechains.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.acp.inFlightSteer.pendingQueue.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/codex.localControl.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.failClosed.pending.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.codex.materialize.feat.connectedServices.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.codex.tempHome.seedsConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.messageModeEnforcement.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.plaintextOnlyPolicy.guards.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/ephemeralTasks.scmCommitMessage.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.resumableResume.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.review.triage.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.buildPolicy.enforcement.slow.e2e.test.ts
packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.modelOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.slashCommandsExtraction.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.daemon.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.metadataUpdate.midTurn.slow.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.sapling.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/session.continueWithReplay.dataKeyHydration.slow.e2e.test.ts
packages/tests/suites/core-e2e/sharing.session.e2ee.encryptedDataKeyRequired.feat.sharing.session.feat.sharing.contentKeys.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/tmux.attach.selectWindow.test.ts
packages/tests/suites/core-e2e/voice.agent.daemon.rpc.feat.voice.agent.slow.e2e.test.ts
packages/tests/suites/core-e2e/voice.leaseMint.accountScoped.feat.voice.test.ts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
```

**SLOW_HIGH**

```text
packages/tests/suites/core-e2e/claude.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.argsAndPermissions.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.mcpConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.taskoutput.sidechains.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.acp.inFlightSteer.pendingQueue.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/codex.localControl.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.failClosed.pending.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.codex.materialize.feat.connectedServices.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.codex.tempHome.seedsConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.firstMessageNotDropped.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.review.triage.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/memory.hints.searchWindow.roundtrip.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.modelOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.cli.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.daemon.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.metadataUpdate.midTurn.slow.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.sapling.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/voice.agent.daemon.rpc.feat.voice.agent.slow.e2e.test.ts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
```

**DUPLICATION**

```text
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/suites/core-e2e/accountSettings.notifications.roundtrip.test.ts
packages/tests/suites/core-e2e/agentState.multiDeviceReconnect.test.ts
packages/tests/suites/core-e2e/auth.mtls.keyless.plaintext.roundtrip.feat.auth.mtls.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/auth.pairing.desktopQrMobileScan.roundtrip.feat.auth.pairing.desktopQrMobileScan.e2e.test.ts
packages/tests/suites/core-e2e/automations.actions.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.crud.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.existingSession.pendingBridge.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/automations.leaseTakeover.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/automations.lifecycle.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.offlineRecovery.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/baselines.scoreShape.test.ts
packages/tests/suites/core-e2e/changes.catchupHints.test.ts
packages/tests/suites/core-e2e/claude.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.argsAndPermissions.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.mcpConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.taskoutput.sidechains.slow.e2e.test.ts
packages/tests/suites/core-e2e/cliDist.sharedDeps.test.ts
packages/tests/suites/core-e2e/codex.acp.inFlightSteer.pendingQueue.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/codex.localControl.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.resume.mcpStripsAcpState.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.failClosed.pending.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.codex.materialize.feat.connectedServices.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.quotas.roundtrip.feat.connectedServices.quotas.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.codex.tempHome.seedsConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.firstMessageNotDropped.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.accountModeSwitch.keepsExistingSessionsReadable.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.defaultAccountMode.roundtrip.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.directShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.session.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.messageModeEnforcement.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.pendingQueueV2.materialize.roundtrip.feat.encryption.plaintextStorage.feat.sharing.pendingQueueV2.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.plaintextOnlyPolicy.guards.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.publicShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.public.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.roundtrip.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/ephemeralTasks.scmCommitMessage.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.planAndDelegate.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.resumableResume.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.review.triage.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/fakeClaude.hookForwarder.safe.test.ts
packages/tests/suites/core-e2e/fakeClaude.streamJsonInput.test.ts
packages/tests/suites/core-e2e/featureNegotiation.automations.enablement.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.buildPolicy.enforcement.slow.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.scopeAndFallback.feat.social.friends.slow.e2e.test.ts
packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/memory.hints.searchWindow.roundtrip.slow.e2e.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.emitsSocketUpdates.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.idempotencyKey.test.ts
packages/tests/suites/core-e2e/messages.socket.echoToSender.test.ts
packages/tests/suites/core-e2e/messages.socketAck.didWrite.test.ts
packages/tests/suites/core-e2e/messages.socketAck.schema.test.ts
packages/tests/suites/core-e2e/messages.socketIdempotency.noRebroadcast.test.ts
packages/tests/suites/core-e2e/multiServer.groupTarget.sessionListProjection.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.serverScopedOperationRouting.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.switch.authAndSockets.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.modelOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.probeModels.capabilityInvoke.test.ts
packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.slashCommandsExtraction.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.cli.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.daemon.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.http.crud.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.idempotency.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.socketRpc.test.ts
packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts
packages/tests/suites/core-e2e/permissions.lifecycle.encrypted.test.ts
packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.metadataUpdate.midTurn.slow.e2e.test.ts
packages/tests/suites/core-e2e/providers.baselines.test.ts
packages/tests/suites/core-e2e/providers.harness.homeIsolation.test.ts
packages/tests/suites/core-e2e/providers.kilo.specPresence.test.ts
packages/tests/suites/core-e2e/providers.presets.test.ts
packages/tests/suites/core-e2e/providers.sidechainWait.test.ts
packages/tests/suites/core-e2e/providers.toolSchemas.test.ts
packages/tests/suites/core-e2e/providers.traceSatisfaction.test.ts
packages/tests/suites/core-e2e/reconnect.midstreamStorm.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.agentMessages.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.test.ts
packages/tests/suites/core-e2e/rpc.permissionRoundtrip.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.sapling.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/session.continueWithReplay.dataKeyHydration.slow.e2e.test.ts
packages/tests/suites/core-e2e/sessions.list.catchup.test.ts
packages/tests/suites/core-e2e/sharing.public.e2ee.encryptedDataKeyRequired.feat.sharing.public.feat.sharing.contentKeys.e2e.test.ts
packages/tests/suites/core-e2e/sharing.session.e2ee.encryptedDataKeyRequired.feat.sharing.session.feat.sharing.contentKeys.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/structuredMessages.reviewComments.v1.feat.files.reviewComments.e2e.test.ts
packages/tests/suites/core-e2e/testkit.utils.test.ts
packages/tests/suites/core-e2e/tmux.attach.selectWindow.test.ts
packages/tests/suites/core-e2e/toolTraceJsonl.test.ts
packages/tests/suites/core-e2e/voice.agent.daemon.rpc.feat.voice.agent.slow.e2e.test.ts
packages/tests/suites/core-e2e/voice.leaseMint.accountScoped.feat.voice.test.ts
packages/tests/suites/core-e2e/voice.localTts.kokoro.settingsRoundtrip.feat.voice.test.ts
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
... +1 more
```

### E2E Core Fast — packages/tests (Vitest)

- Total audited files: 193
- UNWIRED: 75
- BRITTLE_HIGH: 73
- SLOW_HIGH: 31
- DUPLICATION: 190

**UNWIRED**

```text
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/suites/core-e2e/providers.baselines.selectKeys.test.ts
packages/tests/suites/core-e2e/providers.baselines.test.ts
packages/tests/suites/core-e2e/providers.harness.homeIsolation.test.ts
packages/tests/suites/core-e2e/providers.kilo.specPresence.test.ts
packages/tests/suites/core-e2e/providers.presets.test.ts
packages/tests/suites/core-e2e/providers.resumeMode.test.ts
packages/tests/suites/core-e2e/providers.sidechainWait.test.ts
packages/tests/suites/core-e2e/providers.toolSchemas.test.ts
packages/tests/suites/core-e2e/providers.traceSatisfaction.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
apps/cli/src/backends/auggie/e2e/providerSpec.json
apps/cli/src/backends/claude/e2e/providerSpec.json
apps/cli/src/backends/codex/e2e/providerSpec.json
apps/cli/src/backends/gemini/e2e/providerSpec.json
apps/cli/src/backends/kilo/e2e/providerSpec.json
apps/cli/src/backends/kimi/e2e/providerSpec.json
apps/cli/src/backends/opencode/e2e/providerSpec.json
apps/cli/src/backends/pi/e2e/providerSpec.json
apps/cli/src/backends/qwen/e2e/providerSpec.json
packages/tests/fixtures/cli-backends/codex_acp_stub/e2e/providerSpec.json
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
```

**BRITTLE_HIGH**

```text
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/suites/core-e2e/auth.mtls.keyless.plaintext.roundtrip.feat.auth.mtls.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/auth.pairing.desktopQrMobileScan.roundtrip.feat.auth.pairing.desktopQrMobileScan.e2e.test.ts
packages/tests/suites/core-e2e/automations.crud.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/changes.catchupHints.test.ts
packages/tests/suites/core-e2e/claude.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/codex.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.accountModeSwitch.keepsExistingSessionsReadable.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.directShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.session.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.messageModeEnforcement.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.plaintextOnlyPolicy.guards.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.publicShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.public.e2e.test.ts
packages/tests/suites/core-e2e/ephemeralTasks.scmCommitMessage.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.planAndDelegate.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.resumableResume.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.review.triage.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.emitsSocketUpdates.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.idempotencyKey.test.ts
packages/tests/suites/core-e2e/messages.socket.echoToSender.test.ts
packages/tests/suites/core-e2e/opencode.acp.probeModels.capabilityInvoke.test.ts
packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts
packages/tests/suites/core-e2e/permissions.lifecycle.encrypted.test.ts
packages/tests/suites/core-e2e/reconnect.midstreamStorm.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.agentMessages.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.sapling.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/sharing.public.e2ee.encryptedDataKeyRequired.feat.sharing.public.feat.sharing.contentKeys.e2e.test.ts
packages/tests/suites/core-e2e/sharing.session.e2ee.encryptedDataKeyRequired.feat.sharing.session.feat.sharing.contentKeys.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/structuredMessages.reviewComments.v1.feat.files.reviewComments.e2e.test.ts
packages/tests/suites/core-e2e/tmux.attach.selectWindow.test.ts
packages/tests/suites/core-e2e/voice.leaseMint.accountScoped.feat.voice.test.ts
packages/tests/suites/core-e2e/voice.localTts.kokoro.settingsRoundtrip.feat.voice.test.ts
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
apps/cli/src/backends/auggie/e2e/providerScenarios.json
apps/cli/src/backends/claude/e2e/providerScenarios.json
apps/cli/src/backends/codex/e2e/providerSpec.json
apps/cli/src/backends/codex/e2e/providerScenarios.json
apps/cli/src/backends/gemini/e2e/providerSpec.json
apps/cli/src/backends/kilo/e2e/providerSpec.json
apps/cli/src/backends/kilo/e2e/providerScenarios.json
apps/cli/src/backends/opencode/e2e/providerSpec.json
apps/cli/src/backends/opencode/e2e/providerScenarios.json
apps/cli/src/backends/pi/e2e/providerSpec.json
apps/cli/src/backends/qwen/e2e/providerSpec.json
packages/tests/fixtures/cli-backends/codex_acp_stub/e2e/providerSpec.json
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiMessages.ts
```

**SLOW_HIGH**

```text
packages/tests/suites/core-e2e/accountSettings.v2.plaintext.keyless.mtls.feat.auth.mtls.feat.encryption.plaintextStorage.feat.e2ee.keylessAccounts.e2e.test.ts
packages/tests/suites/core-e2e/agentState.multiDeviceReconnect.test.ts
packages/tests/suites/core-e2e/changes.catchupHints.test.ts
packages/tests/suites/core-e2e/claude.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/codex.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/ephemeralTasks.scmCommitMessage.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.planAndDelegate.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.resumableResume.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.review.triage.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.emitsSocketUpdates.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.idempotencyKey.test.ts
packages/tests/suites/core-e2e/messages.socket.echoToSender.test.ts
packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts
packages/tests/suites/core-e2e/reconnect.midstreamStorm.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.agentMessages.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.sapling.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/tmux.attach.selectWindow.test.ts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
```

**DUPLICATION**

```text
packages/tests/suites/core-e2e/accountSettings.v2.plaintext.keyless.mtls.feat.auth.mtls.feat.encryption.plaintextStorage.feat.e2ee.keylessAccounts.e2e.test.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/suites/core-e2e/accountSettings.notifications.roundtrip.test.ts
packages/tests/suites/core-e2e/agentState.multiDeviceReconnect.test.ts
packages/tests/suites/core-e2e/auth.mtls.keyless.plaintext.roundtrip.feat.auth.mtls.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/auth.pairing.desktopQrMobileScan.roundtrip.feat.auth.pairing.desktopQrMobileScan.e2e.test.ts
packages/tests/suites/core-e2e/automations.actions.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.crud.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/automations.lifecycle.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/baselines.scoreShape.test.ts
packages/tests/suites/core-e2e/changes.catchupHints.test.ts
packages/tests/suites/core-e2e/claude.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/cliDist.sharedDeps.test.ts
packages/tests/suites/core-e2e/codex.fastStart.createSessionDelay.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.accountModeSwitch.keepsExistingSessionsReadable.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.defaultAccountMode.roundtrip.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.directShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.session.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.messageModeEnforcement.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.pendingQueueV2.materialize.roundtrip.feat.encryption.plaintextStorage.feat.sharing.pendingQueueV2.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.plaintextOnlyPolicy.guards.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.publicShare.roundtrip.feat.encryption.plaintextStorage.feat.sharing.public.e2e.test.ts
packages/tests/suites/core-e2e/encryption.plaintextStorage.roundtrip.feat.encryption.plaintextStorage.e2e.test.ts
packages/tests/suites/core-e2e/ephemeralTasks.scmCommitMessage.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.planAndDelegate.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.resumableResume.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/executionRuns.review.triage.feat.execution.runs.e2e.test.ts
packages/tests/suites/core-e2e/fakeClaude.hookForwarder.safe.test.ts
packages/tests/suites/core-e2e/fakeClaude.streamJsonInput.test.ts
packages/tests/suites/core-e2e/featureNegotiation.automations.enablement.feat.automations.e2e.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.emitsSocketUpdates.test.ts
packages/tests/suites/core-e2e/messages.http.v2messages.idempotencyKey.test.ts
packages/tests/suites/core-e2e/messages.socket.echoToSender.test.ts
packages/tests/suites/core-e2e/messages.socketAck.didWrite.test.ts
packages/tests/suites/core-e2e/messages.socketAck.schema.test.ts
packages/tests/suites/core-e2e/messages.socketIdempotency.noRebroadcast.test.ts
packages/tests/suites/core-e2e/opencode.acp.probeModels.capabilityInvoke.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.idempotency.test.ts
packages/tests/suites/core-e2e/pendingQueue.materialize.socketRpc.test.ts
packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts
packages/tests/suites/core-e2e/permissions.lifecycle.encrypted.test.ts
packages/tests/suites/core-e2e/providers.baselines.test.ts
packages/tests/suites/core-e2e/providers.harness.homeIsolation.test.ts
packages/tests/suites/core-e2e/providers.kilo.specPresence.test.ts
packages/tests/suites/core-e2e/providers.presets.test.ts
packages/tests/suites/core-e2e/providers.sidechainWait.test.ts
packages/tests/suites/core-e2e/providers.toolSchemas.test.ts
packages/tests/suites/core-e2e/providers.traceSatisfaction.test.ts
packages/tests/suites/core-e2e/reconnect.midstreamStorm.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.agentMessages.test.ts
packages/tests/suites/core-e2e/reconnect.multiDevice.test.ts
packages/tests/suites/core-e2e/rpc.permissionRoundtrip.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.git.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/scm.sessionRpc.sapling.feat.scm.writeOperations.e2e.test.ts
packages/tests/suites/core-e2e/serverLight.portRetry.test.ts
packages/tests/suites/core-e2e/sessions.list.catchup.test.ts
packages/tests/suites/core-e2e/sharing.public.e2ee.encryptedDataKeyRequired.feat.sharing.public.feat.sharing.contentKeys.e2e.test.ts
packages/tests/suites/core-e2e/sharing.session.e2ee.encryptedDataKeyRequired.feat.sharing.session.feat.sharing.contentKeys.feat.social.friends.e2e.test.ts
packages/tests/suites/core-e2e/structuredMessages.reviewComments.v1.feat.files.reviewComments.e2e.test.ts
packages/tests/suites/core-e2e/testkit.utils.test.ts
packages/tests/suites/core-e2e/tmux.attach.selectWindow.test.ts
packages/tests/suites/core-e2e/toolTraceJsonl.test.ts
packages/tests/suites/core-e2e/voice.leaseMint.accountScoped.feat.voice.test.ts
packages/tests/suites/core-e2e/voice.localTts.kokoro.settingsRoundtrip.feat.voice.test.ts
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
apps/cli/src/backends/auggie/e2e/providerSpec.json
apps/cli/src/backends/auggie/e2e/providerScenarios.json
apps/cli/src/backends/claude/e2e/providerSpec.json
apps/cli/src/backends/claude/e2e/providerScenarios.json
apps/cli/src/backends/codex/e2e/providerSpec.json
apps/cli/src/backends/codex/e2e/providerScenarios.json
apps/cli/src/backends/gemini/e2e/providerSpec.json
apps/cli/src/backends/gemini/e2e/providerScenarios.json
apps/cli/src/backends/kilo/e2e/providerSpec.json
apps/cli/src/backends/kilo/e2e/providerScenarios.json
apps/cli/src/backends/kimi/e2e/providerSpec.json
apps/cli/src/backends/kimi/e2e/providerScenarios.json
apps/cli/src/backends/opencode/e2e/providerSpec.json
apps/cli/src/backends/opencode/e2e/providerScenarios.json
apps/cli/src/backends/pi/e2e/providerSpec.json
apps/cli/src/backends/pi/e2e/providerScenarios.json
apps/cli/src/backends/qwen/e2e/providerSpec.json
apps/cli/src/backends/qwen/e2e/providerScenarios.json
packages/tests/fixtures/cli-backends/codex_acp_stub/e2e/providerSpec.json
packages/tests/fixtures/cli-backends/codex_acp_stub/e2e/providerScenarios.json
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### E2E Core Slow — packages/tests (Vitest)

- Total audited files: 144
- UNWIRED: 10
- BRITTLE_HIGH: 46
- SLOW_HIGH: 35
- DUPLICATION: 144

**UNWIRED**

```text
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/vitest.core.config.ts
```

**BRITTLE_HIGH**

```text
packages/tests/suites/core-e2e/automations.leaseTakeover.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.argsAndPermissions.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.mcpConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.taskoutput.sidechains.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.acp.inFlightSteer.pendingQueue.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.localControl.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.resume.mcpStripsAcpState.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.failClosed.pending.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.codex.materialize.feat.connectedServices.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.codex.tempHome.seedsConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.firstMessageNotDropped.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts
packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/memory.hints.searchWindow.roundtrip.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.slashCommandsExtraction.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/session.continueWithReplay.dataKeyHydration.slow.e2e.test.ts
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.mjs
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/vitest.core.config.ts
```

**SLOW_HIGH**

```text
packages/tests/suites/core-e2e/claude.switch.argsAndPermissions.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.mcpConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.acp.inFlightSteer.pendingQueue.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.localControl.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.failClosed.pending.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.codex.materialize.feat.connectedServices.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.codex.tempHome.seedsConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.firstMessageNotDropped.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts
packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/memory.hints.searchWindow.roundtrip.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.groupTarget.sessionListProjection.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.serverScopedOperationRouting.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.switch.authAndSockets.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.slashCommandsExtraction.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.cli.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.daemon.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/session.continueWithReplay.dataKeyHydration.slow.e2e.test.ts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
```

**DUPLICATION**

```text
packages/tests/suites/core-e2e/automations.existingSession.pendingBridge.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/automations.leaseTakeover.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/automations.offlineRecovery.feat.automations.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.argsAndPermissions.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.switch.mcpConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/claude.taskoutput.sidechains.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.acp.inFlightSteer.pendingQueue.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.localControl.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.mcp.noRestart.permissionChange.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.resume.mcpStripsAcpState.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.failClosed.pending.slow.e2e.test.ts
packages/tests/suites/core-e2e/codex.switch.remoteToLocal.mirroring.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.codex.materialize.feat.connectedServices.slow.e2e.test.ts
packages/tests/suites/core-e2e/connectedServices.quotas.roundtrip.feat.connectedServices.quotas.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.codex.tempHome.seedsConfig.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.spawn.firstMessageNotDropped.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts
packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.buildPolicy.enforcement.slow.e2e.test.ts
packages/tests/suites/core-e2e/featureNegotiation.scopeAndFallback.feat.social.friends.slow.e2e.test.ts
packages/tests/suites/core-e2e/gemini.modelOverride.metadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/memory.hints.searchWindow.roundtrip.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.groupTarget.sessionListProjection.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.serverScopedOperationRouting.slow.e2e.test.ts
packages/tests/suites/core-e2e/multiServer.switch.authAndSockets.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.configOptionsOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.modelOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.sessionModeOverride.slow.e2e.test.ts
packages/tests/suites/core-e2e/opencode.acp.slashCommandsExtraction.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.cli.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.daemon.materialize.slow.e2e.test.ts
packages/tests/suites/core-e2e/pendingQueue.http.crud.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.messageMetaOverridesMetadata.slow.e2e.test.ts
packages/tests/suites/core-e2e/permissions.metadataUpdate.midTurn.slow.e2e.test.ts
packages/tests/suites/core-e2e/session.continueWithReplay.dataKeyHydration.slow.e2e.test.ts
packages/tests/suites/core-e2e/voice.agent.daemon.rpc.feat.voice.agent.slow.e2e.test.ts
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### Providers — packages/tests (Vitest)

- Total audited files: 255
- UNWIRED: 14
- BRITTLE_HIGH: 101
- SLOW_HIGH: 15
- DUPLICATION: 255

**UNWIRED**

```text
packages/tests/suites/providers/cliDistBuildLock.test.ts
packages/tests/suites/providers/harnessEnv.applyHomeIsolationEnv.test.ts
packages/tests/scripts/run-providers.mjs
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
```

**BRITTLE_HIGH**

```text
packages/tests/suites/providers/capabilityProbeFailure.test.ts
packages/tests/suites/providers/harness.cliLogFatalDetection.test.ts
packages/tests/suites/providers/harness.inFlightSteer.acpStub.e2e.test.ts
packages/tests/suites/providers/harness.inFlightSteer.codexAcp.e2e.test.ts
packages/tests/suites/providers/harness.providerAvailability.test.ts
packages/tests/suites/providers/harness.tokenTelemetry.acpStub.e2e.test.ts
packages/tests/suites/providers/provider.matrix.test.ts
packages/tests/suites/providers/providerScenarioRegistry.references.test.ts
packages/tests/suites/providers/providerSpecs.capabilityGating.test.ts
packages/tests/suites/providers/providerSpecs.permissionsPassthrough.test.ts
packages/tests/suites/providers/providerSpecs.pi.test.ts
packages/tests/suites/providers/providerSpecs.scenarioRegistry.test.ts
packages/tests/suites/providers/scenarioCatalog.abortContinuation.test.ts
packages/tests/suites/providers/scenarioCatalog.acpCapabilitiesAndModelSet.test.ts
packages/tests/suites/providers/scenarioCatalog.auggieReadKnownFilePath.test.ts
packages/tests/suites/providers/scenarioCatalog.claudePermissions.test.ts
packages/tests/suites/providers/scenarioCatalog.kimiPermissionModeNoPrompt.test.ts
packages/tests/suites/providers/scenarioCatalog.kimiUnknownAliases.test.ts
packages/tests/suites/providers/scenarioCatalog.permissionModeMatrix.test.ts
packages/tests/suites/providers/scenarioCatalog.permissionSurfaceOutsideWorkspace.config.test.ts
packages/tests/suites/providers/scenarioSelection.providersFromSpecs.test.ts
packages/tests/suites/providers/scenarios.acp.fs-search.test.ts
packages/tests/suites/providers/scenarios.acp.permissions.test.ts
packages/tests/suites/providers/scenarios.acp.resume.test.ts
packages/tests/suites/providers/scenarios.outsideWorkspacePathPolicy.test.ts
packages/tests/suites/providers/spawnProcess.runLoggedCommand.streamDrain.test.ts
packages/tests/suites/providers/spawnProcess.stop.test.ts
packages/tests/suites/providers/tooltrace.contract.test.ts
packages/tests/baselines/providers/codex/permission_deny_outside_workspace.json
packages/tests/baselines/providers/codex/search_known_token.json
packages/tests/baselines/providers/codex/search_ls_equivalence.json
packages/tests/baselines/providers/kilo/acp_resume_fresh_session_imports_history.json
packages/tests/baselines/providers/kilo/acp_resume_load_session.json
packages/tests/baselines/providers/kilo/delete_file_in_workspace.json
packages/tests/baselines/providers/kilo/edit_result_includes_diff.json
packages/tests/baselines/providers/kilo/edit_write_file_and_cat.json
packages/tests/baselines/providers/kilo/execute_error_exit_2.json
packages/tests/baselines/providers/kilo/execute_trace_ok.json
packages/tests/baselines/providers/kilo/glob_list_files.json
packages/tests/baselines/providers/kilo/glob_tool_list_files.json
packages/tests/baselines/providers/kilo/kilo_task_subagent_reply.json
packages/tests/baselines/providers/kilo/mcp_change_title.json
packages/tests/baselines/providers/kilo/multi_file_edit_in_workspace.json
packages/tests/baselines/providers/kilo/multi_file_edit_in_workspace_includes_diff.json
packages/tests/baselines/providers/kilo/permission_deny_outside_workspace.json
packages/tests/baselines/providers/kilo/permission_surface_outside_workspace.json
packages/tests/baselines/providers/kilo/read_known_file.json
packages/tests/baselines/providers/kilo/read_missing_file_in_workspace.json
packages/tests/baselines/providers/kilo/search_known_token.json
packages/tests/baselines/providers/kilo/search_ls_equivalence.json
packages/tests/baselines/providers/opencode/acp_resume_fresh_session_imports_history.json
packages/tests/baselines/providers/opencode/acp_resume_load_session.json
packages/tests/baselines/providers/opencode/edit_result_includes_diff.json
packages/tests/baselines/providers/opencode/edit_write_file_and_cat.json
packages/tests/baselines/providers/opencode/execute_error_exit_2.json
packages/tests/baselines/providers/opencode/execute_trace_ok.json
packages/tests/baselines/providers/opencode/glob_list_files.json
packages/tests/baselines/providers/opencode/multi_file_edit_in_workspace.json
packages/tests/baselines/providers/opencode/multi_file_edit_in_workspace_includes_diff.json
packages/tests/baselines/providers/opencode/permission_deny_outside_workspace.json
packages/tests/baselines/providers/opencode/permission_deny_read_outside_workspace.json
packages/tests/baselines/providers/opencode/permission_surface_outside_workspace.json
packages/tests/baselines/providers/opencode/read_known_file.json
packages/tests/baselines/providers/opencode/read_missing_file_in_workspace.json
packages/tests/baselines/providers/opencode/search_known_token.json
packages/tests/baselines/providers/opencode/search_ls_equivalence.json
packages/tests/baselines/providers/opencode/task_subagent_reply.json
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.mjs
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
```

**SLOW_HIGH**

```text
packages/tests/suites/providers/harness.inFlightSteer.acpStub.e2e.test.ts
packages/tests/suites/providers/harness.inFlightSteer.codexAcp.e2e.test.ts
packages/tests/suites/providers/harness.tokenTelemetry.acpStub.e2e.test.ts
packages/tests/suites/providers/provider.matrix.test.ts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/vitest.stress.config.ts
```

**DUPLICATION**

```text
packages/tests/suites/providers/baselines.diff.test.ts
packages/tests/suites/providers/baselines.exampleSelection.test.ts
packages/tests/suites/providers/baselines.opencodeDialect.test.ts
packages/tests/suites/providers/baselines.selection.test.ts
packages/tests/suites/providers/baselines.shapeMatch.test.ts
packages/tests/suites/providers/baselines.shapeSubset.test.ts
packages/tests/suites/providers/capabilityProbe.rpcAckTimeoutBudget.test.ts
packages/tests/suites/providers/capabilityProbeFailure.test.ts
packages/tests/suites/providers/capabilityRetry.test.ts
packages/tests/suites/providers/cliAuth.permissions.test.ts
packages/tests/suites/providers/cliDistBuildCommand.test.ts
packages/tests/suites/providers/cliDistBuildLock.test.ts
packages/tests/suites/providers/daemon.controlServerClient.diagnostics.test.ts
packages/tests/suites/providers/daemon.sanitizeEnv.test.ts
packages/tests/suites/providers/daemon.stop.failureContext.test.ts
packages/tests/suites/providers/fakeClaudeFixture.helpers.test.ts
packages/tests/suites/providers/harness.buildProviderDevCommandArgs.test.ts
packages/tests/suites/providers/harness.cliDistAvailabilityWaitMs.test.ts
packages/tests/suites/providers/harness.cliDistPreflightRebuildPolicy.test.ts
packages/tests/suites/providers/harness.cliLogFatalDetection.test.ts
packages/tests/suites/providers/harness.codexPermissionArgs.test.ts
packages/tests/suites/providers/harness.daemonPolicy.test.ts
packages/tests/suites/providers/harness.fatalAgentMessage.test.ts
packages/tests/suites/providers/harness.hostAuthMirror.test.ts
packages/tests/suites/providers/harness.inFlightSteer.acpStub.e2e.test.ts
packages/tests/suites/providers/harness.inFlightSteer.codexAcp.e2e.test.ts
packages/tests/suites/providers/harness.inactivityTimeout.test.ts
packages/tests/suites/providers/harness.modelOverrideArgs.test.ts
packages/tests/suites/providers/harness.pendingDrainPolicy.test.ts
packages/tests/suites/providers/harness.permissionAutoApprove.test.ts
packages/tests/suites/providers/harness.permissionAutoApprovePolicy.test.ts
packages/tests/suites/providers/harness.permissionBlockTimeout.test.ts
packages/tests/suites/providers/harness.providerAvailability.test.ts
packages/tests/suites/providers/harness.sessionActiveWaitMs.test.ts
packages/tests/suites/providers/harness.tokenTelemetry.acpStub.e2e.test.ts
packages/tests/suites/providers/harness.tokenTelemetry.test.ts
packages/tests/suites/providers/harnessEnv.applyHomeIsolationEnv.test.ts
packages/tests/suites/providers/harnessSignals.stepGating.test.ts
packages/tests/suites/providers/http.waitForOkHealth.diagnostics.test.ts
packages/tests/suites/providers/presets.parallel.test.ts
packages/tests/suites/providers/processTree.test.ts
packages/tests/suites/providers/provider.matrix.test.ts
packages/tests/suites/providers/providerAuthSelection.test.ts
packages/tests/suites/providers/providerScenarioRegistry.references.test.ts
packages/tests/suites/providers/providerSpecs.auth.test.ts
packages/tests/suites/providers/providerSpecs.capabilityGating.test.ts
packages/tests/suites/providers/providerSpecs.codexAcpNpxFallback.test.ts
packages/tests/suites/providers/providerSpecs.kimiAuth.test.ts
packages/tests/suites/providers/providerSpecs.permissionModePromptMatrix.test.ts
packages/tests/suites/providers/providerSpecs.permissions.test.ts
packages/tests/suites/providers/providerSpecs.permissionsPassthrough.test.ts
packages/tests/suites/providers/providerSpecs.pi.test.ts
packages/tests/suites/providers/providerSpecs.requiredEnv.test.ts
packages/tests/suites/providers/providerSpecs.scenarioRegistry.authModes.test.ts
packages/tests/suites/providers/providerSpecs.scenarioRegistry.test.ts
packages/tests/suites/providers/providerSpecs.smokeTierNonEmpty.test.ts
packages/tests/suites/providers/providerSpecs.test.ts
packages/tests/suites/providers/runDir.diskSpaceGuard.test.ts
packages/tests/suites/providers/runDir.retention.test.ts
packages/tests/suites/providers/runExtendedDbDocker.script.test.ts
packages/tests/suites/providers/runProviders.script.test.ts
packages/tests/suites/providers/runProvidersParallel.script.test.ts
packages/tests/suites/providers/scenarioCatalog.abortContinuation.test.ts
packages/tests/suites/providers/scenarioCatalog.acpCapabilitiesAndModelSet.test.ts
packages/tests/suites/providers/scenarioCatalog.acpProbeModels.test.ts
packages/tests/suites/providers/scenarioCatalog.auggieReadKnownFilePath.test.ts
packages/tests/suites/providers/scenarioCatalog.auggieResume.test.ts
packages/tests/suites/providers/scenarioCatalog.claudePermissions.test.ts
packages/tests/suites/providers/scenarioCatalog.codexResumeInactivity.test.ts
packages/tests/suites/providers/scenarioCatalog.executeNormalization.test.ts
packages/tests/suites/providers/scenarioCatalog.inFlightSteer.test.ts
packages/tests/suites/providers/scenarioCatalog.kiloPermissionOutsideWorkspaceYolo.test.ts
packages/tests/suites/providers/scenarioCatalog.kiloResumeKey.test.ts
packages/tests/suites/providers/scenarioCatalog.kiloTaskContract.test.ts
packages/tests/suites/providers/scenarioCatalog.kimiPermissionModeNoPrompt.test.ts
packages/tests/suites/providers/scenarioCatalog.kimiReadKnownFileAutoApprove.test.ts
packages/tests/suites/providers/scenarioCatalog.kimiUnknownAliases.test.ts
packages/tests/suites/providers/scenarioCatalog.machineIds.test.ts
packages/tests/suites/providers/scenarioCatalog.opencodeSearchFallback.test.ts
packages/tests/suites/providers/scenarioCatalog.opencodeTaskContract.test.ts
packages/tests/suites/providers/scenarioCatalog.permissionModeMatrix.test.ts
packages/tests/suites/providers/scenarioCatalog.permissionSurfaceOutsideWorkspace.config.test.ts
packages/tests/suites/providers/scenarioCatalog.resumeAutoApprove.test.ts
packages/tests/suites/providers/scenarioSelection.acpProbeCapabilitiesSmoke.test.ts
packages/tests/suites/providers/scenarioSelection.authModes.test.ts
packages/tests/suites/providers/scenarioSelection.providersFromSpecs.test.ts
packages/tests/suites/providers/scenarioSelection.registry.test.ts
packages/tests/suites/providers/scenarios.acp.fs-search.test.ts
packages/tests/suites/providers/scenarios.acp.multiFileVerify.test.ts
packages/tests/suites/providers/scenarios.acp.permissions.test.ts
packages/tests/suites/providers/scenarios.acp.resume.test.ts
packages/tests/suites/providers/scenarios.acp.test.ts
packages/tests/suites/providers/scenarios.outsideWorkspacePathPolicy.test.ts
packages/tests/suites/providers/serverLight.retryPolicy.test.ts
packages/tests/suites/providers/sessions.pagination.test.ts
packages/tests/suites/providers/shape.normalizeBaseline.test.ts
packages/tests/suites/providers/socketClient.rpcRegister.test.ts
packages/tests/suites/providers/spawnProcess.runLoggedCommand.flush.test.ts
packages/tests/suites/providers/spawnProcess.runLoggedCommand.longRunning.test.ts
packages/tests/suites/providers/spawnProcess.runLoggedCommand.streamDrain.test.ts
packages/tests/suites/providers/spawnProcess.stop.test.ts
packages/tests/suites/providers/syntheticAgent.backoff.test.ts
packages/tests/suites/providers/syntheticAgent.rpcClient.test.ts
packages/tests/suites/providers/timing.waitFor.test.ts
packages/tests/suites/providers/tokenLedger.summary.test.ts
packages/tests/suites/providers/tooltrace.contract.test.ts
packages/tests/suites/providers/traceSatisfaction.importFilter.test.ts
packages/tests/suites/providers/uiMessages.post.test.ts
packages/tests/baselines/providers/codex/permission_deny_outside_workspace.json
packages/tests/baselines/providers/codex/search_known_token.json
packages/tests/baselines/providers/codex/search_ls_equivalence.json
packages/tests/baselines/providers/kilo/acp_resume_fresh_session_imports_history.json
packages/tests/baselines/providers/kilo/acp_resume_load_session.json
packages/tests/baselines/providers/kilo/delete_file_in_workspace.json
packages/tests/baselines/providers/kilo/edit_result_includes_diff.json
packages/tests/baselines/providers/kilo/edit_write_file_and_cat.json
packages/tests/baselines/providers/kilo/execute_error_exit_2.json
packages/tests/baselines/providers/kilo/execute_trace_ok.json
packages/tests/baselines/providers/kilo/glob_list_files.json
packages/tests/baselines/providers/kilo/glob_tool_list_files.json
packages/tests/baselines/providers/kilo/kilo_task_subagent_reply.json
packages/tests/baselines/providers/kilo/mcp_change_title.json
packages/tests/baselines/providers/kilo/multi_file_edit_in_workspace.json
packages/tests/baselines/providers/kilo/multi_file_edit_in_workspace_includes_diff.json
packages/tests/baselines/providers/kilo/permission_deny_outside_workspace.json
packages/tests/baselines/providers/kilo/permission_surface_outside_workspace.json
packages/tests/baselines/providers/kilo/read_known_file.json
packages/tests/baselines/providers/kilo/read_missing_file_in_workspace.json
packages/tests/baselines/providers/kilo/search_known_token.json
packages/tests/baselines/providers/kilo/search_ls_equivalence.json
packages/tests/baselines/providers/opencode/acp_resume_fresh_session_imports_history.json
packages/tests/baselines/providers/opencode/acp_resume_load_session.json
packages/tests/baselines/providers/opencode/edit_result_includes_diff.json
packages/tests/baselines/providers/opencode/edit_write_file_and_cat.json
packages/tests/baselines/providers/opencode/execute_error_exit_2.json
packages/tests/baselines/providers/opencode/execute_trace_ok.json
packages/tests/baselines/providers/opencode/glob_list_files.json
packages/tests/baselines/providers/opencode/multi_file_edit_in_workspace.json
packages/tests/baselines/providers/opencode/multi_file_edit_in_workspace_includes_diff.json
packages/tests/baselines/providers/opencode/permission_deny_outside_workspace.json
packages/tests/baselines/providers/opencode/permission_deny_read_outside_workspace.json
packages/tests/baselines/providers/opencode/permission_surface_outside_workspace.json
packages/tests/baselines/providers/opencode/read_known_file.json
packages/tests/baselines/providers/opencode/read_missing_file_in_workspace.json
packages/tests/baselines/providers/opencode/search_known_token.json
packages/tests/baselines/providers/opencode/search_ls_equivalence.json
packages/tests/baselines/providers/opencode/task_subagent_reply.json
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
... +55 more
```

### Stress — packages/tests (Vitest)

- Total audited files: 110
- UNWIRED: 4
- BRITTLE_HIGH: 35
- SLOW_HIGH: 18
- DUPLICATION: 108

**UNWIRED**

```text
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
```

**BRITTLE_HIGH**

```text
packages/tests/suites/stress/reconnect.chaos.test.ts
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.mjs
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
```

**SLOW_HIGH**

```text
packages/tests/suites/stress/reconnect.chaos.test.ts
packages/tests/suites/stress/reconnect.repeat.test.ts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
```

**DUPLICATION**

```text
packages/tests/suites/stress/reconnect.chaos.test.ts
packages/tests/suites/stress/reconnect.repeat.test.ts
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/fixtures/fake-claude-code-cli.js
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### UI E2E — packages/tests (Playwright)

- Total audited files: 121
- UNWIRED: 6
- BRITTLE_HIGH: 39
- SLOW_HIGH: 24
- DUPLICATION: 120

**UNWIRED**

```text
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.providers.config.ts
```

**BRITTLE_HIGH**

```text
packages/tests/suites/ui-e2e/auth.oauth.provisioningChoice.optional.plain.github.spec.ts
packages/tests/suites/ui-e2e/auth.mtls.terminalConnect.daemon.spec.ts
packages/tests/suites/ui-e2e/auth.oauth.keyed.github.restore.lostAccess.spec.ts
packages/tests/suites/ui-e2e/auth.pairing.addPhone.desktopQrMobileScan.spec.ts
packages/tests/suites/ui-e2e/auth.terminalConnect.daemon.spec.ts
packages/tests/suites/ui-e2e/encryptionOptOut.modeSwitch.readBoth.spec.ts
packages/tests/suites/ui-e2e/encryptionOptOut.publicShare.plaintext.spec.ts
packages/tests/suites/ui-e2e/permissionPrompts.composerCard.jumpToTool.spec.ts
packages/tests/suites/ui-e2e/session.panes.urlSync.backForward.spec.ts
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
```

**SLOW_HIGH**

```text
packages/tests/suites/ui-e2e/auth.oauth.provisioningChoice.optional.plain.github.spec.ts
packages/tests/suites/ui-e2e/auth.mtls.autoRedirect.spec.ts
packages/tests/suites/ui-e2e/auth.mtls.terminalConnect.daemon.spec.ts
packages/tests/suites/ui-e2e/auth.oauth.keyed.github.restore.lostAccess.spec.ts
packages/tests/suites/ui-e2e/auth.oauth.keyless.autoRedirect.github.spec.ts
packages/tests/suites/ui-e2e/auth.terminalConnect.daemon.spec.ts
packages/tests/suites/ui-e2e/encryptionOptOut.modeSwitch.readBoth.spec.ts
packages/tests/suites/ui-e2e/encryptionOptOut.publicShare.plaintext.spec.ts
packages/tests/suites/ui-e2e/permissionPrompts.composerCard.jumpToTool.spec.ts
packages/tests/suites/ui-e2e/session.panes.urlSync.backForward.spec.ts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.mjs
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
```

**DUPLICATION**

```text
packages/tests/suites/ui-e2e/auth.oauth.provisioningChoice.optional.plain.github.spec.ts
packages/tests/suites/ui-e2e/auth.mtls.autoRedirect.spec.ts
packages/tests/suites/ui-e2e/auth.mtls.terminalConnect.daemon.spec.ts
packages/tests/suites/ui-e2e/auth.oauth.keyed.github.restore.lostAccess.spec.ts
packages/tests/suites/ui-e2e/auth.oauth.keyless.autoRedirect.github.spec.ts
packages/tests/suites/ui-e2e/auth.pairing.addPhone.desktopQrMobileScan.spec.ts
packages/tests/suites/ui-e2e/auth.terminalConnect.daemon.spec.ts
packages/tests/suites/ui-e2e/encryptionOptOut.modeSwitch.readBoth.spec.ts
packages/tests/suites/ui-e2e/encryptionOptOut.publicShare.plaintext.spec.ts
packages/tests/suites/ui-e2e/permissionPrompts.composerCard.jumpToTool.spec.ts
packages/tests/suites/ui-e2e/root.serverOverride.reachability.noManualRetry.spec.ts
packages/tests/suites/ui-e2e/session.panes.urlSync.backForward.spec.ts
packages/tests/suites/ui-e2e/settings.systemStatus.diagnosis.spec.ts
packages/tests/package.json
packages/tests/playwright.ui.config.mjs
packages/tests/scripts/extended-db-docker.plan.mjs
packages/tests/scripts/processTree.d.mts
packages/tests/scripts/processTree.mjs
packages/tests/scripts/provider-token-ledger-summary.mjs
packages/tests/scripts/run-extended-db-docker.d.mts
packages/tests/scripts/run-extended-db-docker.mjs
packages/tests/scripts/run-providers-parallel.d.mts
packages/tests/scripts/run-providers-parallel.mjs
packages/tests/scripts/run-providers.d.mts
packages/tests/scripts/run-providers.mjs
packages/tests/scripts/run-vitest-with-heartbeat.mjs
packages/tests/src/fixtures/fake-claude-code-cli.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.cjs
packages/tests/src/fixtures/fake-claude-code-cli.helpers.d.cts
packages/tests/src/testkit/artifacts.ts
packages/tests/src/testkit/auth.ts
packages/tests/src/testkit/automations.ts
packages/tests/src/testkit/changes.ts
packages/tests/src/testkit/cliAccessKey.spec.ts
packages/tests/src/testkit/cliAccessKey.ts
packages/tests/src/testkit/cliAttachFile.ts
packages/tests/src/testkit/cliAuth.ts
packages/tests/src/testkit/daemon/controlServerClient.ts
packages/tests/src/testkit/daemon/daemon.statePath.spec.ts
packages/tests/src/testkit/daemon/daemon.ts
packages/tests/src/testkit/env.spec.ts
packages/tests/src/testkit/env.ts
packages/tests/src/testkit/failureArtifacts.ts
packages/tests/src/testkit/fakeClaude.ts
packages/tests/src/testkit/http.ts
packages/tests/src/testkit/manifest.ts
packages/tests/src/testkit/manifestForServer.ts
packages/tests/src/testkit/messageCrypto.ts
packages/tests/src/testkit/network/reserveAvailablePort.ts
packages/tests/src/testkit/numbers.ts
packages/tests/src/testkit/oauth/fakeGithubOAuthServer.ts
packages/tests/src/testkit/paths.ts
packages/tests/src/testkit/pendingQueueV2.ts
packages/tests/src/testkit/process/cliDist.ts
packages/tests/src/testkit/process/commands.ts
packages/tests/src/testkit/process/extendedDbDocker.plan.spec.ts
packages/tests/src/testkit/process/processTree.ts
packages/tests/src/testkit/process/serverLight.plan.spec.ts
packages/tests/src/testkit/process/serverLight.ts
packages/tests/src/testkit/process/serverWorkspaceName.ts
packages/tests/src/testkit/process/spawnProcess.ts
packages/tests/src/testkit/process/uiWeb.baseUrl.spec.ts
packages/tests/src/testkit/process/uiWeb.ts
packages/tests/src/testkit/process/uiWebHtml.spec.ts
packages/tests/src/testkit/process/uiWebHtml.ts
packages/tests/src/testkit/providers/assertions.ts
packages/tests/src/testkit/providers/baselines.ts
packages/tests/src/testkit/providers/harness/capabilityProbeFailure.ts
packages/tests/src/testkit/providers/harness/capabilityRetry.ts
packages/tests/src/testkit/providers/harness/harnessEnv.test.ts
packages/tests/src/testkit/providers/harness/harnessEnv.ts
packages/tests/src/testkit/providers/harness/harnessSignals.ts
packages/tests/src/testkit/providers/harness/index.ts
packages/tests/src/testkit/providers/harness/outsideWorkspacePath.ts
packages/tests/src/testkit/providers/harness/providerAuthOverlay.ts
packages/tests/src/testkit/providers/harness/tokenLedger.ts
packages/tests/src/testkit/providers/permissions/acpPermissionPrompts.ts
packages/tests/src/testkit/providers/presets/presets.d.mts
packages/tests/src/testkit/providers/presets/presets.mjs
packages/tests/src/testkit/providers/presets/presets.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts
packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.ts
packages/tests/src/testkit/providers/satisfaction/payloadContainsSubstring.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts
packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.ts
packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts
packages/tests/src/testkit/providers/scenarios/scenarios.acp.ts
packages/tests/src/testkit/providers/scenarios/scenarios.claude.ts
packages/tests/src/testkit/providers/scenarios/scenarios.codex.ts
packages/tests/src/testkit/providers/scenarios/scenarios.opencode.ts
packages/tests/src/testkit/providers/shape.ts
packages/tests/src/testkit/providers/specs/providerSpecs.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts
packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.ts
packages/tests/src/testkit/providers/types.ts
packages/tests/src/testkit/rpcCrypto.ts
packages/tests/src/testkit/runDir.ts
packages/tests/src/testkit/seed.ts
packages/tests/src/testkit/sessionSwitchRpc.ts
packages/tests/src/testkit/sessions.ts
packages/tests/src/testkit/socialFriends.ts
packages/tests/src/testkit/socketClient.ts
packages/tests/src/testkit/syntheticAgent/rpcClient.ts
packages/tests/src/testkit/syntheticAgent/syntheticAgent.ts
packages/tests/src/testkit/timing.ts
packages/tests/src/testkit/timing/withTimeout.ts
packages/tests/src/testkit/toolTraceJsonl.ts
packages/tests/src/testkit/uiE2e/cliJson.ts
packages/tests/src/testkit/uiE2e/cliTerminalConnect.ts
packages/tests/src/testkit/uiE2e/forwardedHeaderProxy.ts
packages/tests/src/testkit/uiE2e/pageNavigation.ts
packages/tests/src/testkit/uiMessages.ts
packages/tests/src/testkit/updates.ts
packages/tests/src/testkit/waitForRegexInFile.ts
packages/tests/vitest.core.config.ts
packages/tests/vitest.core.fast.config.ts
packages/tests/vitest.core.slow.config.ts
packages/tests/vitest.providers.config.ts
packages/tests/vitest.stress.config.ts
scripts/testing/featureTestGating.ts
```

### Unit — apps/stack (node:test)

- Total audited files: 464
- UNWIRED: 11
- BRITTLE_HIGH: 142
- SLOW_HIGH: 44
- DUPLICATION: 463

**UNWIRED**

```text
apps/stack/scripts/orchestrated_stack_auth_flow.test.mjs
apps/stack/scripts/test_integration.mjs
apps/stack/scripts/utils/auth/login_ux.mjs
apps/stack/scripts/utils/cli/smoke_help.mjs
apps/stack/scripts/utils/dev_auth_key.mjs
apps/stack/scripts/utils/pglite_lock.mjs
apps/stack/scripts/utils/proc/pm_spawn.integration.test.mjs
apps/stack/scripts/utils/stack_context.mjs
apps/stack/scripts/utils/stack_runtime_state.mjs
apps/stack/scripts/utils/stacks.mjs
apps/stack/scripts/utils/validate.mjs
```

**BRITTLE_HIGH**

```text
apps/stack/scripts/auth_help_cmd.test.mjs
apps/stack/scripts/auth_login_force_default.test.mjs
apps/stack/scripts/auth_login_guided_server_no_expo.test.mjs
apps/stack/scripts/auth_login_print_includes_configure_links.test.mjs
apps/stack/scripts/daemon_dist_guard.test.mjs
apps/stack/scripts/doctor_ui_index_missing.test.mjs
apps/stack/scripts/orchestrated_stack_auth_flow_webapp_url.test.mjs
apps/stack/scripts/provision/linux-ubuntu-provision.test.mjs
apps/stack/scripts/provision/macos-lima-vm.test.mjs
apps/stack/scripts/repo_local_wrapper.test.mjs
apps/stack/scripts/review_pr.warm_base_deps.test.mjs
apps/stack/scripts/review_pr.workspace_cache.test.mjs
apps/stack/scripts/root_package_repo_local_scripts.test.mjs
apps/stack/scripts/self_host_runtime.test.mjs
apps/stack/scripts/service_mode_help.test.mjs
apps/stack/scripts/setup_dev_child_env.test.mjs
apps/stack/scripts/setup_local_repo_profile.test.mjs
apps/stack/scripts/setup_pr.mobile_scheme.test.mjs
apps/stack/scripts/setup_pr_orchestrated_auth_flow_util_import.test.mjs
apps/stack/scripts/stack/stack_environment.sanitization.test.mjs
apps/stack/scripts/stack_copy_auth_server_scoped.test.mjs
apps/stack/scripts/stack_create_dev_auth_seed_help_force.test.mjs
apps/stack/scripts/stack_guided_login_does_not_preopen_browser.test.mjs
apps/stack/scripts/stack_pr_help_cmd.test.mjs
apps/stack/scripts/stack_server_flavors_defaults.test.mjs
apps/stack/scripts/start_ui_required_default.test.mjs
apps/stack/scripts/swiftbar_git_monorepo_cmd.test.mjs
apps/stack/scripts/swiftbar_wt_pr_backcompat.test.mjs
apps/stack/scripts/test_cmd.test.mjs
apps/stack/scripts/tui_args_default_cmd.test.mjs
apps/stack/scripts/utils/cli/wizard_promptSelect.test.mjs
apps/stack/scripts/utils/dev/expo_dev_restart_port_reservation.test.mjs
apps/stack/scripts/utils/dev/expo_dev_runtime_metadata.test.mjs
apps/stack/scripts/utils/expo/command_workspace_deps_built.test.mjs
apps/stack/scripts/utils/git/dev_checkout.test.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.test.mjs
apps/stack/scripts/utils/proc/ensureWorkspacePackagesBuilt.test.mjs
apps/stack/scripts/utils/proc/ownership_killProcessGroupOwnedByStack.test.mjs
apps/stack/scripts/utils/proc/ownership_listPidsWithEnvNeedles.test.mjs
apps/stack/scripts/utils/proc/pm_stack_cache_env.test.mjs
apps/stack/scripts/utils/proc/terminate.test.mjs
apps/stack/scripts/utils/review/augment_runner_integration.test.mjs
apps/stack/scripts/utils/review/base_ref.test.mjs
apps/stack/scripts/utils/review/detached_worktree.test.mjs
apps/stack/scripts/utils/review/head_slice.test.mjs
apps/stack/scripts/utils/review/runners/claude.test.mjs
apps/stack/scripts/utils/review/uncommitted_ops.test.mjs
apps/stack/scripts/utils/server/prisma_import.test.mjs
apps/stack/scripts/utils/server/resolve_stack_server_port.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.port_validation.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.remote_validation.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_dirs.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_legacy.test.mjs
apps/stack/scripts/utils/stack/terminal_usage_instructions.test.mjs
apps/stack/scripts/worktrees_monorepo_use_group.test.mjs
apps/stack/tests/dev-box-entrypoint-providers.test.mjs
apps/stack/tests/help-routing.test.mjs
apps/stack/tests/remote-daemon-setup.test.mjs
apps/stack/tests/remote-server-setup.test.mjs
apps/stack/tests/review-codex-model-alias.test.mjs
apps/stack/tests/review-type.test.mjs
apps/stack/tests/selfUpdateFailureOutput.test.mjs
apps/stack/tests/stack-duplicate-normalization.test.mjs
apps/stack/tests/stack-test-wrapper.test.mjs
package.json
docker/dev-box/entrypoint.sh
packages/cli-common/src/service/manager.ts
apps/stack/bin/hstack.mjs
apps/stack/scripts/auth.mjs
apps/stack/scripts/bundleWorkspaceDeps.mjs
apps/stack/scripts/daemon.mjs
apps/stack/scripts/doctor.mjs
apps/stack/scripts/eas.mjs
apps/stack/scripts/init.mjs
apps/stack/scripts/mobile.mjs
apps/stack/scripts/pack.mjs
apps/stack/scripts/providers_cmd.mjs
apps/stack/scripts/repo_local.mjs
apps/stack/scripts/review_pr.mjs
apps/stack/scripts/service.mjs
apps/stack/scripts/setup_pr.mjs
apps/stack/scripts/tailscale.mjs
apps/stack/scripts/tui.mjs
apps/stack/scripts/worktrees.mjs
apps/stack/extras/swiftbar/lib/utils.sh
apps/stack/extras/swiftbar/lib/git.sh
apps/stack/extras/swiftbar/wt-pr.sh
apps/stack/scripts/provision/linux-ubuntu-provision.sh
apps/stack/scripts/provision/macos-lima-vm.sh
apps/stack/scripts/stack/copy_auth_from_stack.mjs
apps/stack/scripts/stack/stack_daemon_command.mjs
apps/stack/scripts/stack/stack_environment.mjs
apps/stack/scripts/stack/stack_resume_command.mjs
apps/stack/scripts/testkit/stack_stop_sweeps_testkit.mjs
apps/stack/scripts/utils/auth/guided_stack_web_login.mjs
apps/stack/scripts/utils/auth/interactive_stack_auth.mjs
apps/stack/scripts/utils/auth/login_ux.mjs
apps/stack/scripts/utils/auth/orchestrated_stack_auth_flow.mjs
apps/stack/scripts/utils/cli/cli_registry.mjs
apps/stack/scripts/utils/cli/smoke_help.mjs
apps/stack/scripts/utils/cli/wizard.mjs
apps/stack/scripts/utils/dev/daemon.mjs
apps/stack/scripts/utils/dev/expo_dev.mjs
apps/stack/scripts/utils/dev/server.mjs
apps/stack/scripts/utils/env/env.mjs
apps/stack/scripts/utils/env/scrub_env.mjs
apps/stack/scripts/utils/expo/command.mjs
apps/stack/scripts/utils/expo/expo.mjs
apps/stack/scripts/utils/fs/atomic_dir_swap.mjs
apps/stack/scripts/utils/git/dev_checkout.mjs
apps/stack/scripts/utils/git/worktrees.mjs
apps/stack/scripts/utils/llm/assist.mjs
apps/stack/scripts/utils/llm/codex_exec.mjs
apps/stack/scripts/utils/menubar/swiftbar.mjs
apps/stack/scripts/utils/mobile/dev_client_install_invocation.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.mjs
apps/stack/scripts/utils/net/ports.mjs
apps/stack/scripts/utils/paths/paths.mjs
apps/stack/scripts/utils/pglite_lock.mjs
apps/stack/scripts/utils/proc/exit_cleanup.mjs
apps/stack/scripts/utils/proc/ownership.mjs
apps/stack/scripts/utils/proc/proc.mjs
apps/stack/scripts/utils/proc/terminate.mjs
apps/stack/scripts/utils/review/head_slice.mjs
apps/stack/scripts/utils/review/runners/claude.mjs
apps/stack/scripts/utils/review/runners/coderabbit.mjs
apps/stack/scripts/utils/review/runners/codex.mjs
apps/stack/scripts/utils/review/tool_home_seed.mjs
apps/stack/scripts/utils/review/uncommitted_ops.mjs
apps/stack/scripts/utils/server/prisma_import.mjs
apps/stack/scripts/utils/server/resolve_stack_server_port.mjs
apps/stack/scripts/utils/server/server.mjs
apps/stack/scripts/utils/server/urls.mjs
apps/stack/scripts/utils/service/service_manager.mjs
apps/stack/scripts/utils/stack/editor_workspace.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.mjs
apps/stack/scripts/utils/stack/startup.mjs
apps/stack/scripts/utils/tailscale/ip.mjs
apps/stack/scripts/utils/tui/stdin_handoff.mjs
apps/stack/scripts/utils/ui/browser.mjs
apps/stack/scripts/utils/ui/clipboard.mjs
apps/stack/scripts/utils/ui/terminal_launcher.mjs
```

**SLOW_HIGH**

```text
apps/stack/scripts/auth_login_guided_server_no_expo.test.mjs
apps/stack/scripts/repo_local_wrapper.test.mjs
apps/stack/scripts/utils/dev/expo_dev_restart_port_reservation.test.mjs
apps/stack/scripts/utils/dev/expo_dev_runtime_metadata.test.mjs
apps/stack/scripts/utils/proc/ownership_killProcessGroupOwnedByStack.test.mjs
docker/dev-box/entrypoint.sh
packages/cli-common/src/service/manager.ts
apps/stack/scripts/ci.mjs
apps/stack/scripts/dev.mjs
apps/stack/scripts/eas.mjs
apps/stack/scripts/ghops.mjs
apps/stack/scripts/init.mjs
apps/stack/scripts/mobile.mjs
apps/stack/scripts/mobile_dev_client.mjs
apps/stack/scripts/providers_cmd.mjs
apps/stack/scripts/review_pr.mjs
apps/stack/scripts/service.mjs
apps/stack/scripts/test_cmd.mjs
apps/stack/scripts/tui.mjs
apps/stack/scripts/worktrees.mjs
apps/stack/scripts/provision/linux-ubuntu-provision.sh
apps/stack/scripts/provision/macos-lima-vm.sh
apps/stack/scripts/stack/run_script_with_stack_env.mjs
apps/stack/scripts/stack/stack_mobile_install_command.mjs
apps/stack/scripts/stack/stack_stop_command.mjs
apps/stack/scripts/testkit/stack_stop_sweeps_testkit.mjs
apps/stack/scripts/utils/auth/interactive_stack_auth.mjs
apps/stack/scripts/utils/auth/orchestrated_stack_auth_flow.mjs
apps/stack/scripts/utils/dev/daemon.mjs
apps/stack/scripts/utils/dev/expo_dev.mjs
apps/stack/scripts/utils/dev/server.mjs
apps/stack/scripts/utils/expo/command.mjs
apps/stack/scripts/utils/git/dev_checkout.mjs
apps/stack/scripts/utils/llm/assist.mjs
apps/stack/scripts/utils/llm/codex_exec.mjs
apps/stack/scripts/utils/proc/ownership.mjs
apps/stack/scripts/utils/review/runners/augment.mjs
apps/stack/scripts/utils/review/runners/claude.mjs
apps/stack/scripts/utils/review/runners/coderabbit.mjs
apps/stack/scripts/utils/review/runners/codex.mjs
apps/stack/scripts/utils/server/infra/happy_server_infra.mjs
apps/stack/scripts/utils/service/service_manager.mjs
apps/stack/scripts/utils/stack/startup.mjs
apps/stack/scripts/utils/stack/stop.mjs
```

**DUPLICATION**

```text
apps/stack/scripts/auth_force_flag.test.mjs
apps/stack/scripts/auth_help_cmd.test.mjs
apps/stack/scripts/auth_login_flow_in_tty.test.mjs
apps/stack/scripts/auth_login_force_default.test.mjs
apps/stack/scripts/auth_login_guided_server_no_expo.test.mjs
apps/stack/scripts/auth_login_method_override.test.mjs
apps/stack/scripts/auth_login_print_includes_configure_links.test.mjs
apps/stack/scripts/auth_login_respects_pinned_stack_port.test.mjs
apps/stack/scripts/auth_login_runtime_state_port.test.mjs
apps/stack/scripts/bundleWorkspaceDeps.test.mjs
apps/stack/scripts/ci.test.mjs
apps/stack/scripts/daemon.status_scope.test.mjs
apps/stack/scripts/daemon_dist_guard.test.mjs
apps/stack/scripts/daemon_server_scoped_state.test.mjs
apps/stack/scripts/daemon_stop_expected_pid.test.mjs
apps/stack/scripts/dev_external_server_flags.test.mjs
apps/stack/scripts/doctor_cmd.test.mjs
apps/stack/scripts/doctor_ui_index_missing.test.mjs
apps/stack/scripts/eas_platform_parsing.test.mjs
apps/stack/scripts/env_cmd.test.mjs
apps/stack/scripts/ghops.test.mjs
apps/stack/scripts/happier_help_passthrough.test.mjs
apps/stack/scripts/happier_server_url_scope.test.mjs
apps/stack/scripts/init_shim_invoked_cwd.test.mjs
apps/stack/scripts/logs_cmd.test.mjs
apps/stack/scripts/mobile_dev_client_help_smoke.test.mjs
apps/stack/scripts/mobile_prebuild_happyDir_defined.test.mjs
apps/stack/scripts/mobile_prebuild_sets_rct_metro_port.test.mjs
apps/stack/scripts/mobile_run_ios_uses_long_port_flag.test.mjs
apps/stack/scripts/orchestrated_stack_auth_flow.test.mjs
apps/stack/scripts/orchestrated_stack_auth_flow_resolve_port.test.mjs
apps/stack/scripts/orchestrated_stack_auth_flow_webapp_url.test.mjs
apps/stack/scripts/pack.test.mjs
apps/stack/scripts/provision/linux-ubuntu-provision.test.mjs
apps/stack/scripts/provision/macos-lima-vm.test.mjs
apps/stack/scripts/repo_cli_activate.test.mjs
apps/stack/scripts/repo_local_wrapper.test.mjs
apps/stack/scripts/review_pr.warm_base_deps.test.mjs
apps/stack/scripts/review_pr.workspace_cache.test.mjs
apps/stack/scripts/root_package_repo_local_scripts.test.mjs
apps/stack/scripts/run_script_with_stack_env.restart_port_reuse.test.mjs
apps/stack/scripts/sandbox_workspace_override.test.mjs
apps/stack/scripts/self_host_runtime.test.mjs
apps/stack/scripts/service_mode_help.test.mjs
apps/stack/scripts/setup_dev_child_env.test.mjs
apps/stack/scripts/setup_local_repo_profile.test.mjs
apps/stack/scripts/setup_non_interactive_flag.test.mjs
apps/stack/scripts/setup_pr.mobile_scheme.test.mjs
apps/stack/scripts/setup_pr_orchestrated_auth_flow_util_import.test.mjs
apps/stack/scripts/stack/stack_environment.sanitization.test.mjs
apps/stack/scripts/stack_audit_fix_light_env.test.mjs
apps/stack/scripts/stack_background_pinned_stack_json.test.mjs
apps/stack/scripts/stack_copy_auth_server_scoped.test.mjs
apps/stack/scripts/stack_create_dev_auth_seed_help_force.test.mjs
apps/stack/scripts/stack_eas_help.test.mjs
apps/stack/scripts/stack_editor_workspace_monorepo_root.test.mjs
apps/stack/scripts/stack_env_cmd.test.mjs
apps/stack/scripts/stack_guided_login_bundle_error_parse.test.mjs
apps/stack/scripts/stack_guided_login_does_not_preopen_browser.test.mjs
apps/stack/scripts/stack_guided_login_inner_invocation.test.mjs
apps/stack/scripts/stack_info_snapshot_running_status.test.mjs
apps/stack/scripts/stack_interactive_monorepo_group.test.mjs
apps/stack/scripts/stack_monorepo_defaults.test.mjs
apps/stack/scripts/stack_monorepo_repo_dev_token.test.mjs
apps/stack/scripts/stack_monorepo_server_light_from_happy_spec.test.mjs
apps/stack/scripts/stack_new_name_normalize_cmd.test.mjs
apps/stack/scripts/stack_pr_help_cmd.test.mjs
apps/stack/scripts/stack_pr_name_normalize_cmd.test.mjs
apps/stack/scripts/stack_server_flavors_defaults.test.mjs
apps/stack/scripts/stack_wt_list.test.mjs
apps/stack/scripts/start_ui_required_default.test.mjs
apps/stack/scripts/swiftbar_git_monorepo_cmd.test.mjs
apps/stack/scripts/swiftbar_utils_cmd.test.mjs
apps/stack/scripts/swiftbar_wt_pr_backcompat.test.mjs
apps/stack/scripts/systemd_unit_info.test.mjs
apps/stack/scripts/tailscale_cmd_output.test.mjs
apps/stack/scripts/test_cmd.test.mjs
apps/stack/scripts/tui_args_default_cmd.test.mjs
apps/stack/scripts/utils/auth/credentials_paths.test.mjs
apps/stack/scripts/utils/auth/daemon_gate.test.mjs
apps/stack/scripts/utils/auth/stable_scope_id.test.mjs
apps/stack/scripts/utils/cli/arg_values.test.mjs
apps/stack/scripts/utils/cli/cwd_scope.test.mjs
apps/stack/scripts/utils/cli/prereqs.test.mjs
apps/stack/scripts/utils/cli/progress.test.mjs
apps/stack/scripts/utils/cli/wizard_promptSelect.test.mjs
apps/stack/scripts/utils/cli/wizard_prompt_worktree_source_lazy.test.mjs
apps/stack/scripts/utils/cli/wizard_worktree_slug.test.mjs
apps/stack/scripts/utils/dev/daemon_watch_resilience.test.mjs
apps/stack/scripts/utils/dev/expo_dev.buildEnv.test.mjs
apps/stack/scripts/utils/dev/expo_dev.test.mjs
apps/stack/scripts/utils/dev/expo_dev_restart_port_reservation.test.mjs
apps/stack/scripts/utils/dev/expo_dev_runtime_metadata.test.mjs
apps/stack/scripts/utils/dev/expo_dev_verbose_logs.test.mjs
apps/stack/scripts/utils/dev/resolveDevServerConnection.test.mjs
apps/stack/scripts/utils/edison/git_roots.test.mjs
apps/stack/scripts/utils/env/dotenv.test.mjs
apps/stack/scripts/utils/env/env_file.test.mjs
apps/stack/scripts/utils/env/scrub_env.test.mjs
apps/stack/scripts/utils/expo/command_workspace_deps_built.test.mjs
apps/stack/scripts/utils/expo/expo_shared_tmpdir.test.mjs
apps/stack/scripts/utils/expo/expo_state_running.test.mjs
apps/stack/scripts/utils/expo/metro_ports.test.mjs
apps/stack/scripts/utils/fs/atomic_dir_swap.test.mjs
apps/stack/scripts/utils/git/default_branch.test.mjs
apps/stack/scripts/utils/git/dev_checkout.test.mjs
apps/stack/scripts/utils/git/fast_forward_to_remote.test.mjs
apps/stack/scripts/utils/git/refs.test.mjs
apps/stack/scripts/utils/git/worktrees_monorepo.test.mjs
apps/stack/scripts/utils/git/worktrees_pathstyle.test.mjs
apps/stack/scripts/utils/llm/codex_exec.test.mjs
apps/stack/scripts/utils/llm/tools.test.mjs
apps/stack/scripts/utils/menubar/swiftbar.test.mjs
apps/stack/scripts/utils/mobile/dev_client_install_invocation.test.mjs
apps/stack/scripts/utils/mobile/identifiers.test.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.test.mjs
apps/stack/scripts/utils/net/url.test.mjs
apps/stack/scripts/utils/paths/canonical_home.test.mjs
apps/stack/scripts/utils/paths/localhost_host.test.mjs
apps/stack/scripts/utils/paths/paths_env_win32.test.mjs
apps/stack/scripts/utils/paths/paths_monorepo.test.mjs
apps/stack/scripts/utils/paths/paths_server_flavors.test.mjs
apps/stack/scripts/utils/proc/ensureWorkspacePackagesBuilt.test.mjs
apps/stack/scripts/utils/proc/happy_monorepo_deps.test.mjs
apps/stack/scripts/utils/proc/ownership_killProcessGroupOwnedByStack.test.mjs
apps/stack/scripts/utils/proc/ownership_listPidsWithEnvNeedles.test.mjs
apps/stack/scripts/utils/proc/package_scripts.test.mjs
apps/stack/scripts/utils/proc/pm_stack_cache_env.test.mjs
apps/stack/scripts/utils/proc/proc.test.mjs
apps/stack/scripts/utils/proc/terminate.test.mjs
apps/stack/scripts/utils/review/augment_runner_integration.test.mjs
apps/stack/scripts/utils/review/base_ref.test.mjs
apps/stack/scripts/utils/review/chunks.test.mjs
apps/stack/scripts/utils/review/detached_worktree.test.mjs
apps/stack/scripts/utils/review/findings.test.mjs
apps/stack/scripts/utils/review/head_slice.test.mjs
apps/stack/scripts/utils/review/prompts.test.mjs
apps/stack/scripts/utils/review/run_reviewers_safe.test.mjs
apps/stack/scripts/utils/review/runners/augment.test.mjs
apps/stack/scripts/utils/review/runners/claude.test.mjs
apps/stack/scripts/utils/review/runners/coderabbit.test.mjs
apps/stack/scripts/utils/review/runners/codex.test.mjs
apps/stack/scripts/utils/review/slice_mode.test.mjs
apps/stack/scripts/utils/review/sliced_runner.test.mjs
apps/stack/scripts/utils/review/slices.test.mjs
apps/stack/scripts/utils/review/targets.test.mjs
apps/stack/scripts/utils/review/tool_home_seed.test.mjs
apps/stack/scripts/utils/review/uncommitted_ops.test.mjs
apps/stack/scripts/utils/server/flavor_scripts.test.mjs
apps/stack/scripts/utils/server/mobile_api_url.test.mjs
apps/stack/scripts/utils/server/prisma_import.test.mjs
apps/stack/scripts/utils/server/resolve_stack_server_port.test.mjs
apps/stack/scripts/utils/server/ui_build_check.test.mjs
apps/stack/scripts/utils/server/ui_env.test.mjs
apps/stack/scripts/utils/server/validate.test.mjs
apps/stack/scripts/utils/service/autostart_darwin.test.mjs
apps/stack/scripts/utils/service/autostart_darwin_keepalive.test.mjs
apps/stack/scripts/utils/service/service_manager.definition.test.mjs
apps/stack/scripts/utils/service/service_manager.plan.test.mjs
apps/stack/scripts/utils/service/service_manager.test.mjs
apps/stack/scripts/utils/service/stack_autostart_resolution.test.mjs
apps/stack/scripts/utils/service/systemd_service_unit.test.mjs
apps/stack/scripts/utils/service/windows_schtasks_wrapper.test.mjs
apps/stack/scripts/utils/setup/child_env.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.port_validation.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.remote_validation.test.mjs
apps/stack/scripts/utils/stack/interactive_stack_config.stack_name_validation.test.mjs
apps/stack/scripts/utils/stack/names.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_dirs.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_generate.test.mjs
apps/stack/scripts/utils/stack/startup_server_light_legacy.test.mjs
apps/stack/scripts/utils/stack/terminal_usage_instructions.test.mjs
apps/stack/scripts/utils/tui/actions.test.mjs
apps/stack/scripts/utils/tui/args.test.mjs
apps/stack/scripts/utils/tui/child_termination_plan.test.mjs
apps/stack/scripts/utils/tui/daemon_auth_notice.test.mjs
apps/stack/scripts/utils/tui/daemon_autostart.test.mjs
apps/stack/scripts/utils/tui/daemon_pane_reconcile.test.mjs
apps/stack/scripts/utils/tui/script_pty_command.test.mjs
apps/stack/scripts/utils/tui/stack_scope_env.test.mjs
apps/stack/scripts/utils/tui/stdin_handoff.test.mjs
apps/stack/scripts/utils/tui/summary_env.test.mjs
apps/stack/scripts/utils/ui/box_line.test.mjs
apps/stack/scripts/utils/ui/browser.test.mjs
apps/stack/scripts/utils/ui/ui_export_env.test.mjs
apps/stack/scripts/utils/worktrees/seed_node_modules.test.mjs
apps/stack/scripts/utils/worktrees/yarn_install_guard.test.mjs
apps/stack/scripts/worktrees_cursor_monorepo_root.test.mjs
apps/stack/scripts/worktrees_list_specs_no_recurse.test.mjs
apps/stack/scripts/worktrees_monorepo_testkit.test.mjs
apps/stack/scripts/worktrees_monorepo_use_group.test.mjs
apps/stack/scripts/worktrees_status_default_target.test.mjs
apps/stack/tests/autoUpdateNotice.test.mjs
apps/stack/tests/dev-box-entrypoint-providers.test.mjs
apps/stack/tests/help-routing.test.mjs
apps/stack/tests/menubar-uninstall-legacy.test.mjs
apps/stack/tests/providers-install.test.mjs
apps/stack/tests/remote-daemon-setup.test.mjs
apps/stack/tests/remote-server-setup.test.mjs
apps/stack/tests/review-codex-model-alias.test.mjs
... +263 more
```

### Integration — apps/stack (node:test)

- Total audited files: 351
- UNWIRED: 8
- BRITTLE_HIGH: 55
- SLOW_HIGH: 16
- DUPLICATION: 347

**UNWIRED**

```text
apps/stack/scripts/pglite_lock.integration.test.mjs
apps/stack/scripts/test_integration.mjs
apps/stack/scripts/utils/auth/guided_stack_web_login.mjs
apps/stack/scripts/utils/auth/login_ux.mjs
apps/stack/scripts/utils/cli/smoke_help.mjs
apps/stack/scripts/utils/dev/expo_dev_runtime_metadata.test.mjs
apps/stack/scripts/utils/dev_auth_key.mjs
apps/stack/scripts/utils/expo/expo_state_running.test.mjs
```

**BRITTLE_HIGH**

```text
apps/stack/scripts/auth_copy_from_pglite_lock_in_use.integration.test.mjs
apps/stack/scripts/auth_copy_from_runCapture.integration.test.mjs
apps/stack/scripts/daemon_invalid_auth_reseed_stack_name.integration.test.mjs
apps/stack/scripts/daemon_start_verification.integration.test.mjs
apps/stack/scripts/exit_cleanup_kills_detached_children_on_crash.integration.test.mjs
apps/stack/scripts/monorepo_port.apply.integration.test.mjs
apps/stack/scripts/monorepo_port.conflicts.integration.test.mjs
apps/stack/scripts/monorepo_port.validation.integration.test.mjs
apps/stack/scripts/release_binary_smoke.integration.test.mjs
apps/stack/scripts/self_host_binary_smoke.integration.test.mjs
apps/stack/scripts/stack_daemon_cmd.integration.test.mjs
apps/stack/scripts/swiftbar_render_monorepo_wt_actions.integration.test.mjs
apps/stack/scripts/worktrees_archive_cmd.integration.test.mjs
apps/stack/package.json
apps/stack/scripts/stack/copy_auth_from_stack.mjs
apps/stack/scripts/stack/help_text.mjs
apps/stack/scripts/stack/port_reservation.mjs
apps/stack/scripts/stack/run_script_with_stack_env.mjs
apps/stack/scripts/stack/stack_daemon_command.mjs
apps/stack/scripts/stack/stack_environment.mjs
apps/stack/scripts/stack/stack_environment.sanitization.test.mjs
apps/stack/scripts/stack/stack_info_snapshot.mjs
apps/stack/scripts/stack/stack_mobile_install_command.mjs
apps/stack/scripts/stack/stack_workspace_command.mjs
apps/stack/scripts/self_host_service_e2e_harness.mjs
apps/stack/scripts/testkit/monorepo_port_testkit.mjs
apps/stack/scripts/testkit/stack_archive_command_testkit.mjs
apps/stack/scripts/testkit/stack_stop_sweeps_testkit.mjs
apps/stack/scripts/utils/auth/guided_pr_auth.mjs
apps/stack/scripts/utils/auth/guided_stack_web_login.mjs
apps/stack/scripts/utils/auth/interactive_stack_auth.mjs
apps/stack/scripts/utils/auth/login_ux.mjs
apps/stack/scripts/utils/auth/orchestrated_stack_auth_flow.mjs
apps/stack/scripts/utils/cli/cli_registry.mjs
apps/stack/scripts/utils/cli/smoke_help.mjs
apps/stack/scripts/utils/cli/wizard.mjs
apps/stack/scripts/utils/dev/daemon.mjs
apps/stack/scripts/utils/dev/expo_dev.mjs
apps/stack/scripts/utils/dev/expo_dev_restart_port_reservation.test.mjs
apps/stack/scripts/utils/dev/expo_dev_runtime_metadata.test.mjs
apps/stack/scripts/utils/dev/server.mjs
apps/stack/scripts/utils/env/env.mjs
apps/stack/scripts/utils/env/scrub_env.mjs
apps/stack/scripts/utils/expo/command.mjs
apps/stack/scripts/utils/expo/expo.mjs
apps/stack/scripts/utils/git/dev_checkout.mjs
apps/stack/scripts/utils/git/git.mjs
apps/stack/scripts/utils/git/worktrees.mjs
apps/stack/scripts/utils/llm/codex_exec.mjs
apps/stack/scripts/utils/menubar/swiftbar.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.mjs
apps/stack/scripts/utils/net/ports.mjs
apps/stack/scripts/utils/net/tcp_forward.mjs
apps/stack/scripts/utils/paths/localhost_host.mjs
apps/stack/scripts/utils/paths/paths.mjs
```

**SLOW_HIGH**

```text
apps/stack/scripts/daemon_start_verification.integration.test.mjs
apps/stack/scripts/exit_cleanup_kills_detached_children_on_crash.integration.test.mjs
apps/stack/scripts/monorepo_port.apply.integration.test.mjs
apps/stack/scripts/monorepo_port.conflicts.integration.test.mjs
apps/stack/scripts/release_binary_smoke.integration.test.mjs
apps/stack/scripts/self_host_binary_smoke.integration.test.mjs
apps/stack/scripts/self_host_launchd.real.integration.test.mjs
apps/stack/scripts/self_host_schtasks.real.integration.test.mjs
apps/stack/scripts/self_host_systemd.real.integration.test.mjs
apps/stack/scripts/stack/run_script_with_stack_env.mjs
apps/stack/scripts/test_integration.mjs
apps/stack/scripts/utils/auth/interactive_stack_auth.mjs
apps/stack/scripts/utils/auth/orchestrated_stack_auth_flow.mjs
apps/stack/scripts/utils/dev/daemon.mjs
apps/stack/scripts/utils/dev/expo_dev.mjs
apps/stack/scripts/utils/dev/server.mjs
```

**DUPLICATION**

```text
apps/stack/scripts/auth_copy_from_pglite_lock_in_use.integration.test.mjs
apps/stack/scripts/auth_copy_from_runCapture.integration.test.mjs
apps/stack/scripts/auth_status_server_validation.integration.test.mjs
apps/stack/scripts/daemon_invalid_auth_reseed_stack_name.integration.test.mjs
apps/stack/scripts/daemon_start_verification.integration.test.mjs
apps/stack/scripts/exit_cleanup_kills_detached_children_on_crash.integration.test.mjs
apps/stack/scripts/mobile_run_ios_passes_port.integration.test.mjs
apps/stack/scripts/monorepo_port.apply.integration.test.mjs
apps/stack/scripts/monorepo_port.conflicts.integration.test.mjs
apps/stack/scripts/monorepo_port.validation.integration.test.mjs
apps/stack/scripts/pglite_lock.integration.test.mjs
apps/stack/scripts/release_binary_smoke.integration.test.mjs
apps/stack/scripts/self_host_binary_smoke.integration.test.mjs
apps/stack/scripts/self_host_daemon.real.integration.test.mjs
apps/stack/scripts/self_host_launchd.real.integration.test.mjs
apps/stack/scripts/self_host_schtasks.real.integration.test.mjs
apps/stack/scripts/self_host_systemd.real.integration.test.mjs
apps/stack/scripts/stack_archive_cmd.integration.test.mjs
apps/stack/scripts/stack_daemon_cmd.integration.test.mjs
apps/stack/scripts/stack_happy_cmd.integration.test.mjs
apps/stack/scripts/stack_resume_cmd.integration.test.mjs
apps/stack/scripts/stack_shorthand_cmd.integration.test.mjs
apps/stack/scripts/stack_stop_sweeps_legacy_infra_without_kind.integration.test.mjs
apps/stack/scripts/stack_stop_sweeps_when_runtime_missing.integration.test.mjs
apps/stack/scripts/stack_stop_sweeps_when_runtime_stale.integration.test.mjs
apps/stack/scripts/stopStackWithEnv_kills_ephemeral_runtime_pids_without_env_markers.integration.test.mjs
apps/stack/scripts/stopStackWithEnv_no_autosweep_when_runtime_missing.integration.test.mjs
apps/stack/scripts/stopStackWithEnv_sweeps_repo_local_stack_by_stackName_when_runtime_missing.integration.test.mjs
apps/stack/scripts/swiftbar_render_monorepo_wt_actions.integration.test.mjs
apps/stack/scripts/tui_stopStackForTuiExit_no_autosweep.integration.test.mjs
apps/stack/scripts/utils/proc/pm_spawn.integration.test.mjs
apps/stack/scripts/worktrees_archive_cmd.integration.test.mjs
apps/stack/package.json
apps/stack/scripts/stack/command_arguments.mjs
apps/stack/scripts/stack/copy_auth_from_stack.mjs
apps/stack/scripts/stack/delegated_script_commands.mjs
apps/stack/scripts/stack/help_text.mjs
apps/stack/scripts/stack/port_reservation.mjs
apps/stack/scripts/stack/repo_checkout_resolution.mjs
apps/stack/scripts/stack/run_script_with_stack_env.mjs
apps/stack/scripts/stack/stack_daemon_command.mjs
apps/stack/scripts/stack/stack_delegated_help.mjs
apps/stack/scripts/stack/stack_environment.mjs
apps/stack/scripts/stack/stack_environment.sanitization.test.mjs
apps/stack/scripts/stack/stack_happier_passthrough_command.mjs
apps/stack/scripts/stack/stack_info_snapshot.mjs
apps/stack/scripts/stack/stack_mobile_install_command.mjs
apps/stack/scripts/stack/stack_resume_command.mjs
apps/stack/scripts/stack/stack_stop_command.mjs
apps/stack/scripts/stack/stack_workspace_command.mjs
apps/stack/scripts/stack/transient_repo_overrides.mjs
apps/stack/scripts/test_integration.mjs
apps/stack/scripts/self_host_service_e2e_harness.mjs
apps/stack/scripts/testkit/auth_testkit.mjs
apps/stack/scripts/testkit/doctor_testkit.mjs
apps/stack/scripts/testkit/monorepo_port_testkit.mjs
apps/stack/scripts/testkit/stack_archive_command_testkit.mjs
apps/stack/scripts/testkit/stack_new_monorepo_testkit.mjs
apps/stack/scripts/testkit/stack_script_command_testkit.mjs
apps/stack/scripts/testkit/stack_stop_sweeps_testkit.mjs
apps/stack/scripts/testkit/worktrees_monorepo_testkit.mjs
apps/stack/scripts/utils/auth/auth_force_flag.mjs
apps/stack/scripts/utils/auth/credentials_paths.mjs
apps/stack/scripts/utils/auth/credentials_paths.test.mjs
apps/stack/scripts/utils/auth/daemon_gate.mjs
apps/stack/scripts/utils/auth/daemon_gate.test.mjs
apps/stack/scripts/utils/auth/decode_jwt_payload_unsafe.mjs
apps/stack/scripts/utils/auth/dev_key.mjs
apps/stack/scripts/utils/auth/files.mjs
apps/stack/scripts/utils/auth/guided_pr_auth.mjs
apps/stack/scripts/utils/auth/guided_stack_web_login.mjs
apps/stack/scripts/utils/auth/handy_master_secret.mjs
apps/stack/scripts/utils/auth/interactive_stack_auth.mjs
apps/stack/scripts/utils/auth/login_ux.mjs
apps/stack/scripts/utils/auth/orchestrated_stack_auth_flow.mjs
apps/stack/scripts/utils/auth/sources.mjs
apps/stack/scripts/utils/auth/stable_scope_id.mjs
apps/stack/scripts/utils/auth/stable_scope_id.test.mjs
apps/stack/scripts/utils/auth/stack_guided_login.mjs
apps/stack/scripts/utils/cli/arg_values.mjs
apps/stack/scripts/utils/cli/arg_values.test.mjs
apps/stack/scripts/utils/cli/args.mjs
apps/stack/scripts/utils/cli/cli.mjs
apps/stack/scripts/utils/cli/cli_registry.mjs
apps/stack/scripts/utils/cli/cwd_scope.mjs
apps/stack/scripts/utils/cli/cwd_scope.test.mjs
apps/stack/scripts/utils/cli/flags.mjs
apps/stack/scripts/utils/cli/log_forwarder.mjs
apps/stack/scripts/utils/cli/normalize.mjs
apps/stack/scripts/utils/cli/prereqs.mjs
apps/stack/scripts/utils/cli/prereqs.test.mjs
apps/stack/scripts/utils/cli/progress.mjs
apps/stack/scripts/utils/cli/progress.test.mjs
apps/stack/scripts/utils/cli/smoke_help.mjs
apps/stack/scripts/utils/cli/verbosity.mjs
apps/stack/scripts/utils/cli/wizard.mjs
apps/stack/scripts/utils/cli/wizard_promptSelect.test.mjs
apps/stack/scripts/utils/cli/wizard_prompt_worktree_source_lazy.test.mjs
apps/stack/scripts/utils/cli/wizard_worktree_slug.test.mjs
apps/stack/scripts/utils/crypto/tokens.mjs
apps/stack/scripts/utils/dev/daemon.mjs
apps/stack/scripts/utils/dev/daemon_watch_resilience.test.mjs
apps/stack/scripts/utils/dev/expo_dev.buildEnv.test.mjs
apps/stack/scripts/utils/dev/expo_dev.mjs
apps/stack/scripts/utils/dev/expo_dev.test.mjs
apps/stack/scripts/utils/dev/expo_dev_restart_port_reservation.test.mjs
apps/stack/scripts/utils/dev/expo_dev_runtime_metadata.test.mjs
apps/stack/scripts/utils/dev/expo_dev_verbose_logs.test.mjs
apps/stack/scripts/utils/dev/resolveDevServerConnection.mjs
apps/stack/scripts/utils/dev/resolveDevServerConnection.test.mjs
apps/stack/scripts/utils/dev/server.mjs
apps/stack/scripts/utils/dev_auth_key.mjs
apps/stack/scripts/utils/edison/git_roots.mjs
apps/stack/scripts/utils/edison/git_roots.test.mjs
apps/stack/scripts/utils/env/config.mjs
apps/stack/scripts/utils/env/dotenv.mjs
apps/stack/scripts/utils/env/dotenv.test.mjs
apps/stack/scripts/utils/env/env.mjs
apps/stack/scripts/utils/env/env_file.mjs
apps/stack/scripts/utils/env/env_file.test.mjs
apps/stack/scripts/utils/env/env_local.mjs
apps/stack/scripts/utils/env/load_env_file.mjs
apps/stack/scripts/utils/env/read.mjs
apps/stack/scripts/utils/env/sandbox.mjs
apps/stack/scripts/utils/env/scrub_env.mjs
apps/stack/scripts/utils/env/scrub_env.test.mjs
apps/stack/scripts/utils/env/values.mjs
apps/stack/scripts/utils/expo/command.mjs
apps/stack/scripts/utils/expo/command_workspace_deps_built.test.mjs
apps/stack/scripts/utils/expo/expo.mjs
apps/stack/scripts/utils/expo/expo_state_running.test.mjs
apps/stack/scripts/utils/expo/metro_ports.mjs
apps/stack/scripts/utils/expo/metro_ports.test.mjs
apps/stack/scripts/utils/fs/atomic_dir_swap.mjs
apps/stack/scripts/utils/fs/atomic_dir_swap.test.mjs
apps/stack/scripts/utils/fs/file_has_content.mjs
apps/stack/scripts/utils/fs/fs.mjs
apps/stack/scripts/utils/fs/json.mjs
apps/stack/scripts/utils/fs/ops.mjs
apps/stack/scripts/utils/fs/package_json.mjs
apps/stack/scripts/utils/fs/tail.mjs
apps/stack/scripts/utils/git/default_branch.mjs
apps/stack/scripts/utils/git/default_branch.test.mjs
apps/stack/scripts/utils/git/dev_checkout.mjs
apps/stack/scripts/utils/git/dev_checkout.test.mjs
apps/stack/scripts/utils/git/fast_forward_to_remote.mjs
apps/stack/scripts/utils/git/fast_forward_to_remote.test.mjs
apps/stack/scripts/utils/git/git.mjs
apps/stack/scripts/utils/git/parse_name_status_z.mjs
apps/stack/scripts/utils/git/refs.mjs
apps/stack/scripts/utils/git/refs.test.mjs
apps/stack/scripts/utils/git/worktrees.mjs
apps/stack/scripts/utils/git/worktrees_monorepo.test.mjs
apps/stack/scripts/utils/git/worktrees_pathstyle.test.mjs
apps/stack/scripts/utils/llm/assist.mjs
apps/stack/scripts/utils/llm/codex_exec.mjs
apps/stack/scripts/utils/llm/codex_exec.test.mjs
apps/stack/scripts/utils/llm/hstack_runner.mjs
apps/stack/scripts/utils/llm/tools.mjs
apps/stack/scripts/utils/llm/tools.test.mjs
apps/stack/scripts/utils/menubar/swiftbar.mjs
apps/stack/scripts/utils/menubar/swiftbar.test.mjs
apps/stack/scripts/utils/mobile/config.mjs
apps/stack/scripts/utils/mobile/dev_client_install_invocation.mjs
apps/stack/scripts/utils/mobile/dev_client_links.mjs
apps/stack/scripts/utils/mobile/identifiers.mjs
apps/stack/scripts/utils/mobile/identifiers.test.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.mjs
apps/stack/scripts/utils/mobile/ios_xcodeproj_patch.test.mjs
apps/stack/scripts/utils/net/bind_mode.mjs
apps/stack/scripts/utils/net/dns.mjs
apps/stack/scripts/utils/net/lan_ip.mjs
apps/stack/scripts/utils/net/ports.mjs
apps/stack/scripts/utils/net/tcp_forward.mjs
apps/stack/scripts/utils/net/url.mjs
apps/stack/scripts/utils/net/url.test.mjs
apps/stack/scripts/utils/paths/canonical_home.mjs
apps/stack/scripts/utils/paths/localhost_host.mjs
apps/stack/scripts/utils/paths/paths.mjs
apps/stack/scripts/utils/paths/paths_env_win32.test.mjs
apps/stack/scripts/utils/paths/paths_monorepo.test.mjs
apps/stack/scripts/utils/paths/paths_server_flavors.test.mjs
apps/stack/scripts/utils/paths/runtime.mjs
apps/stack/scripts/utils/pglite_lock.mjs
apps/stack/scripts/utils/proc/commands.mjs
apps/stack/scripts/utils/proc/ensureWorkspacePackagesBuilt.test.mjs
apps/stack/scripts/utils/proc/exit_cleanup.mjs
apps/stack/scripts/utils/proc/happy_monorepo_deps.mjs
apps/stack/scripts/utils/proc/happy_monorepo_deps.test.mjs
apps/stack/scripts/utils/proc/ownership.mjs
apps/stack/scripts/utils/proc/ownership_killProcessGroupOwnedByStack.test.mjs
apps/stack/scripts/utils/proc/ownership_listPidsWithEnvNeedles.test.mjs
apps/stack/scripts/utils/proc/package_scripts.mjs
apps/stack/scripts/utils/proc/package_scripts.test.mjs
apps/stack/scripts/utils/proc/parallel.mjs
apps/stack/scripts/utils/proc/pids.mjs
apps/stack/scripts/utils/proc/pm.mjs
apps/stack/scripts/utils/proc/pm_stack_cache_env.test.mjs
apps/stack/scripts/utils/proc/proc.mjs
apps/stack/scripts/utils/proc/proc.test.mjs
... +147 more
```

### Unit/Integration — packages/relay-server (node:test)

- Total audited files: 8
- UNWIRED: 7
- BRITTLE_HIGH: 0
- SLOW_HIGH: 0
- DUPLICATION: 8

**UNWIRED**

```text
packages/relay-server/scripts/bundleWorkspaceDeps.test.mjs
packages/relay-server/src/checksums.test.mjs
packages/relay-server/src/minisign.verify.test.mjs
packages/relay-server/src/releaseAssets.test.mjs
packages/relay-server/src/runnerConfig.test.mjs
packages/relay-server/src/target.test.mjs
packages/relay-server/package.json
```

**DUPLICATION**

```text
packages/relay-server/scripts/bundleWorkspaceDeps.test.mjs
packages/relay-server/src/checksums.test.mjs
packages/relay-server/src/minisign.verify.test.mjs
packages/relay-server/src/releaseAssets.test.mjs
packages/relay-server/src/runnerConfig.test.mjs
packages/relay-server/src/target.test.mjs
packages/relay-server/package.json
packages/relay-server/scripts/bundleWorkspaceDeps.mjs
```

### Unit — packages/cli-common (node:test)

- Total audited files: 11
- UNWIRED: 9
- BRITTLE_HIGH: 1
- SLOW_HIGH: 0
- DUPLICATION: 11

**UNWIRED**

```text
packages/cli-common/tests/exports.test.mjs
packages/cli-common/tests/links.test.mjs
packages/cli-common/tests/providers.test.mjs
packages/cli-common/tests/service.test.mjs
packages/cli-common/tests/tailscale.serveStatus.test.mjs
packages/cli-common/tests/update.test.mjs
packages/cli-common/tests/vendorBundledPackageRuntimeDependencies.test.mjs
packages/cli-common/tests/workspaces.test.mjs
packages/cli-common/package.json
```

**BRITTLE_HIGH**

```text
packages/cli-common/tests/service.test.mjs
```

**DUPLICATION**

```text
packages/cli-common/tests/exports.test.mjs
packages/cli-common/tests/links.test.mjs
packages/cli-common/tests/providers.test.mjs
packages/cli-common/tests/service.test.mjs
packages/cli-common/tests/tailscale.serveStatus.test.mjs
packages/cli-common/tests/update.test.mjs
packages/cli-common/tests/vendorBundledPackageRuntimeDependencies.test.mjs
packages/cli-common/tests/workspaces.test.mjs
packages/cli-common/package.json
packages/cli-common/tsconfig.json
scripts/postinstall/shouldRunPostinstall.cjs
```

### Unit — packages/release-runtime (node:test)

- Total audited files: 8
- UNWIRED: 6
- BRITTLE_HIGH: 0
- SLOW_HIGH: 0
- DUPLICATION: 8

**UNWIRED**

```text
packages/release-runtime/tests/assets.test.mjs
packages/release-runtime/tests/extractPlan.test.mjs
packages/release-runtime/tests/github.test.mjs
packages/release-runtime/tests/minisign.test.mjs
packages/release-runtime/tests/verifiedDownload.test.mjs
packages/release-runtime/package.json
```

**DUPLICATION**

```text
packages/release-runtime/tests/assets.test.mjs
packages/release-runtime/tests/extractPlan.test.mjs
packages/release-runtime/tests/github.test.mjs
packages/release-runtime/tests/minisign.test.mjs
packages/release-runtime/tests/verifiedDownload.test.mjs
packages/release-runtime/package.json
packages/release-runtime/tsconfig.json
scripts/postinstall/shouldRunPostinstall.cjs
```

### Release Contracts — scripts/release (node:test)

- Total audited files: 292
- UNWIRED: 3
- BRITTLE_HIGH: 131
- SLOW_HIGH: 45
- DUPLICATION: 289

**UNWIRED**

```text
dagger/src/index.ts
scripts/pipeline/run.mjs
scripts/release/.DS_Store
```

**BRITTLE_HIGH**

```text
scripts/release/bootstrap_minisign_script.contract.test.mjs
scripts/release/build_tauri_artifact_names.contract.test.mjs
scripts/release/build_tauri_release_tags.workflow.contract.test.mjs
scripts/release/build_tauri_workflow.production_signing_gate.test.mjs
scripts/release/build_ui_mobile_local_passes_apple_api_private_key.workflow.contract.test.mjs
scripts/release/dagger_expo_android_local_build.contract.test.mjs
scripts/release/deploy_workflow.inputs_contract.test.mjs
scripts/release/docker_publish.workflow.contract.test.mjs
scripts/release/installers_cli_actions.test.mjs
scripts/release/installers_daemon_autostart.test.mjs
scripts/release/installers_default_channel_preview.test.mjs
scripts/release/installers_minisign_bootstrap_arch.test.mjs
scripts/release/installers_path_update_guidance.test.mjs
scripts/release/installers_published_sync.test.mjs
scripts/release/installers_security.test.mjs
scripts/release/installers_self_host_actions.test.mjs
scripts/release/installers_self_host_tar_noise_and_guidance.test.mjs
scripts/release/npm_e2e_smoke.contract.test.mjs
scripts/release/pipeline_checks_release_assets_e2e.contract.test.mjs
scripts/release/pipeline_deploy_cli.contract.test.mjs
scripts/release/pipeline_docker_publish.contract.test.mjs
scripts/release/pipeline_docker_publish_cli.contract.test.mjs
scripts/release/pipeline_docker_publish_recovers_from_docker_down_on_macos.contract.test.mjs
scripts/release/pipeline_expo_download_apk_dry_run_missing_json.contract.test.mjs
scripts/release/pipeline_expo_native_build_cli.contract.test.mjs
scripts/release/pipeline_expo_native_build_cli_local_mode.contract.test.mjs
scripts/release/pipeline_expo_native_build_local.contract.test.mjs
scripts/release/pipeline_expo_submit_interactive_auth.contract.test.mjs
scripts/release/pipeline_expo_submit_ios_bundle_mismatch.contract.test.mjs
scripts/release/pipeline_expo_submit_missing_path.contract.test.mjs
scripts/release/pipeline_expo_submit_preview_allow_failure.contract.test.mjs
scripts/release/pipeline_github_commit_and_push.contract.test.mjs
scripts/release/pipeline_help.contract.test.mjs
scripts/release/pipeline_npm_publish_cli.contract.test.mjs
scripts/release/pipeline_npm_publish_tarball.contract.test.mjs
scripts/release/pipeline_promote_branch_cli.contract.test.mjs
scripts/release/pipeline_promote_deploy_branch_cli.contract.test.mjs
scripts/release/pipeline_release_bump_versions_dev_cli.contract.test.mjs
scripts/release/pipeline_release_bump_versions_dev_script.contract.test.mjs
scripts/release/pipeline_release_cli.contract.test.mjs
scripts/release/pipeline_release_cli_preview_publishers.contract.test.mjs
scripts/release/pipeline_release_cli_with_npm.contract.test.mjs
scripts/release/pipeline_release_preview_publishes_binary_releases.contract.test.mjs
scripts/release/pipeline_release_wrapped_release_scripts_cli.contract.test.mjs
scripts/release/pipeline_run_release_wrapped_passthrough.contract.test.mjs
scripts/release/pipeline_run_smoke_cli.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_cli.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_local_build_mode.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_publish_apk_auto.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_skip_apk_release.contract.test.mjs
scripts/release/promote_ui_mobile_tags.workflow.contract.test.mjs
scripts/release/publish_cli_binaries_version_tags.contract.test.mjs
scripts/release/publish_github_release.workflow.contract.test.mjs
scripts/release/publish_hstack_binaries_version_tags.contract.test.mjs
scripts/release/publish_server_runtime_version_tags.contract.test.mjs
scripts/release/publish_ui_web.workflow.contract.test.mjs
scripts/release/publish_ui_web_version_tags.contract.test.mjs
scripts/release/release-assets-e2e/run_help.test.mjs
scripts/release/release_dev_to_main_workflow.inputs_contract.test.mjs
scripts/release/tests_workflow.binary_smoke_timeout.contract.test.mjs
scripts/release/ui_web_bundle.test.mjs
scripts/release/workflow_secret_hardening.contract.test.mjs
.github/actions/bootstrap-minisign/bootstrap-minisign.sh
.github/workflows/build-tauri.yml
.github/workflows/build-ui-mobile-local.yml
.github/workflows/publish-server-runtime.yml
.github/workflows/release.yml
.github/workflows/promote-server.yml
.github/workflows/promote-ui.yml
apps/cli/package.json
apps/stack/scripts/remote_cmd.mjs
apps/website/public/happier-release.pub
apps/website/public/install
apps/website/public/install-preview
apps/website/public/install-preview.ps1
apps/website/public/install-preview.sh
apps/website/public/install.ps1
apps/website/public/install.sh
apps/website/public/self-host
apps/website/public/self-host-preview
apps/website/public/self-host-preview.ps1
apps/website/public/self-host-preview.sh
apps/website/public/self-host.ps1
apps/website/public/self-host.sh
scripts/pipeline/run.mjs
scripts/pipeline/npm/release-packages.mjs
scripts/pipeline/npm/publish-tarball.mjs
scripts/pipeline/deploy/trigger-webhooks.mjs
scripts/pipeline/expo/native-build.mjs
scripts/pipeline/docker/assert-docker-can-run-linux-amd64.mjs
scripts/pipeline/expo/download-android-apk.mjs
scripts/pipeline/github/audit-release-assets.mjs
scripts/pipeline/github/commit-and-push.mjs
scripts/pipeline/github/promote-branch.mjs
scripts/pipeline/release/bump-version.mjs
scripts/pipeline/release/bump-versions-dev.mjs
scripts/pipeline/release/build-cli-binaries.mjs
scripts/pipeline/release/build-hstack-binaries.mjs
scripts/pipeline/release/resolve-bump-plan.mjs
scripts/pipeline/release/build-ui-web-bundle.mjs
scripts/pipeline/release/compute-deploy-plan.mjs
scripts/pipeline/release/lib/binary-release.mjs
scripts/pipeline/release/lib/ui-web-bundle.mjs
scripts/pipeline/release/publish-cli-binaries.mjs
scripts/pipeline/release/publish-hstack-binaries.mjs
scripts/pipeline/release/publish-manifests.mjs
scripts/pipeline/release/publish-ui-web.mjs
scripts/pipeline/release/verify-artifacts.mjs
scripts/pipeline/testing/create-auth-credentials.mjs
scripts/pipeline/tauri/build-updater-artifacts.mjs
scripts/pipeline/tauri/collect-updater-artifacts.mjs
scripts/pipeline/tauri/prepare-publish-assets.mjs
apps/ui/tools/tauri/make-latest-json.mjs
scripts/release/.DS_Store
scripts/release/installers/happier-release.pub
scripts/release/installers/install.ps1
scripts/release/installers/install.sh
scripts/release/installers/self-host.ps1
scripts/release/installers/self-host.sh
scripts/release/release-assets-e2e/Dockerfile.remote-host-systemd
scripts/release/release-assets-e2e/bin/cli-smoke.sh
scripts/release/release-assets-e2e/bin/cli2-smoke.sh
scripts/release/release-assets-e2e/bin/remote-daemon-authenticated-cli-smoke.sh
scripts/release/release-assets-e2e/bin/remote-daemon-smoke.sh
scripts/release/release-assets-e2e/bin/remote-host-entrypoint.sh
scripts/release/release-assets-e2e/bin/remote-host-systemd-entrypoint.sh
scripts/release/release-assets-e2e/bin/terminal-auth-approve.cjs
scripts/release/release-assets-e2e/compose.dockerhub.yml
scripts/release/release-assets-e2e/compose.remote.yml
scripts/release/release-assets-e2e/compose.yml
scripts/release/installers_verbose_mode.contract.test.mjs
```

**SLOW_HIGH**

```text
.github/workflows/build-tauri.yml
.github/workflows/build-ui-mobile-local.yml
.github/workflows/publish-docker.yml
.github/workflows/release.yml
.github/workflows/promote-server.yml
.github/workflows/promote-ui.yml
apps/stack/scripts/remote_cmd.mjs
apps/website/public/install
apps/website/public/install-preview
apps/website/public/install-preview.ps1
apps/website/public/install-preview.sh
apps/website/public/install-server
apps/website/public/install-server.sh
apps/website/public/install.ps1
apps/website/public/install.sh
apps/website/public/self-host
apps/website/public/self-host-preview
apps/website/public/self-host-preview.ps1
apps/website/public/self-host-preview.sh
apps/website/public/self-host.ps1
apps/website/public/self-host.sh
dagger/src/index.ts
scripts/pipeline/npm/release-packages.mjs
scripts/pipeline/npm/publish-tarball.mjs
scripts/pipeline/deploy/trigger-webhooks.mjs
scripts/pipeline/expo/native-build.mjs
scripts/pipeline/release/build-cli-binaries.mjs
scripts/pipeline/release/build-hstack-binaries.mjs
scripts/pipeline/release/build-server-binaries.mjs
scripts/pipeline/release/build-ui-web-bundle.mjs
scripts/pipeline/release/publish-cli-binaries.mjs
scripts/pipeline/release/publish-hstack-binaries.mjs
scripts/pipeline/release/publish-ui-web.mjs
scripts/pipeline/release/verify-artifacts.mjs
scripts/pipeline/tauri/build-updater-artifacts.mjs
scripts/release/installers/self-host.sh
scripts/release/release-assets-e2e/Dockerfile.remote-host-systemd
scripts/release/release-assets-e2e/bin/cli-smoke.sh
scripts/release/release-assets-e2e/bin/cli2-smoke.sh
scripts/release/release-assets-e2e/bin/remote-daemon-authenticated-cli-smoke.sh
scripts/release/release-assets-e2e/bin/remote-daemon-smoke.sh
scripts/release/release-assets-e2e/bin/remote-host-systemd-entrypoint.sh
scripts/release/release-assets-e2e/compose.dockerhub.yml
scripts/release/release-assets-e2e/compose.remote.yml
scripts/release/release-assets-e2e/compose.yml
```

**DUPLICATION**

```text
scripts/release/binary_release_package_entries.test.mjs
scripts/release/binary_release_pm_resolution.test.mjs
scripts/release/binary_release_targets.test.mjs
scripts/release/bootstrap_minisign_script.contract.test.mjs
scripts/release/build_tauri_artifact_names.contract.test.mjs
scripts/release/build_tauri_release_tags.workflow.contract.test.mjs
scripts/release/build_tauri_workflow.production_signing_gate.test.mjs
scripts/release/build_ui_mobile_local_passes_apple_api_private_key.workflow.contract.test.mjs
scripts/release/build_ui_mobile_local_uses_ui_mobile_release.workflow.contract.test.mjs
scripts/release/bump-version.server_runner.test.mjs
scripts/release/checks_profile_plan.contract.test.mjs
scripts/release/cli_build_uses_npx_pkgroll.contract.test.mjs
scripts/release/componentRegistry.test.mjs
scripts/release/compute-changed-components.test.mjs
scripts/release/dagger_daggerignore.contract.test.mjs
scripts/release/dagger_expo_android_local_build.contract.test.mjs
scripts/release/deploy_trigger_webhooks_script.contract.test.mjs
scripts/release/deploy_workflow.inputs_contract.test.mjs
scripts/release/deploy_workflow_push_caller.contract.test.mjs
scripts/release/deploy_workflow_uses_trigger_webhooks_script.contract.test.mjs
scripts/release/docker_publish.workflow.contract.test.mjs
scripts/release/eas_local_build_env.contract.test.mjs
scripts/release/eas_submit_android_tracks_configured.contract.test.mjs
scripts/release/eas_submit_preview_profile_configured.contract.test.mjs
scripts/release/ensure_asc_api_key_file.test.mjs
scripts/release/feature_policy_embedding.contract.test.mjs
scripts/release/gh_release_edit_args.contract.test.mjs
scripts/release/installers_asset_lookup_robustness.test.mjs
scripts/release/installers_cli_actions.test.mjs
scripts/release/installers_cli_etxtbsy_atomic_swap.test.mjs
scripts/release/installers_daemon_autostart.test.mjs
scripts/release/installers_default_channel_preview.test.mjs
scripts/release/installers_minisign_bootstrap_arch.test.mjs
scripts/release/installers_no_github_token.test.mjs
scripts/release/installers_path_update_guidance.test.mjs
scripts/release/installers_published_sync.test.mjs
scripts/release/installers_security.test.mjs
scripts/release/installers_self_host_actions.test.mjs
scripts/release/installers_self_host_channel_flag.test.mjs
scripts/release/installers_self_host_runtime_smoke.test.mjs
scripts/release/installers_self_host_tar_noise_and_guidance.test.mjs
scripts/release/installers_sync.test.mjs
scripts/release/installers_windows_default_channel_preview.test.mjs
scripts/release/manifests.test.mjs
scripts/release/minisign_key_resolution.test.mjs
scripts/release/npm_e2e_smoke.contract.test.mjs
scripts/release/npm_release_run_tests_auto_defaults.contract.test.mjs
scripts/release/pipeline_checks_release_assets_e2e.contract.test.mjs
scripts/release/pipeline_deploy_cli.contract.test.mjs
scripts/release/pipeline_docker_amd64_emulation_hint.contract.test.mjs
scripts/release/pipeline_docker_publish.contract.test.mjs
scripts/release/pipeline_docker_publish_buildx_builder.contract.test.mjs
scripts/release/pipeline_docker_publish_cli.contract.test.mjs
scripts/release/pipeline_docker_publish_ghcr_uses_gh_cli.contract.test.mjs
scripts/release/pipeline_docker_publish_recovers_from_docker_down_on_macos.contract.test.mjs
scripts/release/pipeline_docker_publish_resolves_sha.contract.test.mjs
scripts/release/pipeline_docker_publish_retries_transient_failures.contract.test.mjs
scripts/release/pipeline_env_parse_dotenv_multiline.contract.test.mjs
scripts/release/pipeline_expo_dagger_staging_excludes.contract.test.mjs
scripts/release/pipeline_expo_dagger_staging_hardlink.contract.test.mjs
scripts/release/pipeline_expo_download_apk_cli.contract.test.mjs
scripts/release/pipeline_expo_download_apk_dry_run_missing_json.contract.test.mjs
scripts/release/pipeline_expo_native_build_cli.contract.test.mjs
scripts/release/pipeline_expo_native_build_cli_local_mode.contract.test.mjs
scripts/release/pipeline_expo_native_build_dagger_rewrites_artifact_path.contract.test.mjs
scripts/release/pipeline_expo_native_build_dagger_runtime.contract.test.mjs
scripts/release/pipeline_expo_native_build_ios_local_requires_fastlane.contract.test.mjs
scripts/release/pipeline_expo_native_build_ios_local_sets_utf8_locale.contract.test.mjs
scripts/release/pipeline_expo_native_build_local.contract.test.mjs
scripts/release/pipeline_expo_ota_cli.contract.test.mjs
scripts/release/pipeline_expo_publish_apk_release_cli.contract.test.mjs
scripts/release/pipeline_expo_submit_cli.contract.test.mjs
scripts/release/pipeline_expo_submit_interactive_auth.contract.test.mjs
scripts/release/pipeline_expo_submit_ios_asc_key.contract.test.mjs
scripts/release/pipeline_expo_submit_ios_bundle_mismatch.contract.test.mjs
scripts/release/pipeline_expo_submit_missing_path.contract.test.mjs
scripts/release/pipeline_expo_submit_path.contract.test.mjs
scripts/release/pipeline_expo_submit_path_cli.contract.test.mjs
scripts/release/pipeline_expo_submit_preview_allow_failure.contract.test.mjs
scripts/release/pipeline_expo_submit_profile_cli.contract.test.mjs
scripts/release/pipeline_git_clean_worktree.test.mjs
scripts/release/pipeline_github_audit_release_assets.contract.test.mjs
scripts/release/pipeline_github_commit_and_push.contract.test.mjs
scripts/release/pipeline_github_publish_release_cli.contract.test.mjs
scripts/release/pipeline_github_publish_release_local.contract.test.mjs
scripts/release/pipeline_help.contract.test.mjs
scripts/release/pipeline_npm_publish_cli.contract.test.mjs
scripts/release/pipeline_npm_publish_provenance_env.contract.test.mjs
scripts/release/pipeline_npm_publish_provenance_override.contract.test.mjs
scripts/release/pipeline_npm_publish_tarball.contract.test.mjs
scripts/release/pipeline_npm_release_cli.contract.test.mjs
scripts/release/pipeline_npm_release_pack_only_cli.contract.test.mjs
scripts/release/pipeline_npm_set_preview_versions_script.contract.test.mjs
scripts/release/pipeline_npm_set_preview_versions_write_false.contract.test.mjs
scripts/release/pipeline_promote_branch_cli.contract.test.mjs
scripts/release/pipeline_promote_branch_script.test.mjs
scripts/release/pipeline_promote_deploy_branch_cli.contract.test.mjs
scripts/release/pipeline_publish_binary_releases_cli.contract.test.mjs
scripts/release/pipeline_publish_server_runtime_cli.contract.test.mjs
scripts/release/pipeline_publish_ui_web_cli.contract.test.mjs
scripts/release/pipeline_release_bump_plan_cli.contract.test.mjs
scripts/release/pipeline_release_bump_plan_script.contract.test.mjs
scripts/release/pipeline_release_bump_versions_dev_cli.contract.test.mjs
scripts/release/pipeline_release_bump_versions_dev_script.contract.test.mjs
scripts/release/pipeline_release_cli.contract.test.mjs
scripts/release/pipeline_release_cli_preview_publishers.contract.test.mjs
scripts/release/pipeline_release_cli_with_npm.contract.test.mjs
scripts/release/pipeline_release_deploy_plan_script.contract.test.mjs
scripts/release/pipeline_release_npm_packages.contract.test.mjs
scripts/release/pipeline_release_npm_packages_pack_only.contract.test.mjs
scripts/release/pipeline_release_preview_publishes_binary_releases.contract.test.mjs
scripts/release/pipeline_release_wrapped_release_scripts_cli.contract.test.mjs
scripts/release/pipeline_run_github_audit_release_assets.contract.test.mjs
scripts/release/pipeline_run_github_commit_and_push.contract.test.mjs
scripts/release/pipeline_run_npm_set_preview_versions.contract.test.mjs
scripts/release/pipeline_run_release_wrapped_passthrough.contract.test.mjs
scripts/release/pipeline_run_smoke_cli.contract.test.mjs
scripts/release/pipeline_run_tauri_build_steps.contract.test.mjs
scripts/release/pipeline_run_tauri_validate_updater_pubkey.contract.test.mjs
scripts/release/pipeline_run_testing_create_auth_credentials.contract.test.mjs
scripts/release/pipeline_smoke_cli.contract.test.mjs
scripts/release/pipeline_tauri_build_updater_artifacts.contract.test.mjs
scripts/release/pipeline_tauri_collect_updater_artifacts.contract.test.mjs
scripts/release/pipeline_tauri_notarize_macos_artifacts.contract.test.mjs
scripts/release/pipeline_tauri_prepare_assets_cli.contract.test.mjs
scripts/release/pipeline_testing_create_auth_credentials_script.test.mjs
scripts/release/pipeline_ui_mobile_release_cli.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_environment_profile_guard.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_local_build_mode.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_publish_apk_auto.contract.test.mjs
scripts/release/pipeline_ui_mobile_release_skip_apk_release.contract.test.mjs
scripts/release/promote_branch.workflow.contract.test.mjs
scripts/release/promote_docs_deploy_branch.workflow.contract.test.mjs
scripts/release/promote_server_deploy_branch.workflow.contract.test.mjs
scripts/release/promote_server_runtime_release.workflow.contract.test.mjs
scripts/release/promote_ui_deploy_branch.workflow.contract.test.mjs
scripts/release/promote_ui_mobile_tags.workflow.contract.test.mjs
scripts/release/promote_website_deploy_branch.workflow.contract.test.mjs
scripts/release/publish-manifests.signature.test.mjs
scripts/release/publish_cli_binaries_version_tags.contract.test.mjs
scripts/release/publish_github_release.workflow.contract.test.mjs
scripts/release/publish_hstack_binaries_version_tags.contract.test.mjs
scripts/release/publish_run_contracts_auto_defaults.contract.test.mjs
scripts/release/publish_server_runtime.workflow.contract.test.mjs
scripts/release/publish_server_runtime_version_tags.contract.test.mjs
scripts/release/publish_ui_web.workflow.contract.test.mjs
scripts/release/publish_ui_web_version_tags.contract.test.mjs
scripts/release/relay_server_publish_config.contract.test.mjs
scripts/release/release-assets-e2e/prepare-local-monorepo.test.mjs
scripts/release/release-assets-e2e/run_help.test.mjs
scripts/release/release_actor_guard_action.contract.test.mjs
scripts/release/release_dev_to_main_workflow.inputs_contract.test.mjs
scripts/release/release_local_orchestrator_logic.contract.test.mjs
scripts/release/release_orchestrator_preview.contract.test.mjs
scripts/release/release_titles.workflow.contract.test.mjs
scripts/release/server_postinstall_runner.contract.test.mjs
scripts/release/tauri_signing_key_file.test.mjs
scripts/release/tauri_validate_updater_pubkey_script.test.mjs
scripts/release/tests_workflow.binary_smoke_timeout.contract.test.mjs
scripts/release/tests_workflow.daemon_e2e_lane.contract.test.mjs
scripts/release/tests_workflow.installers_preview_smoke.contract.test.mjs
scripts/release/tests_workflow.installers_smoke.contract.test.mjs
scripts/release/tests_workflow.self_host_daemon.contract.test.mjs
scripts/release/ui_eas_apk_profiles.contract.test.mjs
scripts/release/ui_postinstall_runner.contract.test.mjs
scripts/release/ui_web_bundle.test.mjs
scripts/release/workflow_node_version_policy.contract.test.mjs
scripts/release/workflow_pipeline_prereqs.contract.test.mjs
scripts/release/workflow_secret_hardening.contract.test.mjs
scripts/release/workflows_node_script_paths.contract.test.mjs
scripts/release/workspaces.contract.test.mjs
package.json
.daggerignore
.github/actions/bootstrap-minisign/bootstrap-minisign.sh
.github/workflows/build-tauri.yml
.github/workflows/build-ui-mobile-local.yml
.github/workflows/deploy.yml
.github/workflows/publish-docker.yml
.github/workflows/publish-github-release.yml
.github/workflows/publish-server-runtime.yml
.github/workflows/publish-ui-web.yml
.github/workflows/publish-ui-release.yml
.github/workflows/release.yml
.github/workflows/promote-branch.yml
.github/workflows/promote-docs.yml
.github/workflows/promote-server.yml
.github/workflows/promote-ui.yml
.github/workflows/promote-website.yml
.github/feature-policy/preview.json
.github/feature-policy/production.json
apps/cli/package.json
apps/ui/eas.json
apps/stack/scripts/remote_cmd.mjs
apps/website/public/happier-release.pub
apps/website/public/install
apps/website/public/install-preview
apps/website/public/install-preview.ps1
apps/website/public/install-preview.sh
apps/website/public/install-server
apps/website/public/install-server.sh
... +89 more
```

### Website — apps/website

- Total audited files: 3
- UNWIRED: 2
- BRITTLE_HIGH: 2
- SLOW_HIGH: 0
- DUPLICATION: 3

**UNWIRED**

```text
apps/website/tests/index.release.test.js
apps/website/package.json
```

**BRITTLE_HIGH**

```text
apps/website/tests/index.release.test.js
apps/website/index.release.html
```

**DUPLICATION**

```text
apps/website/tests/index.release.test.js
apps/website/package.json
apps/website/index.release.html
```


---

## Appendix C — Key tracker sections (verbatim extracts)

These sections are included verbatim from `docs/testing/TESTING_INFRA_AUDIT_TRACKER.md` so the refactor plan stays complete even when we paraphrase elsewhere.



## Cross-suite duplication candidates

- [x] Type-safety escapes in tests (`as any`, `as unknown as`, `any`) — Observed repeatedly (e.g. `packages/protocol/src/account/settings/accountSettings.test.ts`, `packages/protocol/src/actions/actionExecutor.reviewStart.test.ts`, `packages/protocol/src/bugReports.*.test.ts`, `packages/tests/src/testkit/providers/satisfaction/messageSatisfaction.spec.ts`). **Impact:** hides contract drift and makes tests less refactor-friendly. **Next:** inventory all occurrences + decide a repo-wide approach (typed fixtures, `satisfies`, stricter helpers) while keeping boundary fixtures explicit.
- [x] Repeated “mock Response + stub global fetch” patterns — **Observed:** `packages/protocol/src/bugReports.submit.test.ts`, `packages/protocol/src/bugReports.similarIssues.test.ts`, `apps/server/sources/app/auth/providers/github/*.spec.ts` + multiple connect/auth integration specs, `apps/ui/sources/sync/engine/*/*.test.ts`, `packages/tests/suites/providers/daemon.stop.failureContext.test.ts`. **Impact:** duplicated `fetch` mocking (often hand-rolled `Response(...)`) increases drift risk and makes cleanup/restore inconsistent across suites. **Next:** standardize on one small helper per runner (Vitest + node/test), e.g. `withStubbedFetch({ impl, restore })` + a typed `jsonResponse(status, body)`; enforce `vi.unstubAllGlobals()`/`vi.restoreAllMocks()` in suite setup where appropriate.
- [x] Duplicated dotenv parsing helpers — **Observed:** stack tooling uses `apps/stack/scripts/utils/env/dotenv.mjs` (simple `KEY=VALUE` + quote stripping + `~` expansion), while pipeline tooling uses `scripts/pipeline/env/parse-dotenv.mjs` (supports multiline quoted values and escape sequences). **Impact:** drift risk in env-file semantics across tooling (especially multiline quoting and `~` expansion), and duplicated parsers make it harder to standardize env precedence. **Next:** choose one canonical parser (or a shared core tokenizer) and layer policy (multiline support, `~` expansion) per consumer.
- [x] Duplicated testID sanitizers (`toTestIdSafeValue` / “replace unsafe chars with underscores”) — **Observed:** production helper `apps/ui/sources/utils/ui/toTestIdSafeValue.ts` (and tests) plus multiple in-test reimplementations in UI unit tests and Playwright UI-e2e specs (e.g. `packages/tests/suites/ui-e2e/session.sourceControl.reviewScroll.spec.ts`). **Impact:** drift risk (selectors break in one suite when sanitizer rules change in another) and duplicated regexes increase maintenance. **Next:** centralize a single sanitizer in shared testkit (or reuse the UI helper from UI-e2e) and delete local copies.
- [x] Repeated “referential stability” tests for hook return values (Zustand/external-store selectors) — **Observed:** UI hook tests for `useMessagesByIds`, `useSessionMessages`, `useUserMessageHistory` assert `===` identity across re-renders and/or “no React 18 getSnapshot cached” warnings. **Impact:** high brittleness (pins memoization strategy + React warning copy) and spreads a mostly-duplicated “seed storage → react-test-renderer + flush microtasks” harness across files. **Next:** decide if identity is truly a perf contract; if yes, centralize a shared `withSeededStorageStore` + `renderHook` harness and make warning assertions more resilient; if no, prefer testing observable behavior and keep only one smoke stability test.
- [x] Duplicated Windows spawn shim tests (.cmd/.npm wrappers) — **Observed:** `.win32CmdShim`/`.win32NpmShim` tests in CLI (e.g. CodeRabbit backend spawn, Codex ACP/resume shims, CLI snapshot shims) all re-implement variants of “force `process.platform=win32` → mock `child_process.spawn` → assert wrapper args/options”. **Impact:** boilerplate + drift risk (hard to keep quoting/`windowsVerbatimArguments` semantics consistent) and tests can become flaky due to ad-hoc `setTimeout(0)` close events. **Next:** extract a shared `withPlatform('win32')` + `fakeChildProcess()` harness and a table-driven “wrap command for Windows” assertion helper.
- [x] Repeated “bundle workspace deps + vendor runtime deps” test scaffolding — **Observed:** `apps/cli/scripts/__tests__/bundleWorkspaceDeps.test.ts`, `apps/stack/scripts/bundleWorkspaceDeps.test.mjs`, `packages/relay-server/scripts/bundleWorkspaceDeps.test.mjs`, `packages/cli-common/tests/vendorBundledPackageRuntimeDependencies.test.mjs`. **Impact:** duplicated fake-repo tree builders (`writeJson`, nested `node_modules` graphs) and parallel assertions (“dep-a → dep-b vendored”) drift when bundling policy changes. **Next:** extract a shared “fake repo + node_modules graph” builder + a single table-driven vendoring assertion helper (runner-specific wrappers), and keep per-package tests focused on their unique bundle set + dest layout.
- [x] Provider CLI install hints/specs duplicated across packages — **Observed:** provider install hint substring pins live in `packages/agents/src/providers/cliInstallSpecs.spec.ts` (agent registry specs), `packages/cli-common/tests/providers.test.mjs` (install plans + Windows shim execution), and stack tooling like `apps/stack/scripts/utils/cli/prereqs.mjs` (install-hints error copy). **Impact:** upstream install URL/package changes require multiple updates; inconsistent hints/copy can drift across UX surfaces; tests over-pin raw strings via `JSON.stringify(...).includes(...)`. **Next:** centralize provider install specs + hint strings in one canonical module (and keep one canonical per-provider hint test); have agents/cli-common/stack consume that data and reduce consumer tests to “imports/forwards canonical hints” smokes.
- [x] Duplicate “published installer artifacts” contracts across suites — **Observed:** release contracts enforce website installer parity via `scripts/release/installers_published_sync.test.mjs` (byte-for-byte `apps/website/public/*` vs `scripts/release/installers/*`), while the website suite separately asserts installer anchors/commands via `apps/website/tests/index.release.test.js` (currently unwired). **Impact:** duplicated contract surfaces + split ownership; drift can go unnoticed if one lane is not run. **Next:** consolidate on a single contract lane (prefer `yarn test:release:contracts`) or explicitly wire the website suite and reduce one side to minimal signal.
- [x] Duplicated “publisher version tags + invalid minisign key” contract tests — **Observed:** `scripts/release/publish_cli_binaries_version_tags.contract.test.mjs`, `scripts/release/publish_hstack_binaries_version_tags.contract.test.mjs`, `scripts/release/publish_server_runtime_version_tags.contract.test.mjs`, `scripts/release/publish_ui_web_version_tags.contract.test.mjs` all re-assert the same pattern (rolling tag + version tag + “fail fast before heavy build”). **Impact:** boilerplate + drift risk (tag prefixes, sentinel “heavy step” strings, and error copy). **Next:** table-drive these cases over `{ scriptPath, rollingTagPrefix, versionTagPrefix, heavyStepSentinel }` and keep one canonical assertion helper.
- [x] Repeated “mini CLI helpers” across pipeline scripts — **Observed:** many `scripts/pipeline/**` entrypoints reimplement `fail()`, `parseBool/parseBoolString`, `run(execFileSync)` wrappers, and `writeGithubOutput` helpers (e.g. `scripts/pipeline/npm/release-packages.mjs`, `scripts/pipeline/expo/download-android-apk.mjs`, `scripts/pipeline/release/resolve-bump-plan.mjs`). **Impact:** drift in validation/timeout defaults + inconsistent dry-run and logging conventions. **Next:** extract a shared `scripts/pipeline/lib/cli.mjs` (or similar) for bool parsing, `execFileSync` wrapper, and `GITHUB_OUTPUT` writing, and keep per-command logic minimal.
- [x] Duplicated release publisher scripts (CLI/stack/server/ui-web) — **Observed:** `scripts/pipeline/release/publish-cli-binaries.mjs`, `scripts/pipeline/release/publish-hstack-binaries.mjs`, `scripts/pipeline/release/publish-server-runtime.mjs`, `scripts/pipeline/release/publish-ui-web.mjs` share the same skeleton (minisign bootstrap + key preflight, optional `test:release:contracts`, optional installer sync check, build artifacts, publish manifests, verify, then publish rolling + version tags). **Impact:** drift risk (policy changes or fixes applied to one publisher but not others). **Next:** consolidate into a parameterized publisher harness (product metadata + build script + tag/title prefixes + artifact dir + manifest product id) with thin per-product wrappers.
- [x] Duplicated “server id derivation + auth bootstrap to `access.key`” helpers (key-challenge `/v1/auth`) — **Observed:** `apps/cli/src/configuration.ts#deriveServerIdFromUrl`, `packages/tests/src/testkit/cliAuth.ts`, `scripts/pipeline/testing/create-auth-credentials.mjs`, and `scripts/release/release-assets-e2e/bin/terminal-auth-approve.cjs` each implement variants of: (a) derive/sanitize server id from URL, and/or (b) do a key-challenge auth call to `/v1/auth` and write `homeDir/servers/<id>/access.key`. **Impact:** drift risk (server-id hashing/sanitization changes, auth payload shape changes, or credentials schema changes must be updated in multiple places) + inconsistent libs (`tweetnacl` vs Node crypto) and defaults (fixed secret vs random). **Next:** extract a single shared helper (`createAuthCredentials({ serverUrl, homeDir, activeServerId? })` + `deriveServerIdFromUrl`) usable from CLI testkit + pipeline + release-assets-e2e, with table-driven tests against the canonical CLI behavior.
- [x] Duplicated git `--name-status -z` parsing helpers — **Observed:** stack scripts parse entries in `apps/stack/scripts/utils/git/parse_name_status_z.mjs`, while the CLI parses paths in `apps/cli/src/scm/backends/git/operations/commitOperations.ts` (`parseZTerminatedTokens` + `parseGitNameStatusZPaths`) with the same null-delimited token contract and special-casing `R*`/`C*` (rename/copy) to consume 2 paths. **Impact:** drift risk if git output nuances are handled differently (rename score tokens, empty trailing separators), and duplicated parsing logic encourages subtle inconsistencies in “touched paths” derivation. **Next:** extract one canonical parser (or at least one canonical tokenization helper) and reuse from both runtimes, with table-driven cases for `A/M/D/R/C` and weird token edges.
- [x] Repeated `stripAnsi` (ANSI escape stripping) helpers — **Observed:** stack uses `apps/stack/scripts/utils/ui/text.mjs` while other suites re-implement similar regexes in `apps/stack/scripts/tailscale_cmd_output.test.mjs`, `packages/tests/src/testkit/process/uiWeb.ts`, and `apps/cli/src/backends/claude/cli/command.settingsFlag.test.ts`. **Impact:** drift risk (regex coverage differs; new escape sequences may be handled inconsistently) and duplicated tiny helpers encourage more one-off implementations. **Next:** centralize a small `stripAnsi(text)` helper per runtime (node:test + TS) or a shared module with a table-driven test corpus of escape sequences seen in logs.
- [x] Duplicated “review runner home/env isolation” helpers (CodeRabbit XDG + Codex `CODEX_HOME` seeding) — **Observed:** stack review runners set `CODERABBIT_HOME` + XDG dirs in `apps/stack/scripts/utils/review/runners/coderabbit.mjs` and seed `CODEX_HOME` auth in `apps/stack/scripts/utils/review/tool_home_seed.mjs`; the CLI has parallel implementations in `apps/cli/src/agent/reviews/engines/coderabbit/buildCodeRabbitEnv.ts` and codex daemon spawn hooks/tests (e.g. `apps/cli/src/backends/codex/daemon/spawnHooks.test.ts`). **Impact:** drift risk in auth/config isolation rules (which vars are safe to override, what gets copied, which configs are intentionally excluded), and duplicated logic makes cross-tool debugging harder. **Next:** pick one canonical policy module per tool (CodeRabbit, Codex) and reuse it from both `apps/stack` and `apps/cli`, with shared tests for env overlay + file-copy semantics.
- [x] Duplicated launchd/service-definition logic (Darwin autostart) across runtimes — **Observed:** stack maintains its own LaunchAgent plist generation + `launchctl` enable/disable flows in `apps/stack/scripts/utils/service/autostart_darwin.mjs`, while `@happier-dev/cli-common` has parallel service backend code under `packages/cli-common/src/service/launchd.ts` (and shared `manager.ts` planning). **Impact:** drift risk in PATH/env/working-directory conventions and restart semantics (`KeepAlive SuccessfulExit=false`), plus duplicated bug surface for OS changes. **Next:** decide which module is canonical for launchd and have both `apps/stack` and `apps/cli` depend on it, keeping stack’s wrapper thin.
- [x] Repeated “core-e2e harness boilerplate” (run dirs + server-light + manifest/artifacts + ad-hoc HTTP wrappers) — **Observed:** many `packages/tests/suites/core-e2e/*.test.ts` files re-implement local `requestJson(...)` wrappers, `asRecord/getNumber/getString` JSON parsing, plus the same `createRunDirs`/`startServerLight`/`createTestAuth`/`writeTestManifestForServer`/`FailureArtifacts`/`envFlag`/`waitFor` scaffolding. **Impact:** churn + drift risk (small protocol/route changes require edits across many tests) and inconsistent error/timeout handling. **Next:** extract a canonical `createCoreE2eHarness({ testName, serverEnv, withSockets, withCli })` + a shared `requestJson`/`assertOkJson` helper, and keep per-test assertions focused on behavior.
- [x] Repeated “trusted refs for manual dispatch” guard blocks across release workflows — **Observed:** near-identical `workflow_dispatch` guard snippets (allow only `dev|main`, fail closed) repeated in `deploy.yml`, `release.yml`, `promote-*.yml`, `build-tauri.yml`. **Impact:** drift risk (one workflow can weaken/omit guard) and noisy diffs when policy changes. **Next:** extract a single reusable composite action or a `scripts/pipeline/` helper invoked from workflows; keep contract tests validating the shared implementation + ensuring all secret-bearing workflows include it.
- [x] Hardcoded `apps/cli/node_modules/*` resolution inside core-e2e harnesses — **Observed:** Codex MCP e2e builds a fake MCP server script by resolving absolute paths into `apps/cli/node_modules/@modelcontextprotocol/sdk/dist/...` and `apps/cli/node_modules/zod/index.js`; Gemini/OpenCode ACP e2e resolve `apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js` similarly. **Impact:** fragile across hoisting/layout changes (yarn/pnpm, PnP) and SDK path refactors; increases CI flake risk. **Next:** expose stable testkit helpers to run fake MCP/ACP servers (or import SDKs via normal resolution) and centralize fake engine wiring.
- [x] Duplicated provider token-ledger aggregation logic across scripts + harness — **Observed:** `packages/tests/scripts/provider-token-ledger-summary.mjs`, `packages/tests/scripts/run-providers-parallel.mjs`, `packages/tests/src/testkit/providers/harness/tokenLedger.ts`, and `packages/tests/src/testkit/providers/harness/index.ts` each implement token-map normalization + merging + per-provider/model summaries/totals (slightly diverged). **Impact:** drift risk (schema/normalization changes must be updated in multiple places) and inconsistent reporting/validation behavior across lanes (script reporting vs harness ledger capture). **Next:** extract one canonical `providerTokenLedger` module (parse/validate/merge/summarize/format) and have scripts + harness depend on it.
- [x] Duplicated “no browser open” gating + opener abstractions — **Observed:** both stack tooling (`apps/stack/scripts/utils/ui/browser.mjs` + `apps/stack/scripts/utils/ui/browser.test.mjs`) and CLI (`apps/cli/src/ui/openBrowser.ts` + `apps/cli/src/ui/openBrowser.test.ts`) implement “do not open a browser” gates (e.g. `HAPPIER_NO_BROWSER_OPEN`, CI/TTY checks) with separate opener selection and test harnesses (`PATH` shims vs `process.stdout.isTTY` patching). **Impact:** drift risk (inconsistent gate conditions) and duplicated brittle test harnesses. **Next:** centralize the gating decision + opener interface in one shared module and keep suite tests focused on the shared decision contract.
- [x] Duplicated “best-effort JSON extraction from mixed stdout” helpers — **Observed:** `apps/stack/tests/self-host-config.test.mjs` defines `parseJsonLinesBestEffort(...)` and other stack tests/scripts use variants like “find first `{` and `JSON.parse(stdout.slice(start))`” (e.g. `apps/stack/tests/stack-duplicate-normalization.test.mjs`, `apps/stack/scripts/test_cmd.test.mjs`, `apps/stack/scripts/remote_cmd.mjs`). **Impact:** brittle + inconsistent parsing when stdout includes banners/logs alongside JSON, and error diagnostics differ per file. **Next:** extract a single `parseJsonFromStdoutBestEffort({ stdout })` helper (node:test-friendly) that supports “whole stdout is JSON”, “JSON line in mixed output”, and “first JSON object/array span”, with consistent diagnostics.
- [x] Duplicated tiny CLI arg parsing + output gating helpers (`parseArgs`/`wantsJson`/`wantsHelp`) — **Observed:** `apps/stack/scripts/utils/cli/{args,cli}.mjs`, `scripts/pipeline/release/lib/binary-release.mjs`, `packages/tests/scripts/run-providers*.mjs`, and `apps/cli/src/sessionControl/jsonOutput.ts`. **Impact:** subtle drift in supported flag forms (`--k=v` vs `--k v`, `-h` handling), inconsistent “stdout reserved for JSON” guarantees, and repeated brittle edge-case tests. **Next:** standardize on one small shared helper per runtime (node scripts vs TS apps) or a shared spec + table-driven tests, then delete near-identical implementations.
- [x] Duplicated dotenv parsing + env-file mutation helpers (Node + shell) — **Observed:** `apps/stack/scripts/utils/env/{dotenv,env_file}.mjs` and SwiftBar shell parsing in `apps/stack/extras/swiftbar/lib/utils.sh` (`dotenv_get`), plus ad-hoc env editing elsewhere. **Impact:** drift risk (quoting/escaping/`export` handling differs), and “write back env file” formatting can diverge across tools. **Next:** define one canonical “env text contract” (parse + upsert + prune) and reuse across stack scripts + SwiftBar (or expose a single `hstack` JSON snapshot/command for SwiftBar to consume).
- [x] Duplicated “resolve workspace name by reading package.json” helpers in scripts — **Observed:** `packages/tests/scripts/extended-db-docker.plan.mjs` and `packages/tests/scripts/run-providers-parallel.mjs` both read `apps/{cli,server}/package.json` to resolve workspace names with near-identical fallback behavior. **Impact:** drift risk (workspace renames, JSON parsing behavior, cache semantics) and duplicated IO/edge-case handling. **Next:** extract a single `resolveWorkspacePackageName({ path, fallback })` helper in `packages/tests/scripts/` (or a shared testkit module) and reuse it across all orchestration scripts.
- [x] Duplicated “spawn child runner wrappers” (heartbeat/timeout/signal forwarding/kill-tree) across `packages/tests/scripts/*` — **Observed:** `packages/tests/scripts/run-vitest-with-heartbeat.mjs` (heartbeat + `--no-file-parallelism`), `packages/tests/scripts/run-providers.mjs` (watchdog timeout + kill tree), `packages/tests/scripts/run-providers-parallel.mjs` (signal shutdown + kill tree), and `packages/tests/scripts/run-extended-db-docker.mjs` (sync timeouts + signal cleanup). **Impact:** inconsistent kill/timeout semantics and drift risk; duplicated env-var contracts and diagnostics across lanes. **Next:** extract a shared `runChild({ cmd,args, env, heartbeatMs?, timeoutMs?, terminateTree? })` helper (and reuse `processTree`) so each script declares only its unique behavior.
- [x] Repeated Node ESM loader stubbing via `data:` URLs (internal mocks) — **Observed:** several `apps/stack/scripts/*setup*.test.mjs`, `apps/stack/scripts/review_pr.*.test.mjs`, and `apps/stack/scripts/orchestrated_stack_auth_flow_webapp_url.test.mjs` register an ESM loader to short-circuit internal imports (`./utils/*`, `node:child_process`) and capture behavior via marker logs. **Impact:** brittle specifier coupling + reduced confidence (tests validate mocked wiring more than real behavior) and duplicated loader/marker boilerplate. **Next:** prefer extracting pure policy functions for direct unit testing, or refactor scripts to accept injected deps; if loader approach remains, centralize into one `withLoaderStubs({ stubs, fn })` testkit with guardrails against mocking internal domain behavior.
- [x] Duplicated “spawn node + capture stdout/stderr” helpers in `node:test` suites — **Observed:** multiple `apps/stack/scripts/*.test.mjs` files hand-roll `spawn(process.execPath, ...)` capture loops, while other lanes have their own capture helpers (e.g. `packages/tests/src/testkit/process/spawnProcess.ts`, UI-e2e `cliJson.ts`). **Impact:** inconsistent timeouts/stdio wiring + divergent diagnostics, plus global env/cwd restoration patterns vary per file. **Next:** standardize per-runner helpers (`node:test` + Vitest) like `runNodeCapture({ args, cwd, env, input? })` + `assertExitOk({ code, stdout, stderr })`, and keep only per-suite special cases.
- [x] Duplicated dataKey encryption implementations (AES-256-GCM bundle) — **Observed:** `apps/cli/src/api/encryption.ts` implements `encryptWithDataKey`/`decryptWithDataKey`, while `packages/tests/src/testkit/rpcCrypto.ts` re-implements the same byte bundle format (`[v0][nonce12][ciphertext][authTag16]`) for test RPC/session fixtures. **Impact:** subtle format drift risk (bundle versioning, nonce/tag handling, JSON serialization compatibility) could break e2e tests or mask regressions if the two implementations diverge. **Next:** share a single canonical dataKey crypto implementation (or re-export CLI/protocol crypto into tests) and add a compatibility test that asserts cross-module roundtrip equivalence.
- [x] Duplicated provider scenario catalogs (live vs legacy) — **Observed:** `packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts` is the canonical id→factory registry used by the providers harness, while `packages/tests/src/testkit/providers/scenarios/scenarios.{claude,codex,opencode}.ts` define large scenario arrays but appear unwired (no imports found outside docs/README/tracker). **Impact:** drift risk + confusion about the source of truth; stale scenario modules can silently diverge and then break when re-wired later. **Next:** pick one canonical scenario catalog (likely `scenarioCatalog.ts`), delete/merge the dead modules, and keep scenario builders in small shared primitives (`scenarios.acp.ts` + a DSL) to reduce duplication.
- [x] Duplicated “find an available port” helpers — **Observed:** `packages/tests/src/testkit/process/uiWeb.ts` implements `resolveAvailablePort()` while `packages/tests/src/testkit/network/reserveAvailablePort.ts` provides the same “bind :0 then close” mechanism. **Impact:** drift + inconsistent fixes (race/collision handling) across UI e2e harnesses. **Next:** use a single canonical helper (and document the race window + recommended usage patterns).
- [x] Duplicated `stripAnsi(...)` helpers — **Observed:** `packages/tests/src/testkit/process/uiWeb.ts` defines its own ANSI-stripper while similar helpers exist in other suites/scripts (e.g. `apps/stack/scripts/utils/ui/text.mjs`, `apps/cli/src/backends/claude/cli/command.settingsFlag.test.ts`). **Impact:** small but repeated regex differences + inconsistent handling can cause subtle log-parsing drift. **Next:** standardize on one shared helper (or import an existing one) for log parsing across infra.
- [x] Duplicated JSONL/log polling helpers — **Observed:** `packages/tests/src/testkit/toolTraceJsonl.ts` (JSONL parse + tool-call scan), `packages/tests/src/testkit/providers/harness/index.ts` (`readJsonlEvents`), `packages/tests/src/testkit/fakeClaude.ts` (JSONL log polling), and `packages/tests/src/testkit/waitForRegexInFile.ts` (poll file until regex match). **Impact:** drift risk (slightly different parsing/error-handling/limits) + extra CI IO pressure (re-reading whole growing files). **Next:** extract a shared `jsonl.ts` (parse/validate/tail) + `waitForInFile` utilities with bounded tailing/seek behavior and consistent diagnostics.
- [x] Duplicated tmux-e2e harness logic + “pass without executing” guards — **Observed:** `packages/tests/suites/core-e2e/daemon.tmux.spawn.attach.switch.slow.e2e.test.ts` and `packages/tests/suites/core-e2e/daemon.tmux.spawn.respawn.slow.e2e.test.ts` both re-implement `tmuxAvailable()` checks, attachment-info polling/parsing, and isolated-socket assumptions; both also use early `return` inside `it(...)` when tmux/uid isn’t available (test reports green but scenario never ran). **Impact:** duplicated, OS-specific complexity drifts easily; hidden-skips reduce signal in CI/local runs and can leave regressions undetected. **Next:** extract a single `withTmuxAvailable()` harness that either (a) hard-fails in CI when tmux is required, or (b) records an explicit “skipped due to missing dependency” artifact/metric instead of silently returning.
- [x] Duplicated process-tree termination utilities (scripts vs TS testkit) — **Observed:** `packages/tests/scripts/processTree.mjs` and `packages/tests/src/testkit/process/processTree.ts` both implement `isProcessAlive` + `terminateProcessTreeByPid` with OS-specific branches. **Impact:** drift risk (signal/grace semantics, Windows behavior) and inconsistent fixes across lanes (providers runner scripts vs in-process testkit harnesses). **Next:** pick one canonical implementation (with typed surface) and have both scripts and TS testkit depend on it.
- [x] Duplicate provider scenario definitions + dead/unwired scenario files — **Observed:** canonical scenario factory map appears to live in `packages/tests/src/testkit/providers/scenarios/scenarioCatalog.ts` (scenario ids like `execute_trace_ok`, `bash_echo_trace_ok`, `acp_resume_load_session`), while per-provider scenario arrays in `packages/tests/src/testkit/providers/scenarios/scenarios.{claude,codex,opencode}.ts` appear **unimported** (only referenced by `packages/tests/README.md`). **Impact:** drift risk + dead code (changes to scenarios in one place won’t affect the actual providers lane). **Next:** either delete the dead files or make them canonical by importing/merging them into `scenarioCatalog.ts` (single source of truth).
- [x] Dead/unwired helper unit tests under `packages/tests/src/testkit/**.test.ts` — **Observed:** `packages/tests/src/testkit/providers/harness/harnessEnv.test.ts` and `packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts` are Vitest tests but **not included** by any `packages/tests/vitest.*.config.ts` include globs (configs include `suites/**` plus an allowlist of `*.spec.ts`). **Impact:** false sense of coverage + drift (tests never run in CI). **Next:** move these tests into `packages/tests/suites/providers/` (or rename to allowlisted `*.spec.ts` and add to the include allowlist, or intentionally broaden include globs with care).
- [x] Repeated encrypted RPC “call helper” implementations in core e2e — **Observed:** multiple files define near-identical `callSessionRpc`/`callMachineRpc` wrappers (encrypt request → socket rpcCall → decrypt result → zod safeParse + waitFor), e.g. `packages/tests/suites/core-e2e/executionRuns.*.test.ts`, `packages/tests/suites/core-e2e/ephemeralTasks.*.test.ts`, `packages/tests/suites/core-e2e/memory.*.test.ts`. **Impact:** drift risk (timeout/defaults/error handling) and a common source of subtle flakes. **Next:** extract a single `encryptedRpcCall({ targetId, method, req, schema })` helper in `packages/tests/src/testkit/`.
- [x] Duplicated socket update “finders” and event-shape probing in core e2e — **Observed:** ad-hoc scanners like `findPendingChangedAfter(...)` in `packages/tests/suites/core-e2e/pendingQueue.socket.pendingChanged.test.ts`, plus repeated inline `events.filter(e => e.kind==='update' && e.payload?.body?.t==='new-message')` patterns in reconnect/message tests (e.g. `packages/tests/suites/core-e2e/reconnect.*.test.ts`). **Impact:** inconsistent handling of `{ sid }` vs `{ sessionId }` and divergent timeouts make tests brittle/flaky, and the same contract gets asserted in slightly different ways. **Next:** centralize a typed `findUpdateBodies({ t, sessionId, afterIndex })`/`countUpdates(...)` helper (extend `packages/tests/src/testkit/updates.ts`) and have tests use it consistently.
- [x] Repeated “rateLimit config exists” route-registration specs — **Observed:** many `apps/server/sources/app/api/routes/**/**/*.rateLimit.spec.ts` files implement a near-identical FakeApp that asserts `opts.config.rateLimit` exists (and sometimes only checks `max/timeWindow` are present). **Impact:** low-signal duplication that increases churn when route registration mechanics change and does not validate enforcement behavior. **Next:** consolidate into (1) a single table-driven spec per route group or (2) a shared helper that asserts a small, stable rate-limit contract for a list of paths, and keep only the few routes with custom `keyGenerator`/override env logic as dedicated tests.
- [x] Duplicated “persistent auth token init retry (DOMException DataError)” coverage — **Observed:** `apps/server/sources/app/auth/auth.oauthState.fallback.spec.ts` and `apps/server/sources/app/auth/auth.persistentSeedCompatibility.spec.ts` both `vi.doMock('privacy-kit')` to throw `DOMException(..., 'DataError')` on first init and assert that `auth.init()` retries and then succeeds. **Impact:** duplicated maintenance + drift risk for subtle init/compat behavior. **Next:** consolidate into one table-driven “persistent token init compatibility” spec (keep oauth-state fallback behavior separate).
- [x] Repeated “feature gate default + env override” micro-specs across server features — **Observed:** many `apps/server/sources/app/features/*Feature*.spec.ts` (especially `*.feat.*.spec.ts`) follow the same pattern: assert default enabled, assert env override, sometimes assert build-policy deny. **Impact:** low-signal repetition + scattered default pinning increases churn if feature payload shape/defaults evolve. **Next:** centralize common env parsing helpers and add a table-driven “represented feature gate contracts” spec that covers the shared invariants; keep per-feature tests for unique parsing/diagnostics only.
- [x] Repeated `*.changes.spec.ts` “AccountChange + build*Update + emitUpdate” harness patterns — **Observed:** `apps/server/sources/app/feed/feedPost.changes.spec.ts`, `apps/server/sources/app/kv/kvMutate.changes.spec.ts`, `apps/server/sources/app/session/sessionDelete.changes.spec.ts`, `apps/server/sources/app/social/friends.changes.spec.ts`, `apps/server/sources/app/social/usernameUpdate.changes.spec.ts` all mock `markAccountChanged` + `randomKeyNaked` + `eventRouter` builders/emission and often use `txHarness`/after-tx helpers. **Impact:** duplicated orchestration assertions (call counts, nth-call, cursor threading) increase churn and make it easy to accidentally test the same contract many times while missing edge cases. **Next:** extract a single shared “change emission contract” helper (given `{kind, entityId, participants}`) and keep only domain-unique behaviors in each spec.
- [x] Repeated socket.io “start server + connect_error parsing + env patcher” patterns — **Observed:** `apps/server/sources/app/api/socket.authPolicy.integration.spec.ts` (and likely other socket integration specs) repeatedly boot Fastify+socket on ephemeral port, wire client with `socket.io-client`, and parse `connect_error` payload shape, plus hand-manage env via `createEnvPatcher`. **Impact:** duplicated orchestration makes socket policy tests slow/flaky and risks inconsistent cleanup/timeout handling; also leaves existing socket-specific harnesses under-used. **Next:** consolidate into a `socketHarness` helper that owns listen/close, client connect/await-fail, and typed error payload parsing; keep test logic focused on policy outcomes.
- [x] Repeated “SQLite + Prisma migrate deploy bootstrap + env restore + Fastify createTestApp” integration boilerplate — **Observed:** many `apps/server` integration specs (notably `apps/server/sources/app/api/routes/auth/*.integration.spec.ts` and `apps/server/sources/app/api/routes/connect/*.integration.spec.ts`) hand-roll: temp dir + `DATABASE_URL` + `HAPPIER_DB_PROVIDER`/`HAPPY_DB_PROVIDER` + `applyLightDefaultEnv` + `ensureHandyMasterSecret` + `spawnSync('yarn prisma migrate deploy …')` (+ `RUST_LOG=info`) + `initDbSqlite`/`db.$connect` + per-test `restoreEnv()` + close tracker. **Impact:** high duplication, inconsistent cleanup semantics, and slow/flaky risk (subprocess + filesystem + global env mutations) repeated across many files. **Next:** consolidate into a single canonical integration harness (likely extend/standardize `createLightSqliteHarness` / `lightSqliteHarness.ts`) that owns env snapshot/restore, prisma migrate deploy (or pre-migrated template DB), Fastify app creation, and deterministic cleanup.
- [x] Duplicated OIDC stub server implementations — **Observed:** `apps/server/sources/app/api/testkit/oidcStub.ts` defines a full OIDC stub (discovery/jwks/authorize/token/userinfo), while `apps/server/sources/app/auth/providers/oidc/oidcOffboardingRefresh.integration.spec.ts` re-implements a separate OIDC HTTP server inline with similar behaviors. **Impact:** duplication increases drift risk and makes auth-provider tests harder to maintain/extend consistently (refresh-token edge cases, subject/nonce semantics, userinfo claims). **Next:** standardize all OIDC-provider tests on a single stub helper (`startOidcStubServer`) with configurable knobs (refresh responses, subject override, error modes).
- [x] Repeated “hand-rolled RPC handler manager” harnesses (`new Map()` + `registerHandler`) — **Observed:** multiple CLI RPC handler unit tests (e.g. `apps/cli/src/rpc/handlers/attachmentsUpload.test.ts`, `apps/cli/src/rpc/handlers/fileSystem.pathResolution.test.ts`, `apps/cli/src/rpc/handlers/sessionLogTail.test.ts`) re-implement a minimal `RpcHandlerManager`/registrar. **Impact:** duplication + inconsistent typing (`any` casts) and easy drift when method naming/registration expectations change. **Next:** extract a single typed `createTestRpcHandlerManager()` testkit for Vitest and use it consistently across RPC handler tests.
- [x] Duplicated encrypted RPC test harnesses (encrypt→manager→decrypt) — **Observed:** `apps/cli/src/rpc/handlers/encryptedRpc.testkit.ts` and `apps/cli/src/scm/rpc/__tests__/testRpcHarness.ts` both build an encrypted `RpcHandlerManager` client that base64-encrypts params and decrypts responses. **Impact:** drift risk (encryption variant/shape changes must be updated twice) and inconsistent typing/casting; encourages “copy harness into new test folder” growth. **Next:** extract one canonical `createEncryptedRpcTestClient({ scopePrefix, registerHandlers, workingDirectory? })` usable by both unit and integration tests (or have SCM harness re-export it) and delete the duplicate.
- [x] Multiple overlapping env scoping/restore helpers (risk of leaks) — **Observed:** `apps/cli/src/testkit/env.testkit.ts` (`snapshot/restoreProcessEnv`), `apps/cli/src/ui/testkit/authNonInteractiveGlobals.testkit.ts` (`createEnvKeyScope`), and `apps/cli/src/backends/codex/resume/resumeResolve.testkit.ts` (`withResumeEnv`) all implement partial env scoping with slightly different semantics. **Impact:** inconsistent restoration rules and higher chance of leaked env across tests, especially with `vi.resetModules()` patterns. **Next:** standardize on one small, typed env-scope helper (e.g. `withEnvScope(keys, values, fn)` + `withProcessEnvSnapshot(fn)`) and migrate the ad-hoc ones to wrappers around it.
- [x] Duplicated “fast-start” runner orchestration test harnesses — **Observed:** `apps/cli/src/backends/claude/runClaude.fastStart.integration.test.ts` and `apps/cli/src/backends/codex/runCodex.fastStart.integration.test.ts` share near-identical patterns (tight real-time windows like 75–150ms, `process.exit` spying, config reload, timing-line log assertions, and heavy internal module mocking). **Impact:** flakiness risk + high maintenance for wiring-level tests; encourages copy/paste for new backends. **Next:** extract one canonical “runner fast-start contract” harness using fake timers (or explicit seam injection returning a structured “startup plan”), keep only the highest-signal integration test(s), and move the rest to smaller unit-level invariants with stable seams.
- [x] Duplicated provider CLI probe gating + PATH resolution helpers — **Observed:** repeated `which/where` helpers and env-gated “real binary probes” across `apps/cli/src/backends/*/cli/capability.loadSession.e2e.test.ts` (e.g., Codex + OpenCode). **Impact:** inconsistent gating semantics and many “opt-in probes” that can silently never run in CI; duplicated shelling-out logic. **Next:** standardize a shared `resolveBinaryOnPath` + `resolveProbeGate` helper and prefer deterministic ACP shims (like Kilo’s) for enforceable tests; keep true external probes in a dedicated “providers/probes” lane with explicit CI wiring.
- [x] Repeated “is binary installed?” skip probes for optional external tools — **Observed:** `apps/cli/src/integrations/difftastic/index.integration.test.ts` (`difft --version`), `apps/cli/src/integrations/ripgrep/index.integration.test.ts` (`rg --version`), `apps/cli/src/integrations/tmux/tmux.real.integration.test.ts` (`tmux -V`) all implement bespoke `spawnSync` availability checks + `describe.skipIf(...)`. **Impact:** tests can silently never run in CI depending on tool installation and env gates; duplicated probe logic + inconsistent diagnostics. **Next:** standardize a small `requireBinaryOrSkip({ cmd, args, gateEnv? })` helper and make lane expectations explicit (either install the tool in CI or keep the suite opt-in with a dedicated lane).
- [x] Repeated “local http server + env + reloadConfiguration + console capture” harness in CLI command integration tests — **Observed:** `apps/cli/src/api/sessionClient.pendingQueueV2.integration.test.ts`, `apps/cli/src/cli/commands/resume.integration.test.ts`, `apps/cli/src/cli/commands/session/archive.integration.test.ts` (and similar). **Impact:** boilerplate + risk of inconsistent teardown/env restore; encourages patchwork variations (different restore patterns, missing client `close()`). **Next:** extract a shared `withLocalHttpServer()` + `withServerEnv()` + `withConsoleCapture()` harness for CLI integration tests and enforce consistent teardown.
- [x] Repeated “mock socket.io encrypted RPC call” harnesses across session command tests — **Observed:** `apps/cli/src/cli/commands/session/delegate/start.integration.test.ts`, `apps/cli/src/cli/commands/session/executionRunGet.integration.test.ts`, `apps/cli/src/cli/commands/session/plan/start.integration.test.ts`, `apps/cli/src/cli/commands/session/review/start.integration.test.ts`, and many `apps/cli/src/cli/commands/session/run/*.integration.test.ts` files all re-implement the same pattern: load session to get DEK, `vi.mock('socket.io-client')`, decrypt `SOCKET_RPC_EVENTS.CALL` params, and return an encrypted result. **Impact:** duplication + drift risk for RPC param/result shapes, encryption variant handling, and socket mock lifecycle; hard to update when RPC surface evolves. **Next:** centralize a `createEncryptedSocketRpcMock({ dek, onCall })` helper and a `withEncryptedSessionFixture()` server fixture; keep per-command tests focused on command-specific params/envelope only.
- [x] Repeated “temp git repo init” harnesses (real `git` subprocess orchestration) — **Observed:** `apps/cli/src/scm/runtime.runScmCommand.test.ts` and `apps/cli/src/rpc/handlers/ephemeralTasks.test.ts` both create repos by calling `git init/config/add/commit` and then mutate files for diffs. **Impact:** duplicated orchestration increases runtime and can introduce flakiness where `git` is slow/unavailable; also encourages ad-hoc sleep-based coordination in higher-level tests. **Next:** extract a shared `withTempGitRepo({ initialFiles, commits, pendingChanges })` helper and keep only a small number of tests in unit lane that truly require real git; move broader flows to integration lane if needed.
- [x] Duplicate runtime detection coverage (unit + “integration”) — **Observed:** `apps/cli/src/utils/__tests__/runtime.test.ts` and `apps/cli/src/utils/__tests__/runtimeIntegration.test.ts` both re-assert the runtime classification matrix (`getRuntime/isNode/isBun/isDeno`) with only minor differences (dynamic import + export presence). **Impact:** redundant runtime checks increase maintenance without adding much behavior confidence; easy for the two files to drift. **Next:** keep one canonical runtime-behavior test and trim the other to a minimal “module exports exist / import works” check (or remove if redundant).
- [x] LocalStorage mocking duplication (multiple incompatible test helpers) — **Observed:** `apps/ui/sources/auth/flows/buildDataKeyCredentialsForToken.test.ts` + `apps/ui/sources/auth/storage/tokenStorage.*.test.ts` use `installLocalStorageMock` from `apps/ui/sources/auth/storage/tokenStorage.web.testHelpers.ts`, while `apps/ui/sources/auth/storage/tokenStorage.pendingExternalConnect.test.ts` re-implements an ad-hoc `installLocalStorage()` (different surface, no store visibility). **Impact:** duplicated + divergent “localStorage patch” patterns lead to inconsistent assertions and cleanup; easier to leak globals; hard to reuse store/key assertions. **Next:** standardize all TokenStorage web tests on the single helper and expand it if needed (e.g. expose store + mocks), removing ad-hoc installers.
- [x] Duplicated normalization coverage split between “mega spec” and focused tests — **Observed:** `apps/ui/sources/sync/typesRaw.spec.ts` overlaps heavily with `apps/ui/sources/sync/typesRaw/normalize.*.test.ts`. **Impact:** redundant fixtures + drift risk, and the mega-file increases maintenance + runtime. **Next:** pick a canonical layer (keep focused normalize.* tests + a few end-to-end cases, or split `typesRaw.spec.ts` into smaller topic files and delete duplicates).
- [x] Duplicate “no voice announcements from applySessions” assertions at multiple layers — **Observed:** `apps/ui/sources/sync/store/domains/sessions.voiceSideEffects.test.ts` and `apps/ui/sources/sync/sync.voicePermissionRequests.test.ts`. **Impact:** doubled maintenance and easy for one test to become ineffective (already: store-domain test declares a `sendTextMessage` spy but never wires it). **Next:** keep one canonical behavior test at the boundary that actually owns voice (sync layer with RealtimeSession boundary mock), and keep store-domain tests focused on state mapping only.
- [x] Repeated “no unhandledRejection” regression harnesses (process-global listeners) — **Observed:** `apps/ui/sources/__tests__/voice/settings/localDirectSection.unhandledRejection.test.tsx`, `apps/cli/src/agent/permissions/BasePermissionHandler.allowlist.test.ts`, `apps/cli/src/agent/permissions/CodexLikePermissionHandler.test.ts` (and similar patterns likely elsewhere). **Impact:** these tests are valuable but easy to get wrong (listener leaks, timing flake); copy/paste increases drift and can create false positives/negatives. **Next:** extract a small shared helper per runner (Vitest) like `expectNoUnhandledRejection(async fn)` or `withUnhandledRejectionSpy(async fn)` that installs/restores listeners safely and includes a deterministic “flush microtasks” step.
- [x] Repeated “probe cache” harness (temp bin + count-file + TTL assertions) — **Observed:** `apps/cli/src/capabilities/probes/acpProbe.cache.test.ts`, `apps/cli/src/capabilities/probes/agentModelsProbe.cache.test.ts`, `apps/cli/src/capabilities/snapshots/cliSnapshot.cache.test.ts` all build temp dirs, write executable shims, mutate `PATH`, and assert “second call does not respawn” by appending to a count file. **Impact:** duplicated (and slightly divergent) tempdir/env restore patterns raise leak risk and make it harder to consistently harden for Windows/CI. **Next:** extract a shared `withTempExecutableOnPath({ name, script, env })` + `expectCachedWithinTtl({ fn, keyParams })` testkit (or move these tests into a single table-driven file) and ensure consistent cleanup + cross-platform path handling.
- [x] Repeated “capture interval tick” harness (setInterval spy + `globalThis.__tick`) — **Observed:** daemon heartbeat/lifecycle tests like `apps/cli/src/daemon/lifecycle/heartbeat.executionRunsGc.test.ts` and `apps/cli/src/daemon/lifecycle/heartbeat.processMissingDelegates.test.ts` intercept `setInterval` and stash the handler on `globalThis` to manually invoke one tick. **Impact:** brittle global coupling and easy cleanup leaks; tests over-pin scheduler wiring rather than behavior. **Next:** extract a small helper (`captureIntervalTick()`) and/or refactor lifecycle modules to expose a deterministic `runHeartbeatOnce()`/`tickOnce()` function for unit tests.
- [x] Repeated “sqlite tempdir + open/init/close” DB harness (memory tier1/deep) — **Observed:** many memory tests create per-test DB files via `mkdtemp` + `open*Db().init()` + `rm(dir)` (e.g. `apps/cli/src/daemon/memory/summaryShardIndexDb.test.ts`, `apps/cli/src/daemon/memory/deepIndex/deepIndexDb.test.ts`, `apps/cli/src/daemon/memory/syncDeepIndexForSessionsOnce.test.ts`). **Impact:** lots of boilerplate, inconsistent cleanup (`close()` sometimes missing), and unit-lane runtime cost grows as coverage expands. **Next:** centralize a `withTempSqliteDb`/`withMemoryDbs` harness (ensures `close()` + dir cleanup) and consolidate overlapping DB eviction/cascade assertions.
- [x] Repeated tmux spawn mocking + “last spawn call” capture blocks — **Observed:** `apps/cli/src/integrations/tmux/tmux.commandEnv.test.ts` and `apps/cli/src/integrations/tmux/tmux.socketPath.test.ts` both re-implement hoisted `spawnMock` + `lastSpawnCall` bookkeeping (even though they share `tmux.spawnMock.testkit.ts`). **Impact:** duplicated harness logic can drift and is easy to leak across tests; increases file count for very similar wiring assertions. **Next:** move spawn/call-capture into the shared testkit (single `installTmuxSpawnMock()` returning `{getLastCall, reset}`) and/or table-drive tmux spawn wiring assertions (env + socket + args) in one file.
- [x] Repeated “capture console output + manage process exit/exitCode” harnesses — **Observed:** many CLI command tests re-implement variants of (a) `console.log/error` capture arrays, (b) `process.exit` throwing spies, and/or (c) `process.exitCode` save/restore (e.g. `apps/cli/src/cli/commands/auth/status.json.test.ts`, `apps/cli/src/cli/commands/server.json.test.ts`, `apps/cli/src/cli/sessionStartArgs.test.ts`, `apps/cli/src/cli/dispatch.tmuxDisallowed.test.ts`). **Impact:** global-state leakage risk (especially if a test fails mid-restore), inconsistent assertions (copy-pinning vs schema validation), and boilerplate encourages patchwork growth. **Next:** extract a single CLI-testkit helper (`captureConsole()`, `captureJsonEnvelope()`, `withProcessExitTrap()`, `withExitCodeScope()`) and prefer schema/shape assertions over exact copy when possible.
- [x] Repeated “timeout wrapper” + “JSONL fixture builder” helpers across CLI backend tests — **Observed:** `withTimeout()` is duplicated between `apps/cli/src/backends/claude/sdk/query.signalCleanup.test.ts` and `apps/cli/src/backends/claude/sdk/query.stderrDrain.test.ts`, and appears again in `apps/cli/src/backends/kilo/utils/permissionHandler.test.ts` and `apps/cli/src/backends/opencode/utils/permissionHandler.test.ts`; `makeJsonl()` (and near-identical JSONL record fixtures) are duplicated across Claude sidechain tests (`apps/cli/src/backends/claude/remote/sidechains/*`). **Impact:** duplication increases drift (one helper gets “fixed” and the other doesn’t), increases boilerplate, and makes it easier to leak env/fs cleanup patterns. **Next:** extract a small shared testkit (e.g. `apps/cli/src/testkit/async.testkit.ts` providing `withTimeout()` + `waitFor()`, and targeted JSONL builders for sidechains) and enforce consistent cleanup (env restore, temp dir removal).
- [x] Near-identical provider backend permission + runtime wiring suites (Kilo vs OpenCode, plus similar Kimi runtime harness) — **Observed:** `apps/cli/src/backends/kilo/acp/backend.permissions.test.ts` and `apps/cli/src/backends/opencode/acp/backend.permissions.test.ts` are effectively the same contract; `apps/cli/src/backends/kilo/utils/permissionHandler.test.ts` and `apps/cli/src/backends/opencode/utils/permissionHandler.test.ts` are near-duplicates; runtime wiring tests/harnesses repeat the same `createCatalogAcpBackend` spy fixtures (`apps/cli/src/backends/kimi/acp/runtime.testkit.ts`, `apps/cli/src/backends/opencode/acp/runtime.testkit.ts`, plus Kilo runtime test inline harness). **Impact:** patchwork duplication increases maintenance and makes policy changes error-prone (must update multiple copies). **Next:** extract a single shared “ACP provider contract” harness that is parameterized by provider id + tool-name tables, and keep only provider-specific deltas in thin test files; centralize the spy-based runtime.testkit fixtures.
- [x] Duplicated “Codex MCP start config” + “provider event formatting for UI” tests across backends — **Observed:** `apps/cli/src/backends/codex/utils/buildCodexMcpStartConfig.test.ts` overlaps with `apps/cli/src/backends/codex/__tests__/buildCodexMcpStartConfigForMessage.test.ts`; copy/event formatting is pinned at multiple provider layers (e.g. `apps/cli/src/backends/codex/utils/formatCodexEventForUi.test.ts` and other `format*Error/EventForUi` tests). **Impact:** patchwork duplication increases churn (small schema/copy changes break multiple tests) and obscures where the canonical contract is. **Next:** pick one canonical tier for start-config shape tests (builder-level *or* message-level) and keep the other as a thin smoke check; extract shared helpers for “blank message fallback” and reduce exact-string pinning to true published copy contracts.
- [x] Duplicated “special command routing” coverage (`/clear` / isolate+clear) across multiple CLI runtime layers — **Observed:** `/clear` routing asserted in `apps/cli/src/agent/runtime/queueSpecialCommands.test.ts`, `apps/cli/src/agent/runtime/permission/bindPermissionModeQueue.test.ts`, and `apps/cli/src/agent/runtime/runPermissionModePromptLoop.test.ts`. **Impact:** low-value duplication + copy-pinned assertions (loop test checks “Session reset.” copy) increase maintenance; it’s easy for one layer’s test to become redundant or inconsistent. **Next:** keep `queueSpecialCommands` as the canonical unit contract for routing, and slim other tests to focus on their unique orchestration behavior (avoid asserting copy where possible).
- [x] Duplicate testing of `@happier-dev/agents` helpers inside app-level suites — **Observed:** CLI unit tests re-assert workspace-helper semantics that appear to belong to `packages/agents` (e.g. `apps/cli/src/agent/runtime/sessionControlsPublishShared.test.ts`, `apps/cli/src/agent/runtime/permissionModeForAgent.test.ts`, `apps/cli/src/agent/runtime/monotonicUpdatedAt.test.ts`). **Impact:** cross-suite drift risk (two suites must be kept in sync), and app tests become noisy/less focused on app behavior. **Next:** keep canonical helper tests in `packages/agents`; in app suites, prefer (a) small smoke “wiring uses helper” tests or (b) integration tests that validate the app behavior end-to-end without re-testing helper internals.
- [x] Duplicated “temp git repo fixture” harnesses in script/unit tests — **Observed:** `apps/stack/scripts/utils/git/{default_branch,dev_checkout,fast_forward_to_remote}.test.mjs` each re-implements bare repo init + clone + commit + branch/remote wiring; SwiftBar git cache tests also seed repos ad hoc. **Impact:** duplicated git setup is verbose and easy to drift (missing config, branch defaults, cleanup semantics), and increases flake risk in CI with parallel runs. **Next:** extract one small `withTempGitFixture(t, { bare?, branches?, remotes? })` helper (node:test-compatible) and standardize git user config + cleanup + command runner.
- [x] Duplicated “prepend PATH with stub binaries” pattern (fake `yarn`/`expo`/`gh`/`osascript`/`codex`/etc.) — **Observed:** multiple `apps/stack/scripts/**/*.test.mjs` (e.g. `command_workspace_deps_built.test.mjs`, `swiftbar_wt_pr_backcompat.test.mjs`, `utils/llm/tools.test.mjs`) write executable scripts into a temp `bin/` and patch `process.env.PATH`. **Impact:** repeated boilerplate + inconsistent restore/cleanup; windows/PATH-separator edge cases are easy to miss. **Next:** standardize a `withTempPathBin(t, { commands: {name: script} })` helper that handles chmod + platform separators + env restore.
- [x] Duplicated “localhost server + reserved port” harnesses for Expo/Metro probing — **Observed:** `apps/stack/scripts/utils/expo/{expo_state_running,metro_ports}.test.mjs` and several `expo_dev_*` tests each implement their own port reservation + `/status` responder servers. **Impact:** drift risk (slightly different status strings/timeouts) and flake risk (port binding + close timing) scattered across files. **Next:** centralize `reservePort()` + `withStatusServer({ text })` helpers and keep per-test assertions focused on behavior.
- [x] Duplicated “poll until condition” test loops (files/pids/ps sampling) — **Observed:** `apps/stack/scripts/utils/proc/{ownership_killProcessGroupOwnedByStack,ownership_listPidsWithEnvNeedles,terminate}.test.mjs` each hand-roll polling loops (`waitForCondition`, `waitForFile`, `waitForPidExit`) with slightly different timeouts/intervals; similar polling exists in Expo verbose-log and other process tests. **Impact:** inconsistent timeout semantics and increased flake risk under slow CI; hard to tune globally. **Next:** standardize on a single `waitFor({ predicate, timeoutMs, intervalMs, description })` helper per runner (node:test + Vitest), and reuse across suites.
- [x] Repeated “backend wrapper argv/wiring” tests across agent backends (Claude/Auggie/etc.) — **Observed:** tests that cast into internal backend options and assert raw argv/rule strings (e.g. `apps/cli/src/backends/auggie/acp/backend.permissions.test.ts`, `apps/cli/src/backends/claude/claudeLocal.test.ts`, plus CLI command wiring tests). **Impact:** high churn risk on refactors that preserve behavior but change args composition; increases patchwork feel across suites. **Next:** extract a shared “backend launch plan” adapter that returns a structured plan (`{ executable, args, env }`) and test that, keeping only a small number of smoke tests that assert the wrapper calls the plan.
- [x] Repeated ad-hoc “temp dir + write fixture files + exec node script” harnesses — **Observed:** `apps/ui/sources/tools/tauri/make-latest-json.test.ts` and other tooling/scan tests using custom tmpdir + fs helpers. **Impact:** duplicated cleanup patterns and slightly divergent helpers increase leak/flake risk (tmp dirs not removed on crash) and make infra tests harder to read. **Next:** extract a small shared `withTempDir` + `writeFile` test helper (per suite) and prefer promise-based APIs where possible; keep these infra tests in a dedicated tooling lane if they grow.
- [x] Duplicated Vitest lane config boilerplate across `packages/tests` suites — **Observed:** `packages/tests/vitest.core*.config.ts`, `packages/tests/vitest.providers.config.ts`, `packages/tests/vitest.stress.config.ts` repeat the same `environment:'node'`, long timeouts, `globals:false`, `env:{HAPPIER_FEATURE_POLICY_ENV:''}`, and `exclude:[...resolveVitestFeatureTestExcludeGlobs()]` patterns with only minor include/exclude differences. **Impact:** drift risk (feature gating / defaults can diverge silently) and makes “is this test wired?” harder to reason about. **Next:** extract a small shared `defineHappierVitestConfig({ include, excludeExtra, timeouts, pool, fileParallelism })` helper so each lane declares only what’s unique.
- [x] Repeated `process.env` save/restore boilerplate in tests — **Observed:** multiple provider-contract e2e-ish tests manually snapshot a list of env vars, mutate them, and restore in `finally` (e.g. `packages/tests/suites/providers/harness.inFlightSteer.*.e2e.test.ts`, `packages/tests/suites/providers/harness.tokenTelemetry.acpStub.e2e.test.ts`), plus similar patterns across other suites. **Impact:** easy to miss variables (leaks between tests), verbose setup obscures intent, and makes it harder to safely add new env-gated behavior. **Next:** standardize on a tiny helper like `withEnvOverrides({ KEY:'1' }, fn)` (supports delete/restore) and encourage per-suite “known env var set” constants.
- [x] Repeated provider-spec loading + traversal boilerplate — **Observed:** many `packages/tests/suites/providers/providerSpecs.*.test.ts` files call `loadProvidersFromCliSpecs()` per test and re-implement `providers.find(...)` + tier extraction and long `not.toContain(...)` exclusion lists. **Impact:** slower suite + brittle churn when scenario catalogs or provider policies change; logic is duplicated rather than table-driven. **Next:** add a tiny “load once” helper + shared assertion utilities (e.g. `expectProviderScenariosExcluded(providerId, tier, ids[])`) and keep per-provider policy in one table.
- [x] Inline “fake ACP JSON-RPC agent script” + subprocess harness duplication — **Observed:** repeated across many `apps/cli/src/agent/acp/**/__tests__/*.test.ts` files (e.g. `AcpBackend.authenticate.test.ts`, `AcpBackend.configOptions.test.ts`, `AcpBackend.sessionModes.test.ts`, `AcpBackend.sessionModels.test.ts`, `AcpBackend.waitForResponseComplete.test.ts`, `AcpBackend.toolCallUpdate.*.test.ts`, `AcpBackend.permissionSeed.*.test.ts`). **Impact:** copy/pasted JSON parsing + tempdir lifecycle + polling/timeouts increases drift and flake risk; makes it harder to add new provider-compat cases consistently; can inflate unit-lane runtime. **Next:** extract a shared ACP testkit/harness (single place for spawn + cleanup + default timeouts + wait helpers) and parameterize fake agent behavior (prompt → updates, permission request flows, stderr/stdout injection, exit/signal behaviors).
- [x] Repeated “export exists” smoke tests via `(module as unknown as { fn?: unknown }).fn` — **Observed:** `packages/protocol/src/bugReports.fallback.test.ts`, `packages/protocol/src/bugReports.reporter.test.ts`, `apps/ui/sources/sync/http/client.runtimeFetch.test.ts` (similar “method exists” check). **Impact:** these tests mostly validate export presence/typing rather than behavior; they’re brittle to refactors (rename/re-export) and can mask dead code (export exists but behavior wrong). **Next:** replace with direct imports + behavior assertions where possible; if the goal is “public API surface must include X”, consolidate into a single table-driven “exports surface” test per package (or rely on TS + exports map tests) instead of scattering one-off existence checks.
- [x] Call-forwarding/wiring tests with huge dependency mocks — **Observed:** protocol action executor tests with `createDeps()` (`packages/protocol/src/actions/actionExecutor.*.test.ts`) and many UI unit tests that mock deep internal modules to verify a screen calls a hook/handler with specific props (`apps/ui/sources/__tests__/app/**`). **Impact:** high maintenance, low signal (tests wiring + identity instead of outcomes), and encourages “patchwork” mocking patterns. **Next:** (1) extract a shared typed `ActionExecutorDeps` test builder (or table-driven matrices) to cut duplication; (2) for UI, prefer testing pure request-builders/state reducers directly and keep screen tests focused on user-observable outcomes (navigation/events) with minimal internal mocks; (3) consider moving orchestration-heavy/wiring-with-mocks tests to a distinct lane if they remain.
- [x] Repeated global `IS_REACT_ACT_ENVIRONMENT` toggles + no unified cleanup — **Observed:** many UI unit/integration tests set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` (sometimes via helpers like `enableReactActEnvironment()`) without a consistent restore/reset strategy, alongside repeated `react-test-renderer` + `act` scaffolding. **Impact:** increases cross-test coupling/leak risk (especially with `vi.resetModules()` usage) and makes the “fast lane” harder to reason about. **Next:** standardize via one Vitest setup helper that (a) sets it once per worker, (b) documents why, and (c) ensures global state cleanup remains deterministic (pair with `vi.unstubAllGlobals()` / `vi.restoreAllMocks()` and explicit module resets only where needed).
- [x] Repeated “mock storage.getState via vi.mock + mutable state object” harnesses — **Observed:** many UI unit specs (notably voice) rely on `vi.mock('@/sync/domains/state/storage', () => ({ storage: { getState: () => state } }))` plus manual resets/mutation (e.g. `apps/ui/sources/voice/agent/VoiceAgentSessionController.*.spec.ts`, `apps/ui/sources/voice/adapters/*.spec.ts`, `apps/ui/sources/voice/agent/teleportVoiceAgentToSessionRoot.test.ts`). **Impact:** brittle coupling to store shape, encourages internal mocking over real behavior, and increases drift risk (tests manually maintain large partial state objects). **Next:** prefer using the real `storage` store with `storage.setState` seed helpers (pattern already used in `apps/ui/sources/voice/context/voiceHooks.privacy.spec.ts`) and/or extract a typed `seedStorageState()` helper per suite to standardize resets and reduce patchwork.
- [x] Repeated ad-hoc “microtask polling” loops for async waits — **Observed:** multiple voice/local engine specs wait for side effects with `for (...) await Promise.resolve()` loops (e.g. `apps/ui/sources/voice/local/localVoiceEngine.agent.spec.ts`, `apps/ui/sources/voice/local/localVoiceEngine.tts.spec.ts`). **Impact:** unpredictable runtime under load and higher flake risk; tests can become “slow/patchwork” as more waits are added. **Next:** standardize on a small `waitFor(condition, { timeoutMs, tick })` helper (or event-driven harness hooks) so waits are bounded, readable, and consistent across the suite.
- [x] Near-identical “dynamic probe cache” implementations (models vs session modes) — **Observed:** `apps/ui/sources/sync/domains/models/dynamicModelProbeCache.ts` and `apps/ui/sources/sync/domains/sessionModes/dynamicSessionModeProbeCache.ts` share ~the same persistence/hydration/pruning/dedupe logic (only value shape + key/id strings differ). **Impact:** fixes/features (TTL rules, persistence limits, corruption handling) must be duplicated; drift risk is high and tests must cover both. **Next:** extract a generic `createDynamicProbeCache<T>({ persistKey, storageId, normalize, cacheErrorMessage })` or unify into one module with typed adapters; keep thin wrappers per domain.
- [x] Repeated “constrained content width” (pins `layout.maxWidth` container styles) across UI screens — **Observed:** `apps/ui/sources/app/(app)/runs.test.tsx`, `apps/ui/sources/app/(app)/session/[id]/runs.test.tsx`, `apps/ui/sources/app/(app)/session/[id]/runs/[runId].test.tsx`, `apps/ui/sources/app/(app)/session/[id]/runs/new.test.tsx`, `apps/ui/sources/app/(app)/session/[id]/files.test.tsx` (and more). **Impact:** low behavior signal (asserts layout implementation detail) + churn risk if layout implementation changes (style refactor, container component swap). **Next:** either (a) centralize as 1–2 smoke tests for “screens use SharedConstrainedContainer” or (b) assert via a shared “constrained container” component presence, not raw style shape; avoid repeating per-screen style pins unless a specific regression occurred.
- [x] Repeated react-test-renderer traversal + “flush effects” helpers — **Observed:** many UI screen/component tests define local `flushRender()` (`await Promise.resolve()` loops / `setTimeout(0)`) and local `findPressableByText`/`findPressableByLabel` tree-walkers (e.g. `apps/ui/sources/components/automations/screens/*.test.tsx`, plus multiple `apps/ui/sources/__tests__/app/**`). **Impact:** duplicated + slightly divergent helpers increase brittleness and make tests hard to read; tree-walking via parent links is sensitive to refactors. **Next:** extract a single small UI testkit (react-test-renderer utilities + stable finders) and prefer asserting on stable accessibility labels/testIDs rather than copy when possible.
- [x] Repeated “daemon unavailable” alert + Retry + unmount-safe retry tests — **Observed:** `apps/ui/sources/hooks/ui/useHappyAction.daemonUnavailable.test.tsx`, `apps/ui/sources/hooks/session/files/executeScmCommit.daemonUnavailable.test.ts`, `apps/ui/sources/hooks/session/files/useFileScmStageActions.daemonUnavailable.test.ts`, `apps/ui/sources/hooks/session/files/useFilesScmOperations.daemonUnavailable.test.ts`, plus earlier session/editor/spawn daemon-unavailable specs. **Impact:** duplicated “find Retry button by text key + press after unmount does not retry” scaffolding and multiple ad-hoc classifications can drift. **Next:** centralize (1) RPC/SCM error→daemon-unavailable classification, (2) a single `showDaemonUnavailableAlert({ detail, onRetry, shouldContinue })` helper, and (3) a table-driven test matrix to cover classification + mount-safety once.
- [x] Perf-heavy “large payload” fixtures in unit lanes — **Observed:** UI unit tests generating multi-megabyte strings / tens-of-thousands-of-lines text to exercise chunking or “no negative stats” edges (e.g. `apps/ui/sources/components/ui/code/editor/bridge/chunkedBridge.test.ts` uses ~2.5MB strings; `apps/ui/sources/components/ui/code/model/diff/diffViewModel.test.ts` builds 15k/16k-line texts). **Impact:** slows the fast lane, increases memory/GC pressure, and can introduce time-sensitive flake under load. **Next:** centralize reusable big fixtures (generated once), shrink payload sizes while still crossing thresholds (lower `maxChunkBytes` / targeted stat clamp unit tests), and consider a dedicated perf/regression lane for “big input” tests if they remain necessary.
- [x] Multi-megabyte base64 roundtrip tests in fast lane — **Observed:** `apps/ui/sources/encryption/base64.test.ts` allocates 5,000,000 bytes (base64) and 3,000,000 bytes (base64url) and validates via checksum. **Impact:** very expensive CPU/memory in unit lane; risks timeouts on busy CI runners. **Next:** reduce payload sizes while still exercising “large payload” code paths (or move to a perf/regression lane), and reuse a shared deterministic-bytes fixture generator across crypto tests.
- [x] Duplicated web safety checks for “raw string under `<View>`” + disabled cursor policy — **Observed:** multiple list/menu tests assert that primitive string children (e.g. `"."`) are wrapped under `Text` (not rendered as raw string children of a `View`) in both `apps/ui/sources/components/ui/lists/ActionListSection.test.tsx` and `apps/ui/sources/components/ui/lists/Item.subtitleNormalization.test.tsx`; disabled cursor (`cursor:'not-allowed'`) is asserted in both `apps/ui/sources/components/ui/lists/SelectableRow.cursor.spec.tsx` and `apps/ui/sources/components/ui/lists/Item.subtitleNormalization.test.tsx`. **Impact:** duplicated tree-walk/style-resolution assertions and patchwork UX contracts scattered across components. **Next:** extract shared helpers for (a) “web-safe text children” normalization and (b) disabled cursor style policy, test them once, and keep only minimal per-component smoke tests.
- [x] Tool renderer tests duplicate “truncation/list summary” contracts + copy pinning — **Observed:** `apps/ui/sources/components/tools/renderers/fileOps/{GlobView,LSView,GrepView,DeleteView,CodeSearchView,WebSearchView}.test.tsx` and `apps/ui/sources/components/tools/renderers/{system/BashView,workflow/ReasoningView,web/WebFetchView}.test.tsx` repeatedly assert `+N more`/ellipsis truncation and detailLevel expansion using host-text concatenation alongside repeated `ToolSectionView` passthrough mocks. **Impact:** duplication + churn risk (changing thresholds/copy requires editing many files) and tests skew toward formatting rather than stable semantics. **Next:** centralize truncation/list-summary behavior in a shared component/hook with one table-driven contract test; keep only a small number of per-view smoke tests for unique formatting.
- [x] Tool timeline row tests share massive “mock the world” scaffolding — **Observed:** `apps/ui/sources/components/tools/shell/views/ToolTimelineRow.*.test.tsx` (e.g. `minimalFallback`, `tapAction`, plus upcoming `unknownCollapse`, `titleFallback`) each mock RN primitives/Animated, unistyles theme, router, catalog/registry, normalization/inference, error parsing, Text wrappers, and settings state to assert one small conditional behavior. **Impact:** high maintenance + patchwork risk; tests are mostly validating mocked composition rather than real user-observable outcomes; makes it easy for mocks to drift and hide regressions. **Next:** extract pure policy helpers for (a) tap action resolution, (b) expand/collapse defaults, (c) minimal/unknown tool rendering rules, and add a shared harness for the few integration assertions that still matter (navigation + stable testIDs).
- [x] Repeated “AgentInput” mega-mock boilerplate across many small UI tests — **Observed:** `apps/ui/sources/components/sessions/agentInput/AgentInput.*.test.tsx` repeatedly mock `react-native` (via `reactNativeStub`), storage settings, agent catalog, model/perms helpers, autocomplete hooks, and many UI shell components to assert a single small UI contract (icons/testIDs/accessibility). **Impact:** high maintenance + patchwork risk (small changes to AgentInput wiring force edits across many files); also makes it easy to accidentally test stubbed behavior rather than real UI logic. **Next:** create a shared AgentInput test harness (central mocks + minimal knobs) and prefer moving pure logic to helper modules with pure tests (keep only a small number of high-signal component tests for testIDs/a11y/interaction contracts).
- [x] Repeated deterministic RNG helpers in crypto tests — **Observed:** `deterministicRandomBytesFactory()` duplicated in `packages/protocol/src/crypto/accountScopedCipher.test.ts`, `boxBundle.test.ts`, `encryptedDataKeyEnvelopeV1.test.ts`, `terminalProvisioningV2.test.ts`. **Impact:** trivial duplication but repeated “randomBytes override” plumbing hides what each test actually cares about and invites slight divergence. **Next:** introduce a single shared `testDeterministicRandomBytes()` helper (or a `makeDeterministicRandomBytes(seed?)`) local to crypto tests; keep per-test overrides explicit (don’t broaden to production code).
- [x] Repeated “pin exported string constants” tests — **Observed:** `packages/protocol/src/rpc.*.test.ts` assert exact method string ids (`RPC_METHODS`, `SESSION_RPC_METHODS`) and similar constant pinning appears elsewhere. **Impact:** can be high-signal when these strings are wire contracts, but duplication across many files creates churn/patchwork (every new method requires updating multiple tests). **Next:** consolidate into 1–2 table-driven contract tests per surface (daemon vs session) that validate uniqueness + expected prefixes + a curated list of “must not change” ids; avoid scattering constant pins per topic unless there’s a compatibility reason.

- [x] Duplicate diff/image “synthesis” behaviors tested at multiple layers — **Observed:** (1) “empty SCM diff for untracked/added file ⇒ synth unified diff from file content” is tested both in hook land (`apps/ui/sources/components/sessions/files/content/review/useChangedFilesReviewDiffLoading.fallbackDiff.test.tsx`) and helper land (`apps/ui/sources/components/sessions/files/views/sessionFileDetails/refreshSessionFileDetails.fallbackDiff.test.ts`); (2) “binary placeholder diff ⇒ treat as non-renderable and/or load image preview from base64” is spread across `useChangedFilesReviewDiffLoading.binaryPlaceholders.test.tsx`, `useChangedFilesReviewImagePreview.test.tsx`, and `refreshSessionFileDetails.imagePreview.test.ts`. **Impact:** drift risk + patchwork (behavior changes require updating multiple tests, and they can disagree about canonical behavior). **Next:** pick the canonical layer for each behavior (or extract one shared pure helper) and keep other-layer tests minimal “wiring/smoke” assertions.

- [x] Duplicate attachments-upload wiring tests across containers — **Observed:** AgentInput wiring/gating is tested repeatedly under large screen-level mocks: `apps/ui/sources/components/sessions/new/components/NewSessionSimplePanel.attachments.feat.attachments.uploads.test.tsx`, `apps/ui/sources/components/sessions/new/components/NewSessionWizard.attachments.feat.attachments.uploads.test.tsx`, `apps/ui/sources/components/sessions/shell/SessionView.attachmentsGating.test.tsx` (and related send-flow coverage in `apps/ui/sources/components/sessions/shell/SessionView.sendAttachmentsResumable.feat.attachments.uploads.test.tsx`). **Impact:** patchwork + churn risk (internal prop wiring assertions across multiple containers) with limited end-to-end confidence. **Next:** centralize “attachments enabled → handlers/chips/message meta” into one shared helper with focused unit tests, keep only 1–2 UI wiring smoke tests, and cover the full happy path via integration/e2e.

- [x] Repeated “dynamic preflight probe” tests across models and session modes — **Observed:** `apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState.{cache,cwd,persistence,refresh}.test.tsx` and `apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState.{cache,cwd,loadingPlaceholder,persistence,refresh}.test.tsx` share near-identical harnesses (reset cache, mount hook, flush `setTimeout(0)`, assert request shape/options/caching). **Impact:** patchwork + churn risk (timeout/id changes require editing many files; persistence semantics tested via module reload are easy to flake). **Next:** consolidate into one table-driven probe test suite per probe type (models vs modes) using a shared helper for mount/flush/reset, and consider whether “persistence across app restart” belongs in a slower lane or can be validated with a smaller unit around the persistence adapter.

- [x] Repeated “keep mounted tabs” policy tests across pane layers — **Observed:** `apps/ui/sources/components/sessions/panes/SessionDetailsPanel.keepMountedTabs.test.tsx`, `apps/ui/sources/components/sessions/panes/SessionRightPanel.keepMountedTabs.test.tsx`, `apps/ui/sources/components/sessions/panes/git/SessionRightPanelGitView.keepMountedSubTabs.test.tsx` (and similar “keep mounted” assertions elsewhere). **Impact:** redundant + brittle (locks in an implementation strategy; fails on perf refactors like unmounting inactive tabs). **Next:** if “keep mounted” is a deliberate invariant, centralize it in a shared tab container and test once; otherwise, trim these to only the few cases that guard known regressions (e.g., web scroll state loss).

- [x] Duplicate SCM status “counts” tested across multiple UI components — **Observed:** `apps/ui/sources/components/sessions/sourceControl/status/CompactSourceControlStatus.test.tsx`, `apps/ui/sources/components/sessions/sourceControl/status/ProjectSourceControlStatus.test.tsx`, `apps/ui/sources/components/sessions/sourceControl/status/SourceControlStatusBadge.test.tsx` all mock `useSessionProjectScmSnapshot` and assert rendered labels for file/line counts, while the canonical computation is separately tested in `apps/ui/sources/components/sessions/sourceControl/status/statusSummary.test.ts`. **Impact:** patchwork + churn risk (UI copy changes require editing multiple tests; duplicated fixtures and snapshot shapes). **Next:** treat `buildScmStatusSummaryFromSnapshot` as canonical, keep it heavily unit-tested, and reduce component tests to 1–2 smoke assertions per component (or share a single table-driven snapshot→label expectation helper).

- [x] ChatList transcript behavior tested across many near-identical harnesses — **Observed:** `apps/ui/sources/components/sessions/transcript/ChatList.autoFollowWhenPinned.test.tsx`, `ChatList.initialScrollBehavior.test.tsx`, `ChatList.jumpToBottom.test.tsx`, `ChatList.turnGroupingMode.test.tsx` all re-define a similar “mock storage selectors + seed settings + stub FlatList + flush microtasks” scaffolding and then assert internal callbacks/props. **Impact:** patchwork + churn risk (changing a setting key or pin controller semantics requires editing multiple files; higher chance of subtle mock drift). **Next:** extract a shared `renderChatListHarness({ settings, sessionState, messages, pending, drafts })` and table-drive scenarios; keep only a few high-signal regressions (e.g. null-session crash, web wheel stopPropagation, jump-to-bottom testID contract).

- [x] SettingsView tests repeat extremely large UI-screen mock scaffolds — **Observed:** `apps/ui/sources/components/settings/SettingsView.addYourPhone.web.test.tsx`, `SettingsView.runsEntry.test.tsx`, `SettingsView.serversEntry.test.tsx`, and `SettingsView.multiServerMachines.test.tsx` each mock dozens of SettingsView dependencies (router, ItemList/ItemGroup/Item, auth/storage/sync, theme) with slightly different stubs. **Impact:** patchwork + churn risk (refactors require updating many mocks; tests may validate stubs rather than user behavior) and slower unit lane from large module-mock surfaces. **Next:** extract a single `renderSettingsViewHarness({ featureEnabled, env, storageSeed, serverProfilesSeed })` helper and table-drive entry/route assertions; keep multi-server storage-scoping coverage as a focused “store + profiles” unit test where possible.

- [x] Connected services quota snapshot sealing boilerplate repeated across multiple UI tests — **Observed:** `apps/ui/sources/components/settings/connectedServices/ConnectedServiceDetailView.quotas.test.tsx`, `apps/ui/sources/components/settings/connectedServices/ConnectedServiceQuotaCard.test.tsx`, `apps/ui/sources/components/settings/connectedServices/ConnectedServicesSettingsView.quotas.test.tsx` all construct similar `ConnectedServiceQuotaSnapshotV1` payloads and seal them via `sealAccountScopedBlobCiphertext` with hard-coded random bytes. **Impact:** duplication + drift risk (schema/key changes require updating multiple test files) and increases cognitive load in otherwise UI-focused specs. **Next:** extract a shared test helper `buildSealedConnectedServiceQuotaSnapshot({ serviceId, profileId, meters, fetchedAt, staleAfterMs })` and keep UI tests focused on mapping snapshot→badges/pins rather than crypto ceremony.
- [x] Repeated `ScmWorkingSnapshot`/SCM snapshot fixtures across UI SCM tests — **Observed:** many SCM unit tests inline large `ScmWorkingSnapshot`/protocol snapshot objects (`apps/ui/sources/scm/scmRepositoryService.test.ts`, `apps/ui/sources/scm/scmStatusFiles.test.ts`, `apps/ui/sources/scm/registry/scmUiBackendRegistry.test.ts`, etc.). **Impact:** drift risk when SCM snapshot shape/capabilities evolve (tests pin large objects), and duplicates “canonical snapshot” construction logic. **Next:** extract a typed `makeScmWorkingSnapshot(overrides)` + `makeProtocolScmSnapshot(overrides)` in a single SCM testkit file (or `satisfies` builders) and have tests assert only relevant subsets.
- [x] Repeated “API client test harness” patterns (server snapshot + immediate backoff + fetch stub) — **Observed:** `apps/ui/sources/sync/api/account/apiConnectedServicesQuotasV2.test.ts` and `apps/ui/sources/sync/api/account/apiConnectedServicesV2.test.ts` both `doMock` `getActiveServerSnapshot`, mock `backoff/backoffForever` to immediate, and stub `globalThis.fetch`, plus repeat credentials fixtures + module reset in `afterEach`. **Impact:** duplicated harness logic and cleanup increases flake risk (module cache/global leaks) and slows iteration when adding more API client tests. **Next:** introduce a shared Vitest helper (e.g. `installApiClientTestHarness({ serverUrl })`) that sets server snapshot, stubs backoff, installs/restores fetch, and provides a typed `jsonFetchResponse(...)`.
- [x] Repeated “settings defaults policing” across settings-domain tests — **Observed:** `apps/ui/sources/sync/domains/settings/settings.spec.ts`, `apps/ui/sources/sync/domains/settings/settings.providerPlugins.test.ts`, `apps/ui/sources/sync/domains/settings/localSettings.test.ts`, `apps/ui/sources/sync/domains/settings/voiceSettings.spec.ts` all pin large surfaces of default values (some duplicated across files). **Impact:** churny/brittle tests that block harmless UX/config tuning; encourages patchwork (adding new default assertions in “whatever file touched”) and increases unit-lane runtime. **Next:** consolidate default assertions into 1–2 high-signal “defaults shape + invariants” tests, and keep the rest focused on migrations/validation/compat (table-driven where possible). Treat exact IDs/assets/voice ids as contract only when truly required.
- [x] Repeated “trailing JSON after preamble” parsers + near-identical tests across execution-run profiles — **Observed:** `apps/cli/src/agent/executionRuns/profiles/delegate/DelegateProfile.test.ts`, `apps/cli/src/agent/executionRuns/profiles/plan/PlanProfile.test.ts`, `apps/cli/src/agent/executionRuns/profiles/review/ReviewProfile.test.ts` all re-test “model output may have preamble text; parse trailing strict JSON; fail deterministically on non-JSON” with highly similar `start` fixtures. **Impact:** duplicated coverage increases maintenance and encourages drift (small behavior changes require edits in multiple files). **Next:** extract a shared `parseTrailingStrictJson()` helper + a table-driven shared test that all profiles can reuse, and keep per-profile tests focused on schema-specific fields (e.g., plan sections, review CodeRabbit parsing, delegate deliverables).
- [x] Divergent MMKV stubbing strategies (global vs per-file) — **Observed:** global mocks in `apps/ui/sources/dev/vitestSetup.ts` alongside per-file `vi.mock('react-native-mmkv', ...)` in `apps/ui/sources/sync/domains/state/persistence.test.ts` (and other storage tests). **Impact:** inconsistent stub behavior + cleanup patterns can mask bugs or cause subtle cross-test drift/leaks. **Next:** standardize on a single MMKV test adapter/harness (shared in UI testkit) and ensure tests either (a) use injected storage instances or (b) use a consistent global mock with explicit reset hooks.
- [x] Push token registration tests + harness duplicated across syncAccount engine tests — **Observed:** `apps/ui/sources/sync/engine/account/syncAccount.pushTokenLogging.test.ts` and `apps/ui/sources/sync/engine/account/syncAccount.pushTokenMultiServer.test.ts` both set up similar mocks for Expo notifications/constants/platform, stub network, and assert “never log raw push token”. **Impact:** duplicated setup + overlapping intent makes changes to registration behavior/log wording expensive and increases risk of inconsistent coverage/cleanup. **Next:** extract a shared `arrangePushTokenRegistrationHarness({ profiles, active, failures })` helper and keep one integration-style “multi-server request fanout” test plus a small number of pure-unit tests for selection/fallback/log redaction.
- [x] Near-identical “key becomes available later” encryption lifecycle tests — **Observed:** `apps/ui/sources/sync/encryption/encryption.initializeMachines.keyUpdate.test.ts` and `apps/ui/sources/sync/encryption/encryption.initializeSessions.keyUpdate.test.ts`. **Impact:** duplication encourages drift when encryption lifecycle semantics change. **Next:** table-drive the shared behavior with a parameter (`initializeMachines` vs `initializeSessions`, getter name) and keep per-surface tests minimal.
- [x] Repeated socket update “base params” harness + broad dependency injection — **Observed:** `apps/ui/sources/sync/engine/socket/socket.automationUpdates.test.ts`, `socket.cursorIsolation.test.ts`, `socket.newMachineUpdates.test.ts` each re-creates a large `buildBaseParams(...)` object for `handleUpdateContainer`. **Impact:** patchwork harness drift risk and low-signal wiring assertions (many injected fns never used by a given test). **Next:** extract a single typed `createSocketUpdateHarness({ overrides })` helper that centralizes defaults + cleanup, and keep tests focused on specific invalidations/state changes.
- [x] Repeated “server-scoped routing” tests (active socket vs scoped runtimeFetch/ephemeral) — **Observed:** `apps/ui/sources/sync/ops/__tests__/sessionArchive.serverScope.test.ts`, `sessionDelete.serverScope.test.ts`, `sessionStop.serverScope.test.ts`, plus many server-scoped machine/session ops routing tests (`apps/ui/sources/sync/ops/machineExecutionRuns.test.ts`, `apps/ui/sources/sync/ops/machines.*.test.ts`, `apps/ui/sources/sync/ops/sessions.serverScoped.test.ts`). **Impact:** lots of call-forwarding assertions + repeated `resolveServerScoped*Context`/`makeResponse` boilerplate; higher drift risk when server-scoped transport changes. **Next:** (1) extract a single typed “serverScoped op harness” for unit tests (context resolver stub + active vs scoped request executor), (2) table-drive endpoint/method matrices, (3) keep a small number of behavior-level tests asserting fallback semantics (METHOD_NOT_AVAILABLE → event fallback) instead of repeating call shapes everywhere.
- [x] Overlapping reducer/AgentState permission scenario tests spread across multiple files — **Observed:** `apps/ui/sources/sync/reducer/reducer.spec.ts` (very large matrix), `apps/ui/sources/sync/reducer/phase0-skipping.spec.ts`, and smaller focused tests like `apps/ui/sources/sync/reducer/permissionPlaceholder.toolResultOverride.test.ts` and `apps/ui/sources/sync/reducer/helpers/thinkingText.test.ts`. **Impact:** duplicated scenarios + repeated inline fixtures makes refactors risky, increases runtime/maintenance, and creates “patchwork” coverage (same intent asserted in different places with slightly different expectations). **Next:** split the monolith into focused files per concern (localId dedupe, streaming merge, tool lifecycle, permission matching), extract typed fixture builders (`makeNormalizedMessage`, `makeAgentStateRequest`, `makeToolCall`, `makeToolResult`), and keep only a small number of end-to-end race scenario tests.


## Global entrypoints

- `yarn test` → `yarn -s test:unit`
- `yarn test:db-contract:docker` → `yarn -s test:db-contract:postgres:docker && yarn -s test:db-contract:mysql:docker`
- `yarn test:db-contract:mysql:docker` → `node packages/tests/scripts/run-extended-db-docker.mjs --db mysql --mode contract`
- `yarn test:db-contract:postgres:docker` → `node packages/tests/scripts/run-extended-db-docker.mjs --db postgres --mode contract`
- `yarn test:e2e` → `yarn workspace @happier-dev/tests test`
- `yarn test:e2e:core` → `yarn -s test:e2e`
- `yarn test:e2e:core:all-db` → `yarn -s test:e2e:core:pglite && yarn -s test:e2e:core:sqlite && yarn -s test:e2e:core:postgres:docker && yarn -s test:e2e:core:mysql:docker`
- `yarn test:e2e:core:docker` → `yarn -s test:e2e:core:postgres:docker && yarn -s test:e2e:core:mysql:docker`
- `yarn test:e2e:core:embedded` → `yarn -s test:e2e:core:pglite && yarn -s test:e2e:core:sqlite`
- `yarn test:e2e:core:fast` → `yarn workspace @happier-dev/tests test:core:fast`
- `yarn test:e2e:core:mysql:docker` → `node packages/tests/scripts/run-extended-db-docker.mjs --db mysql --mode e2e`
- `yarn test:e2e:core:pglite` → `HAPPIER_E2E_DB_PROVIDER=pglite yarn -s test:e2e`
- `yarn test:e2e:core:postgres:docker` → `node packages/tests/scripts/run-extended-db-docker.mjs --db postgres --mode e2e`
- `yarn test:e2e:core:slow` → `yarn workspace @happier-dev/tests test:core:slow`
- `yarn test:e2e:core:sqlite` → `HAPPIER_E2E_DB_PROVIDER=sqlite yarn -s test:e2e`
- `yarn test:e2e:mysql:docker` → `yarn -s test:e2e:core:mysql:docker`
- `yarn test:e2e:postgres:docker` → `yarn -s test:e2e:core:postgres:docker`
- `yarn test:e2e:ui` → `yarn workspace @happier-dev/tests test:ui:e2e`
- `yarn test:extended-db:docker` → `yarn -s test:extended-db:postgres:docker && yarn -s test:extended-db:mysql:docker`
- `yarn test:extended-db:mysql:docker` → `node packages/tests/scripts/run-extended-db-docker.mjs --db mysql --mode extended`
- `yarn test:extended-db:postgres:docker` → `node packages/tests/scripts/run-extended-db-docker.mjs --db postgres --mode extended`
- `yarn test:integration` → `yarn workspace @happier-dev/app test:integration && yarn workspace @happier-dev/cli test:integration && yarn --cwd apps/server test:integration && yarn --cwd apps/stack test:integration`
- `yarn test:providers` → `yarn workspace @happier-dev/tests test:providers`
- `yarn test:providers:all:smoke` → `yarn workspace @happier-dev/tests providers:all:smoke`
- `yarn test:providers:claude:extended` → `yarn workspace @happier-dev/tests providers:claude:extended`
- `yarn test:providers:claude:smoke` → `yarn workspace @happier-dev/tests providers:claude:smoke`
- `yarn test:providers:opencode:extended` → `yarn workspace @happier-dev/tests providers:opencode:extended`
- `yarn test:providers:opencode:smoke` → `yarn workspace @happier-dev/tests providers:opencode:smoke`
- `yarn test:providers:pi:extended` → `yarn workspace @happier-dev/tests providers:pi:extended`
- `yarn test:providers:pi:smoke` → `yarn workspace @happier-dev/tests providers:pi:smoke`
- `yarn test:release:contracts` → `HAPPIER_FEATURE_POLICY_ENV= node --test scripts/release/*.test.mjs scripts/release/*/*.test.mjs`
- `yarn test:server:db-contract:docker` → `yarn -s test:db-contract:docker`
- `yarn test:server:db-contract:mysql:docker` → `yarn -s test:db-contract:mysql:docker`
- `yarn test:server:db-contract:postgres:docker` → `yarn -s test:db-contract:postgres:docker`
- `yarn test:stress` → `yarn workspace @happier-dev/tests test:stress`
- `yarn test:unit` → `yarn workspace @happier-dev/protocol test && yarn workspace @happier-dev/agents test && yarn workspace @happier-dev/app test && yarn workspace @happier-dev/cli test:unit && yarn --cwd apps/server test:unit && yarn --cwd packages/relay-server test && yarn --cwd apps/stack test:unit`

### Package-level test scripts

- `apps/ui/package.json` (name=`@happier-dev/app`)
  - `test`: `yarn -s test:unit`
  - `test:integration`: `vitest run --config vitest.integration.config.ts`
  - `test:unit`: `vitest run --config vitest.config.ts`
  - `test:watch`: `vitest`
- `apps/cli/package.json` (name=`@happier-dev/cli`)
  - `test`: `$npm_execpath run test:unit`
  - `test:integration`: `$npm_execpath run build && vitest run --config vitest.integration.config.ts`
  - `test:slow`: `vitest run --config vitest.slow.config.ts`
  - `test:unit`: `$npm_execpath run build && vitest run --config vitest.config.ts`
- `apps/server/package.json` (name=`@happier-dev/server`)
  - `test`: `yarn -s test:unit`
  - `test:db-contract`: `vitest run --isolate -c vitest.dbcontract.config.ts`
  - `test:integration`: `vitest run --isolate -c vitest.integration.config.ts`
  - `test:server:db-contract`: `yarn -s test:db-contract`
  - `test:unit`: `vitest run --isolate -c vitest.config.ts`
- `apps/stack/package.json` (name=`@happier-dev/stack`)
  - `test`: `yarn -s test:unit`
  - `test:ci`: `yarn -s test:unit`
  - `test:integration`: `node ./scripts/test_integration.mjs`
  - `test:unit`: `node ./scripts/test_ci.mjs`
- `packages/protocol/package.json` (name=`@happier-dev/protocol`)
  - `test`: `vitest run`
- `packages/agents/package.json` (name=`@happier-dev/agents`)
  - `test`: `vitest run --config ../../vitest.config.ts`
- `packages/tests/package.json` (name=`@happier-dev/tests`)
  - `test`: `node scripts/run-vitest-with-heartbeat.mjs --config vitest.core.config.ts`
  - `test:core:fast`: `node scripts/run-vitest-with-heartbeat.mjs --config vitest.core.fast.config.ts`
  - `test:core:slow`: `node scripts/run-vitest-with-heartbeat.mjs --config vitest.core.slow.config.ts`
  - `test:providers`: `node scripts/run-vitest-with-heartbeat.mjs --config vitest.providers.config.ts`
  - `test:stress`: `node scripts/run-vitest-with-heartbeat.mjs --config vitest.stress.config.ts`
  - `test:ui:e2e`: `playwright test -c playwright.ui.config.mjs`
- `packages/relay-server/package.json` (name=`@happier-dev/relay-server`)
  - `test`: `HAPPIER_FEATURE_POLICY_ENV= node --test`
- `packages/cli-common/package.json` (name=`@happier-dev/cli-common`)
  - `test`: `yarn -s build && HAPPIER_FEATURE_POLICY_ENV= node --test "tests/*.test.mjs"`
- `packages/release-runtime/package.json` (name=`@happier-dev/release-runtime`)
  - `test`: `yarn -s build && HAPPIER_FEATURE_POLICY_ENV= node --test "tests/*.test.mjs"`


## CI entrypoints (grep)

Raw grep of workflows for common test invocations. Suite-by-suite CI mapping is captured in each suite’s “CI entrypoints” + “Confirm CI wiring…” audit items; this section is just a quick index of workflow entrypoints.

- `.github/workflows/extended-db-tests.yml:74:        run: yarn test:e2e`
- `.github/workflows/extended-db-tests.yml:142:        run: yarn test:e2e`
- `.github/workflows/extended-db-tests.yml:200:        run: yarn --cwd apps/server test:db-contract`
- `.github/workflows/extended-db-tests.yml:250:        run: yarn --cwd apps/server test:db-contract`
- `.github/workflows/promote-server.yml:190:        run: yarn -s test:release:contracts`
- `.github/workflows/promote-server.yml:223:        run: yarn --cwd apps/server test`
- `.github/workflows/promote-ui.yml:303:          yarn --cwd apps/ui test:unit`
- `.github/workflows/promote-ui.yml:304:          yarn --cwd apps/ui test:integration`
- `.github/workflows/release-npm.yml:242:        run: yarn -s test:release:contracts`
- `.github/workflows/release-npm.yml:267:          yarn --cwd apps/cli test:unit`
- `.github/workflows/release-npm.yml:268:          yarn --cwd apps/cli test:integration`
- `.github/workflows/release-npm.yml:273:          yarn --cwd apps/stack test:unit`
- `.github/workflows/release-npm.yml:274:          yarn --cwd apps/stack test:integration`
- `.github/workflows/release-npm.yml:278:        run: yarn --cwd "${{ steps.server_runner.outputs.dir }}" test`
- `.github/workflows/tests.yml:201:        run: yarn -s test:e2e:ui`
- `.github/workflows/tests.yml:298:        run: yarn --cwd apps/server test:unit`
- `.github/workflows/tests.yml:301:        run: yarn --cwd apps/server test:integration`
- `.github/workflows/tests.yml:360:        run: yarn --cwd apps/server test:server:db-contract`
- `.github/workflows/tests.yml:477:        run: yarn --cwd apps/stack test:unit`
- `.github/workflows/tests.yml:480:        run: yarn --cwd apps/stack test:integration`
- `.github/workflows/tests.yml:512:          yarn -s test:release:contracts`
- `.github/workflows/tests.yml:755:          timeout --signal=KILL --kill-after=30s 25m node --test apps/stack/scripts/self_host_binary_smoke.integration.test.mjs`
- `.github/workflows/tests.yml:756:          timeout --signal=KILL --kill-after=30s 45m node --test apps/stack/scripts/release_binary_smoke.integration.test.mjs`
- `.github/workflows/tests.yml:793:          node --test apps/stack/scripts/self_host_systemd.real.integration.test.mjs`
- `.github/workflows/tests.yml:830:          node --test apps/stack/scripts/self_host_launchd.real.integration.test.mjs`
- `.github/workflows/tests.yml:865:        run: node --test apps/stack/scripts/self_host_schtasks.real.integration.test.mjs`
- `.github/workflows/tests.yml:904:        run: node --test apps/stack/scripts/self_host_daemon.real.integration.test.mjs`
- `.github/workflows/tests.yml:1111:          yarn --cwd apps/cli -s vitest run --config vitest.integration.config.ts src/daemon/daemon.integration.test.ts`
- `.github/workflows/tests.yml:1217:        run: yarn test:e2e:core:fast`
- `.github/workflows/tests.yml:1272:        run: yarn test:e2e:core:slow`
- `.github/workflows/tests.yml:1477:        run: yarn test:stress`


## Shared gating & infrastructure

- Feature-gated tests by filename marker: `**/*.feat.<featureId>.*`
- Feature gating env vars (global): `HAPPIER_BUILD_FEATURES_ALLOW`, `HAPPIER_BUILD_FEATURES_DENY`, `HAPPIER_TEST_FEATURES_DENY`, plus embedded `HAPPIER_FEATURE_POLICY_ENV` / `HAPPIER_EMBEDDED_POLICY_ENV`
- Gating implementation: `scripts/testing/featureTestGating.ts`
- E2E DB selection env vars (packages/tests): `HAPPIER_E2E_DB_PROVIDER` / `HAPPY_E2E_DB_PROVIDER`, and `DATABASE_URL` for postgres/mysql
- Inventory excludes generated dirs by name: `output/`, `test-results/`, `playwright-report/`, `coverage/`, `.project/`, `dist/`, `node_modules/`


## Unassigned test-like files (inventory gap)

These files look like tests by name, but were not mapped into any suite section by this first-pass inventory script. They need manual triage: either map them to the correct suite, or mark them as generated/out-of-scope.

- [x] `apps/cli/scripts/prepack-script.test.mjs` — **What it covers:** packaging contracts via node:test: asserts `apps/cli/package.json` `scripts.prepack` contains “build”, and `files` ships `dist`/`bin` + `tools/archives` + `tools/licenses` while excluding `tools` and `tools/unpacked`. **Real behavior vs mocks:** real fs read + JSON parse; no mocks. **Brittleness risks:** medium (pins packaging surface; expected churn when shipping layout changes). **Speed/flakiness risks:** low (pure read/parse). **Duplication candidates:** overlaps other “packaging manifest” tests across packages; consider one shared “package.json shipping invariants” helper. **Suite/lane fit:** unit/packaging contract (high-signal). **Wiring status:** **appears dead/unwired** (node:test `.test.mjs` under `apps/cli/scripts/` is not included by any configured lane; `apps/cli` uses Vitest and includes only `scripts/**/*.test.ts`).
- [x] `packages/tests/src/testkit/providers/harness/harnessEnv.test.ts` — **What it covers:** provider harness env shaping: `applyHomeIsolationEnv` forces `HAPPIER_SESSION_AUTOSTART_DAEMON='0'`; `applyCliDevTsxTsconfigEnv` sets `TSX_TSCONFIG_PATH` to `<repo>/apps/cli/tsconfig.json` without overriding an explicit value. **Real behavior vs mocks:** real pure helpers; no mocks. **Brittleness risks:** low–medium (pins env var names + tsconfig path shape). **Speed/flakiness risks:** none. **Duplication candidates:** consolidate env shaping helpers (home isolation, tsx/tsconfig) into one small “harness env” module with a single test file. **Suite/lane fit:** unit/support helper tests. **Wiring status:** **appears dead/unwired** (not included by any `packages/tests/vitest.*.config.ts`: providers lane includes only `suites/providers/**` and core lane allowlist does not include this file).
- [x] `packages/tests/src/testkit/providers/satisfaction/traceSatisfaction.test.ts` — **What it covers:** provider trace satisfaction helpers: `checkMaxTraceEvents` caps by distinct `(sessionId, callId)` (streaming updates don’t count as extra calls) and fails closed when `callId` is missing; `hasTraceForKey` matches tool names case-insensitively for keys like `acp/opencode/tool-call/bash`. **Real behavior vs mocks:** pure logic; no mocks. **Brittleness risks:** low–medium (pins error-reason string and trace-key formatting convention). **Speed/flakiness risks:** none. **Duplication candidates:** if more satisfaction rules exist, table-drive common fixtures and keep trace-key parsing centralized. **Suite/lane fit:** unit/support helper tests. **Wiring status:** **appears dead/unwired** (not included by providers lane include globs; not in core allowlist).
- [x] `packages/tests/src/testkit/providers/toolSchemas/validateToolSchemas.test.ts` — **What it covers:** schema validation for normalized tool fixtures: `validateNormalizedToolFixturesV2` fails closed for unsupported protocols, rejects malformed `permission-request` payloads, and reports multiple failures with key + event index context (e.g. `[#0]`). **Real behavior vs mocks:** pure validation; no mocks. **Brittleness risks:** medium (asserts error substrings and fixture key format `protocol/provider/kind/name`). **Speed/flakiness risks:** none. **Duplication candidates:** unify schema-validation helpers and keep error formatting consistent with any CLI lint output. **Suite/lane fit:** unit/support helper tests. **Wiring status:** **appears dead/unwired** (not included by `packages/tests` configured lanes; would only run via ad-hoc `vitest` discovery).
