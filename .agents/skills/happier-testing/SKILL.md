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
- Validate the current moving source and the existing development stack:
  1. **Inner loop:** run the smallest direct source-level RED/GREEN slice without a package build.
  2. **Lane confidence:** run one risk-selected adjacent corridor lane and source-level typechecking when it can run without republishing shared outputs.
  3. **Integrated package boundary:** run the package typecheck/build-enforcing lane once after the coherent batch sharing that output has settled.
  4. **Loaded-runtime boundary:** load/reload and probe the relevant bundle, module, process, or daemon, then batch the materially distinct live scenarios that consume it.
- Feature validation ends at the deciding source, integration, and loaded-runtime surfaces. Do not create, freeze, pack, install, identify, or certify a separate release representation; archive production and publication verification belong only to release automation during an explicitly dispatched release.
- Intermediate handoffs may defer a later expensive tier only when the result records the exact unrun check, later owning boundary, and prerequisite. Deferred evidence cannot close the affected gate or support `VERIFIED_COMPLETE`; before final handoff, run every required tier or report it `BLOCKED`.
- Do not invoke a package script whose setup republishes shared build/generated output merely to run a focused test when the canonical lane-specific source harness exists. Do not skip a build when the changed behavior itself consumes generated or built output.

## Test Value Gate

- Scope-preserving solution economy never caps evidence. Test and QA depth follow materially distinct behavior, reachable failure modes, and risk; implementation size, line count, or a desire for one runnable check cannot justify dropping a required contract, edge/failure/recovery case, compatibility direction, platform path, or live gate.
- TDD proves an observable contract; it does not require a new test for every changed function, branch, helper, or file.
- Prefer strengthening or consolidating the canonical owner-level test over adding overlapping coverage.
- One discriminating test is more valuable than many shallow permutations. Add cases only for materially different contracts, boundaries, or failure modes.
- A useful test distinguishes the intended implementation from at least one plausible incorrect implementation. If it would pass both, passes too easily, or contradicts visible behavior, challenge the fixture, instrument, harness, and observed branch before trusting the system; strengthen or remove the check. Reuse meaningful original RED evidence; a separate mutation is needed only when that evidence is missing or no longer establishes sensitivity to the relevant defect.
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
- For an edited local-only/development-exposed migration already applied to the current checkout's deterministic repo-local development stack, validation includes mandatory in-place reconciliation of that retained database. Never delete/reset/recreate/replace/clean it and never substitute a fresh database. No separate confirmation or backup/clone is required for this narrow repo-local target. Run the canonical deploy twice and verify current source checksums, ledger, provider integrity, and foreign keys; a later migration edit invalidates this evidence.

## Happier Lane Map

Canonical top-level lanes:
- `yarn test`
- `yarn test:integration`
- `yarn test:e2e:core:fast`
- `yarn test:e2e:core:slow`
- `yarn test:e2e:ui`
- `yarn test:agents`
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
- When a new canonical helper replaces older local variants, migrate or remove the overlapping variants instead of leaving parallel helper families behind.
- Be careful with repeat-offender boundaries: prefer canonical helpers over fresh inline mocks for UI boundaries such as `expo-router`, `@/text`, `@/modal`, `react-native`, and `react-native-unistyles`; prefer existing server route/DB harnesses over direct storage mocks when available.
- For `apps/ui` tests, treat `apps/ui/sources/dev/testkit/**` as the default surface. Read `apps/ui/sources/dev/testkit/README.md` first and prefer imports from `@/dev/testkit` for mocks, fixtures, render helpers, hook helpers, and harnesses.
- Do not add new inline `vi.mock(...)` families for `expo-router`, `@/text`, `@/modal`, `react-native`, `react-native-unistyles`, or `@/sync/domains/state/storage` when the UI testkit already owns that boundary. If a needed case is missing, extend the canonical UI testkit helper in the same change instead of inventing a file-local mock family.
- If a one-off local UI override is truly unavoidable, keep it minimal, base it on the canonical factory where possible, and leave a short justification comment rather than turning it into a new reusable pattern.
- Prefer typed fixtures/builders from the owning testkit over repeated inline object literals whenever the same state/session/theme/config shape is reused across tests.
- When one boundary spy carries several event kinds, filter to the event owned by the contract before asserting. Total call counts are incidental and drift when unrelated valid events are added.
- Extend the canonical boundary harness's default behavior for the exceptional event under test. Do not replace the whole boundary with a one-response stub that stops acknowledging neighboring protocol calls.
- Keep package-specific fixtures near the owning package:
  - UI helpers in `apps/ui`
  - CLI helpers in `apps/cli`
  - server helpers in `apps/server`

