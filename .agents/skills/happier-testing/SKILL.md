---
name: happier-testing
description: Author, change, review, delete, or audit Happier tests through observable contracts, canonical testkits, risk-selected validation, and safe subsystem cleanup. Use for behavior-changing TDD and for test-infrastructure or test-pruning work.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Testing And TDD

Use this skill whenever work adds, changes, reviews, deletes, or audits tests, fixtures, testkits, lane wiring, or validation behavior. It is the single test-quality owner; CI failure collection remains in `.agents/skills/happier-ci-stabilize`.

## Goal

Apply strict RED-GREEN-REFACTOR while following Happier-specific lane, fixture, and rerun rules so changes do not silently drift until a late pipeline sweep.

## Workflow

1. **Inventory first**
- Search for existing tests by symbol, route, command, feature id, config key, component name, or error code.
- Map the affected lane(s) and any shared/package-local harnesses the change can invalidate before editing code.
- Name the observable contract or material risk the test must distinguish before writing it.
- For user-visible or environment-dependent work, define the composed live recipe before implementation: exact entry point, provider/account/state, actions, expected outcome, recovery path, and build/bundle/runtime identity that will prove the result.
- Update the most relevant existing test first when possible.
- Consolidate overlapping tests instead of stacking new ones on top.

2. **Classify failures correctly**
- `production defect`: runtime behavior is wrong
- `stale test or expectation`: assertions/fixtures assume an obsolete contract
- `harness or mock defect`: helpers/mocks/testkit do not represent real runtime wiring
- `release-control or setup defect`: workflow admission, permissions, generated prerequisites, or configuration are wrong
- `external service or configuration defect`: an external dependency, credential, account, or published state is unavailable or invalid
- `resource or timeout defect`: the owning resource budget, cleanup, runner, or lifecycle bound is wrong
- `inconclusive`: available evidence cannot yet identify the owning class

3. **RED**
- Write or update the smallest relevant test first.
- Run only the smallest relevant slice and confirm it fails because the intended behavior is missing or wrong, not because of setup, fixtures, mocks, wording, syntax, or an unrelated error.

4. **GREEN**
- Implement the smallest fix that satisfies the failing behavior.
- Keep internal behavior real; mock only system boundaries.

5. **REFACTOR**
- Extract shared helpers only when there is repeated real duplication or repeated stale drift.
- Keep file responsibilities focused.

6. **Broaden validation**
- After focused GREEN, run risk-selected adjacent checks; batch expensive package/build and broader checks at the coherent integration boundary under root **Validation**. Reuse applicable execution evidence under that policy instead of rerunning it for each handoff.
- Intermediate handoffs name any deferred check, later owning boundary, and prerequisite. Final handoffs require applicable successful evidence for each required lane or report the missing gate blocked.
- Validate the current moving source and the existing development stack. Feature validation must not create, freeze, pack, install, identify, or certify a separate release representation; archive production and publication verification belong only to release automation during an explicitly dispatched release.

## Test Value Gate

- Scope-preserving solution economy never caps evidence. Test and QA depth follow materially distinct behavior, reachable failure modes, and risk; implementation size, line count, or a desire for one runnable check cannot justify dropping a required contract, edge/failure/recovery case, compatibility direction, platform path, or live gate.
- TDD proves an observable contract; it does not require a new test for every changed function, branch, helper, or file.
- Prefer strengthening or consolidating the canonical owner-level test over adding overlapping coverage.
- One discriminating test is more valuable than many shallow permutations. Add cases only for materially different contracts, boundaries, or failure modes.
- A useful test distinguishes the intended implementation from at least one plausible incorrect implementation. A meaningful original RED proves sensitivity while it still exercises the relevant defect. If that evidence is absent or no longer applicable, demonstrate the failure with a focused mutation/reproduction through the owner boundary; do not repeat a mutation merely for another handoff. Preserve unrelated shared edits.
- When a check passes too easily or contradicts visible behavior, challenge the observation method before trusting the system. Verify that fixture state reaches the deciding branch, the assertion reads the field production writes (accessor-backed objects such as `Headers` do not expose plain properties), the instrument can observe the claimed cost or state, and the code under test cannot swallow its own failure and read as a pass.
- Do not add runtime tests that merely restate TypeScript types, mirror implementation structure, assert pass-through wiring or incidental call counts, or police wording, formatting, raw styles, or example values.
- Exercise real internal behavior through the canonical/public owner boundary whenever practical.
- Remove or consolidate redundant tests introduced or exposed by the change.

Before retaining or adding a test, answer all four questions:

1. Which observable behavior, invariant, released contract, or reachable material risk does it protect?
2. Which plausible implementation mistake would make it fail?
3. Why does a stronger existing owner-level test not already catch that mistake?
4. Does the test require a production export, reset, dependency injection seam, or mode that no production caller needs?

A missing answer is a review signal, not an automatic deletion verdict. Static inspection remains valid when it is the cheapest independent proof of a public API, generated artifact, package boundary, workflow permission/trust contract, migration, security property, or platform configuration and survives behavior-preserving refactoring.

## Test Audit And Mechanical Cleanup

For an explicit test-pruning, test-infrastructure, or whole-subsystem audit, read [test-audit.md](references/test-audit.md). Audit one canonical owner or subsystem at a time. Use deterministic analyzers and codemods for mechanical repetition, but keep contract value, keeper selection, compatibility obligations, and deletion decisions evidence-led.

## Compatibility Contract Gate

- Use `.agents/skills/happier-compatibility` when a behavior change affects wire/semantic contracts, persistence, schemas/migrations, feature negotiation, installer/service state, mixed versions, upgrades, or rollback.
- Name the exact released/predecessor producer and consumer plus the direction the test proves. Prefer the real historical serializer/client/artifact or a provenance-pinned golden vector; do not reconstruct “old” behavior from current types or a new mock.
- Add one discriminating contract/vector test per material reachable direction, then only the risk-selected end-to-end flows. Do not multiply UI × CLI × daemon × server permutations when the changed seam does not couple them.
- Inventory and consolidate existing compatibility fixtures and harnesses before adding another family; a compatibility test must not create a second implementation of the protocol it is meant to verify.

## Happier Lane Map

Canonical top-level lanes:
- `yarn test`
- `yarn test:integration`
- `yarn test:e2e:core:fast`
- `yarn test:e2e:core:slow`
- `yarn test:e2e:ui`
- `yarn test:providers`
- `yarn test:db-contract:docker`

CLI lane rule:
- `apps/cli` unit tests must not force a full CLI `dist` build.
- Use the lane-specific global setup files:
  - `src/test-setup.unit.ts`
  - `src/test-setup.integration.ts`
  - `src/test-setup.slow.ts`

## Fixture And Mock Policy

- Do not partially mock central shared modules such as `@/sync/domains/state/storage`.
- Prefer package-local shared factories/testkits for repeated boundary mocks.
- Keep cross-repo primitives in `packages/tests/src/testkit`.
- Before adding a new helper or mock family, inspect the codebase for the existing canonical testkit/helper for that boundary. On a structural fixture/setup mismatch, trace the real producer-to-consumer input graph before another rerun; repair coherent fixtures rather than adding internal stubs one failure at a time.
- Prefer reusing, extending, generalizing, or extracting from canonical helpers over introducing similar-but-different variants.
- A count or identity RED drives the production producer path. A harness that republishes by replacing records with `setState`, or a boundary mock that returns fresh callbacks or objects on every render, manufactures churn production never has, and a mock that never republishes makes the test pass vacuously. Make boundary mocks identity-stable before trusting a RED, and confirm that the producer behavior the RED models really happens in source or live.
- A failure is "not ours" only after attribution evidence. When the failing suite imports anything the lane changed, that evidence is an A/B: the same command on the same source fails identically with only the lane's hunks bypassed (root **Multi-agent and Git safety** bypass rule). A file name, corridor or "pre-existing" guess is not evidence; report the failure as unattributed.
- When a new canonical helper replaces older local variants, migrate or remove the overlapping variants instead of leaving parallel helper families behind.
- Be careful with repeat-offender boundaries: prefer canonical helpers over fresh inline mocks for UI boundaries such as `expo-router`, `@/text`, `@/modal`, `react-native`, and `react-native-unistyles`; prefer existing server route/DB harnesses over direct storage mocks when available.
- For `apps/ui` tests, treat `apps/ui/sources/dev/testkit/**` as the default surface. Read `apps/ui/sources/dev/testkit/README.md` first and prefer imports from `@/dev/testkit` for mocks, fixtures, render helpers, hook helpers, and harnesses.
- Do not add new inline `vi.mock(...)` families for `expo-router`, `@/text`, `@/modal`, `react-native`, `react-native-unistyles`, or `@/sync/domains/state/storage` when the UI testkit already owns that boundary. If a needed case is missing, extend the canonical UI testkit helper in the same change instead of inventing a file-local mock family.
- If a one-off local UI override is truly unavoidable, keep it minimal, base it on the canonical factory where possible, and leave a short justification comment rather than turning it into a new reusable pattern.
- Prefer typed fixtures/builders from the owning testkit over repeated inline object literals whenever the same state/session/theme/config shape is reused across tests.
- When one boundary spy carries several event kinds (for example a session socket), filter to the event owned by the contract before asserting. A total call count is incidental and becomes stale whenever an unrelated valid event is added.
- Extend the canonical boundary harness's default behavior for the one exceptional event under test. Do not replace the whole boundary with a one-response stub that silently stops acknowledging neighboring protocol calls.
- Keep package-specific fixtures near the owning package:
  - UI helpers in `apps/ui`
  - CLI helpers in `apps/cli`
  - server helpers in `apps/server`