## UI E2E Rules

- Use stable `testID` selectors, not visible copy, as the primary selector contract.
- Click the real submit/confirm button after waiting for it to be enabled.
- Do not rely on Enter-to-send or similar settings-sensitive shortcuts unless the test explicitly configures the setting first.
- When a UI flow changes, update the corresponding Playwright spec in the same change.
- Use `packages/tests/src/testkit/uiE2e/browserDiagnostics.ts` for browser console, page-error, failed-request, and error-response collection. Append diagnostics with its stack-preserving helper instead of replacing the original exception and callsite.
- Label repeated lifecycle waits by phase. For cross-boundary scenarios, capture enough outcome state to identify the failing boundary before raising a timeout.
- Configure the UI state the assertion actually needs. A plain or all-untracked workspace is empty in the repository tree's **Project** mode; select **All files** through the shared helper when that is the tested surface.

## Anti-Flake Process Rules

- Within this task and its delegates, reuse an active run of the same spec/lane instead of launching an equivalent rerun. Follow root waiting/recovery policy; this requires no cross-session monitor coordination.
- If a runner hangs or is killed, inspect whether the failure is repo-owned, harness-owned, or environmental before retrying blindly.
- When shared process helpers change, rerun a broader lane that can reveal leaked handles or child-process cleanup regressions.
- Before starting Metro or Playwright in a shared development VM, inspect current compiler, Vitest, and Metro load. A bundle-fetch timeout under unrelated saturation is not valid RED evidence and must not become a larger repository timeout.
- Preserve the original stack, phase label, browser diagnostics, and focused artifacts. Inspect artifact metadata before downloading a potentially huge diagnostics tree.
- When a failure involves a timeout, retry count, request/body cap, or other bound, first prove which lifecycle or resource owner should govern it. Do not turn one slow run or fixture size into a new production limit. A deciding regression test should show reuse of the canonical budget/boundary and accept valid work beyond the incorrect local cutoff it replaces.

## Live Validation Gates

The dedicated QA-host browser owner launches Chromium with `--no-sandbox`, as approved for browsing Happier's own QA app. Agent-browser/Playwright attach to its returned CDP endpoint; keep this policy in `qa_browser.mjs` rather than adding launch flags in individual lanes. Use a TTY-backed foreground tool handle and verify browser/profile/forward cleanup after SIGINT; cancelling a non-TTY checkout launcher can leave the actual command running.

Host-test green alone is not shippable for user-visible behavior; this skill owns the lane-level live-validation rules.

For an explicitly authorized controlled QA stack, use `dev-targets browser start <lane-session> --stack=<qa-stack> --url=<qa-ui-url>` to select the QA pool host with the greatest observed unreserved memory independently of the daemon pin. Use its returned CDP endpoint and origin-preserving browser-facing `url` with controller-local agent-browser or Playwright; the browser owner supplies a lane-owned loopback reverse SOCKS route to the controller ingress, including canonical Home addresses adopted after restore. Retain the foreground owner handle and terminate it after the round to clean up the browser/profile and forwards. Provision through `dev-targets qa setup <target> --stack=<qa-stack>` when needed. The controlled-stack skill owns the stack and pin lifecycle. An unusable pool or unavailable selected host fails closed without a controller-local browser. This does not authorize creating a dedicated stack for ordinary QA or changing another stack's Machine.

- Managed-stack browser QA and argent device QA are ship checks for UI-visible changes: run what the executor can reach now, and list the rest once as release checks owned by release automation and human QA. They are not per-lane or per-feature completion gates, and their absence does not authorize new gates, ledgers, or matrices. Write or extend host tests from what the live loop taught, afterwards.
- For daemon/session/provider/API behavior that depends on real process, transport, authentication, persistence, or provider semantics, run the named composed CLI/API/daemon recipe when the authorized environment is available. Corridor tests do not replace this check; when the environment is unavailable, record it as a release check with its prerequisite rather than as a blocker on implementation completion.
- Several source lanes may share one composed live session when that session reaches every material contract and records each scenario’s result; batching setup is not permission to omit a flow, state, failure, recovery, platform, or accessibility obligation.
- If a defect family escapes host tests twice, stop adding host tests and switch to live-in-the-loop: fix → load and identify the updated build/bundle/module actually consumed → replay the exact failing recipe → verify live, closing each defect with a live PASS against that observed basis in the same session. Hot reload or a module probe is sufficient when it proves the changed source is loaded.
- Reuse an applicable successful full-suite result; release use alone does not require running it twice. Repeat the affected lane when investigating nondeterminism, shared-state leakage, order dependence, or when an explicit release protocol requires independent execution. Two passes are evidence, not proof of determinism.
- If a documented memory-heavy UI host suite OOMs at the default heap, rerun with `NODE_OPTIONS=--max-old-space-size=8192` instead of silently narrowing the lane.
- Device QA must pin bundle identity when stale Metro state could invalidate the result: full Metro reload, Fast Refresh off, and a module probe.
- Close what you open. At the end of a browser QA lane, close every browser you launched: persistent Playwright/Chromium contexts, agent-browser sessions, and their temporary profile directories. An abandoned headless renderer keeps consuming CPU and memory on the shared machine for hours. Leave only a browser the human explicitly asked to keep, and never close another session's browser.

### Dedicated controlled-stack routing

Do not create a dedicated QA stack merely because testing or QA is requested. When a human explicitly requests a dedicated, isolated, stable, controlled, snapshot-backed, or manual-restart QA stack, invoke `.agents/skills/happier-controlled-stack-qa` and let it own provisioning, reuse, runtime identity, reload boundaries, borrowed Expo, and teardown. That skill requires one remembered stack per agent session unless the human explicitly requests multiple stacks.

Do not mark a validation step complete merely because wiring is registered, a command reached a compiler/test runner, or a background process remains running. Record the terminal exit/result and decisive product evidence. If the live recipe cannot run, mark it `BLOCKED` with the missing prerequisite and next action; do not substitute more host tests and call the behavior shipped.

### Blank development web startup

- Separate HTML delivery, bundle delivery/evaluation, React commit, rendered app content, and authenticated Home connectivity. Require the expected origin/path, nonempty app content, and a screenshot; root children alone can be Expo development chrome. A successful `open`, HTTP 200, or `main` console message does not close readiness.
- Install error/unhandled-rejection capture and a React commit hook before navigation. Keep the browser handle and target identity through the readiness wait and subsequent probes. If an automation daemon exits, its replacement `about:blank` page is a lost diagnostic target, not the application's rendered output.
- If native browser automation loses its target or CDP responsiveness, compare once with a persistent context using the repository's existing Playwright dependency and the same Chrome executable, URL, and read-only authentication state. Attach later CLI probes to that browser's explicit CDP endpoint and page target rather than launching another browser. Do not save or print the supplied credential state.
- Wait for the required app surface, not `networkidle`: Home/socket traffic and background workers may continue after first paint. Preserve request failures with URL paths, timestamps, console errors, and the loaded bundle response. Record authentication separately from rendering; an authenticated shell can render while its Home is unreachable.
- For `ERR_EMPTY_RESPONSE`, connection resets, or failed lazy-route chunks, correlate the exact request time with the stack's remote Expo log and the forward's listening process. Metro heap exhaustion can leave the SSH listener alive while its upstream is down; an app recovery boundary then reports the failed chunk fetch. Stack health and an earlier successful bundle do not refute that failure.
- Inspect `apps/stack/scripts/utils/expo/expoNodeHeapEnv.mjs` before proposing a heap change. It owns the Expo heap policy and its existing override. Do not replace an out-of-memory diagnosis with a guessed larger limit or longer readiness timeout; distinguish the verified crash from an unmeasured allocation/retention cause, and respect the task's lifecycle authority.

## Output Expectations

When reporting testing work, summarize:
- failing area and classification
- root cause
- targeted RED/GREEN evidence
- broader validation performed or applicable evidence reused; outstanding checks and prerequisites
- residual risk, if any