## UI E2E Rules

- Use stable `testID` selectors, not visible copy, as the primary selector contract.
- Click the real submit/confirm button after waiting for it to be enabled.
- Do not rely on Enter-to-send or similar settings-sensitive shortcuts unless the test explicitly configures the setting first.
- When a UI flow changes, update the corresponding Playwright spec in the same change.
- Use `packages/tests/src/testkit/uiE2e/browserDiagnostics.ts` for browser console, page-error, failed-request, and error-response collection. Append diagnostics with its stack-preserving helper; never replace the original exception with a new wrapper that erases the deciding callsite.
- Label repeated lifecycle waits by phase (for example, initial upload versus conflict retry). When one scenario crosses filesystem, daemon, API, and UI boundaries, capture enough outcome state to identify the boundary that failed rather than increasing every timeout.
- Configure the UI state the assertion actually needs. In particular, a plain or all-untracked workspace is empty in the repository tree's **Project** visibility mode; use the shared repository-tree visibility helper when the scenario requires **All files**. Do not weaken the product's default just to make a fixture visible.

## Anti-Flake Process Rules

- Within this task and its delegates, reuse an active run of the same spec/lane instead of launching an equivalent rerun. Follow root waiting/recovery policy; this requires no cross-session monitor coordination.
- If a runner hangs or is killed, inspect whether the failure is repo-owned, harness-owned, or environmental before retrying blindly.
- When shared process helpers change, rerun a broader lane that can reveal leaked handles or child-process cleanup regressions.
- Before starting Metro/Playwright in a shared development VM, inspect current compiler, Vitest, and Metro load. A bundle-fetch timeout while several unrelated compilers or Metro servers saturate the same VM is not valid RED evidence. Wait for capacity or use the configured execution target, then rerun the same command; do not encode local contention as a larger repository timeout.
- Preserve the runner's original stack, phase label, browser diagnostics, and focused artifacts. If the hosted log omits the deciding state, download the bounded Playwright shard artifact before rerunning; inspect metadata first and avoid blindly fetching oversized diagnostics trees.
- When a failure involves a timeout, retry count, request/body cap, or other bound, first prove which lifecycle or resource owner should govern it. Do not turn one slow run or fixture size into a new production limit. A deciding regression test should show reuse of the canonical budget/boundary and accept valid work beyond the incorrect local cutoff it replaces.

## Live Validation Gates

Host-test green alone is not shippable for user-visible behavior; this skill owns the lane-level live-validation rules.

- Treat live gates (managed-stack browser QA, argent device QA) as ship gates for UI-visible changes; write or extend host tests from what the live loop taught, afterwards.
- For daemon/session/provider/API behavior that depends on real process, transport, authentication, persistence, or provider semantics, run the named composed CLI/API/daemon recipe when the authorized environment is available. Corridor tests do not replace this gate.
- If a defect family escapes host tests twice, stop adding host tests and switch to live-in-the-loop: fix → load and identify the updated build/bundle/module actually consumed → replay the exact failing recipe → verify live, closing each defect with a live PASS against that observed basis in the same session.
- Reuse an applicable successful full-suite result; release use alone does not require running it twice. Repeat the affected lane when investigating nondeterminism, shared-state leakage, order dependence, or when an explicit release protocol requires independent execution. Two passes are evidence, not proof of determinism.
- If a documented memory-heavy UI host suite OOMs at the default heap, rerun with `NODE_OPTIONS=--max-old-space-size=8192` instead of silently narrowing the lane.
- Device QA must pin bundle identity when stale Metro state could invalidate the result: full Metro reload, Fast Refresh off, and a module probe.

Do not mark a validation step complete merely because wiring is registered, a command reached a compiler/test runner, or a background process remains running. Record the terminal exit/result and decisive product evidence. If the live recipe cannot run, mark it `BLOCKED` with the missing prerequisite and next action; do not substitute more host tests and call the behavior shipped.

## Output Expectations

When reporting testing work, summarize:
- failing area and classification
- root cause
- targeted RED/GREEN evidence
- broader validation performed or applicable evidence reused; outstanding checks and prerequisites
- residual risk, if any
