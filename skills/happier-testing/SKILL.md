---
name: happier-testing
description: Repo-specific TDD and test-validation workflow for Happier changes, with lane selection, fixture policy, and anti-flake guardrails.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Testing And TDD

Use this skill for behavior-changing work in this repository, especially when changes touch shared runtime contracts, CLI/server/UI flows, or any lane that historically accumulates stale fixtures.

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
- `production bug`: runtime behavior is wrong
- `test drift`: assertions/fixtures assume an obsolete contract
- `harness drift`: helpers/mocks/testkit no longer match real runtime wiring
- `infra/resource issue`: disk, Docker, stale child processes, or similar environment failures

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
- After a targeted green run in a shared area, rerun one broader related lane.
- Use this validation ladder; advance only as far as the current claim requires:
  1. **Inner loop:** run the smallest direct source-level RED/GREEN slice without a package build.
  2. **Lane confidence:** run one risk-selected adjacent corridor lane and source-level typechecking when it can run without republishing shared outputs.
  3. **Integrated package boundary:** run the package typecheck/build-enforcing lane once after the coherent batch sharing that output has settled.
  4. **Loaded-runtime boundary:** load/reload and probe the relevant bundle, module, process, or daemon, then batch the materially distinct live scenarios that consume it.
  5. **Artifact/release boundary:** pack, install, and smoke the emitted artifact only when the claim concerns packaged output, installation, publication, or release behavior.
- After source and loaded-runtime QA converge, build one settled candidate and reuse that exact candidate across every applicable artifact, platform, install, compatibility, and release QA lane. Rebuild only when an accepted fix changes candidate-reachable bytes; do not carry evidence from the superseded candidate to its replacement.
- Intermediate handoffs may defer a later expensive tier only when the result records the exact unrun check, later owning boundary, and prerequisite. Deferred evidence cannot close the affected gate or support `VERIFIED_COMPLETE`; before final handoff, run every required tier or report it `BLOCKED`.
- Do not invoke a package script whose setup republishes shared build/generated output merely to run a focused test when the canonical lane-specific source harness exists. Do not skip a build when the changed behavior itself consumes generated, built, packaged, or installed output.

## Test Value Gate

- Scope-preserving solution economy never caps evidence. Test and QA depth follow materially distinct behavior, reachable failure modes, and risk; implementation size, line count, or a desire for one runnable check cannot justify dropping a required contract, edge/failure/recovery case, compatibility direction, platform path, or live gate.
- TDD proves an observable contract; it does not require a new test for every changed function, branch, helper, or file.
- Prefer strengthening or consolidating the canonical owner-level test over adding overlapping coverage.
- One discriminating test is more valuable than many shallow permutations. Add cases only for materially different contracts, boundaries, or failure modes.
- A useful test distinguishes the intended implementation from at least one plausible incorrect implementation. If it would pass both, strengthen or remove it.
- Do not add runtime tests that merely restate TypeScript types, mirror implementation structure, assert pass-through wiring or incidental call counts, or police wording, formatting, raw styles, or example values.
- Exercise real internal behavior through the canonical/public owner boundary whenever practical.
- Remove or consolidate redundant tests introduced or exposed by the change.

## Compatibility Contract Gate

- Use `skills/happier-compatibility` when a behavior change affects wire/semantic contracts, persistence, schemas/migrations, feature negotiation, installer/service state, mixed versions, upgrades, or rollback.
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
- Before adding a new helper or mock family, inspect the codebase for the existing canonical testkit/helper for that boundary.
- Prefer reusing, extending, generalizing, or extracting from canonical helpers over introducing similar-but-different variants.
- When a new canonical helper replaces older local variants, migrate or remove the overlapping variants instead of leaving parallel helper families behind.
- Be careful with repeat-offender boundaries: prefer canonical helpers over fresh inline mocks for UI boundaries such as `expo-router`, `@/text`, `@/modal`, `react-native`, and `react-native-unistyles`; prefer existing server route/DB harnesses over direct storage mocks when available.
- For `apps/ui` tests, treat `apps/ui/sources/dev/testkit/**` as the default surface. Read `apps/ui/sources/dev/testkit/README.md` first and prefer imports from `@/dev/testkit` for mocks, fixtures, render helpers, hook helpers, and harnesses.
- Do not add new inline `vi.mock(...)` families for `expo-router`, `@/text`, `@/modal`, `react-native`, `react-native-unistyles`, or `@/sync/domains/state/storage` when the UI testkit already owns that boundary. If a needed case is missing, extend the canonical UI testkit helper in the same change instead of inventing a file-local mock family.
- If a one-off local UI override is truly unavoidable, keep it minimal, base it on the canonical factory where possible, and leave a short justification comment rather than turning it into a new reusable pattern.
- Prefer typed fixtures/builders from the owning testkit over repeated inline object literals whenever the same state/session/theme/config shape is reused across tests.
- Keep package-specific fixtures near the owning package:
  - UI helpers in `apps/ui`
  - CLI helpers in `apps/cli`
  - server helpers in `apps/server`

## UI E2E Rules

- Use stable `testID` selectors, not visible copy, as the primary selector contract.
- Click the real submit/confirm button after waiting for it to be enabled.
- Do not rely on Enter-to-send or similar settings-sensitive shortcuts unless the test explicitly configures the setting first.
- When a UI flow changes, update the corresponding Playwright spec in the same change.

## Anti-Flake Process Rules

- Keep only one active rerun per spec/lane.
- If a runner hangs or is killed, inspect whether the failure is repo-owned, harness-owned, or environmental before retrying blindly.
- When shared process helpers change, rerun a broader lane that can reveal leaked handles or child-process cleanup regressions.
- Keep only one monitor for an exclusive build, generated-output publisher, managed runtime resource, or other shared prerequisite. After healthy progress is established, park dependent validation until a completion/failure/material-change signal; do not launch another watcher or repeat the blocked command without new evidence.

## Live Validation Gates

Host-test green alone is not shippable for user-visible behavior; this skill owns the lane-level live-validation rules.

- Treat live gates (managed-stack browser QA, argent device QA) as ship gates for UI-visible changes; write or extend host tests from what the live loop taught, afterwards.
- For daemon/session/provider/API behavior that depends on real process, transport, authentication, persistence, or provider semantics, run the named composed CLI/API/daemon recipe when the authorized environment is available. Corridor tests do not replace this gate.
- Several source lanes may share one composed live session when that session reaches every material contract and records each scenario’s result; batching setup is not permission to omit a flow, state, failure, recovery, platform, or accessibility obligation.
- If a defect family escapes host tests twice, stop adding host tests and switch to live-in-the-loop: fix → load and identify the updated build/bundle/module actually consumed → replay the exact failing recipe → verify live, closing each defect with a live PASS against that observed basis in the same session. Hot reload or a module probe is sufficient when it proves the changed source is loaded; do not require a packaged build unless the behavior consumes packaged output.
- When a full-suite result is used as a release/ship gate, or shared-state leakage/order dependence is a material risk, run it twice back-to-back before calling it deterministic.
- If a documented memory-heavy UI host suite OOMs at the default heap, rerun with `NODE_OPTIONS=--max-old-space-size=8192` instead of silently narrowing the lane.
- Device QA must pin bundle identity when stale Metro state could invalidate the result: full Metro reload, Fast Refresh off, and a module probe.

### Dedicated controlled-stack routing

Do not create a dedicated QA stack merely because testing or QA is requested. When a human explicitly requests a dedicated, isolated, stable, controlled, snapshot-backed, or manual-restart QA stack, invoke `skills/happier-controlled-stack-qa` and let it own provisioning, reuse, runtime identity, reload boundaries, borrowed Expo, and teardown. That skill requires one remembered stack per agent session unless the human explicitly requests multiple stacks.

Do not mark a validation step complete merely because wiring is registered, a command reached a compiler/test runner, or a background process remains running. Record the terminal exit/result and decisive product evidence. If the live recipe cannot run, mark it `BLOCKED` with the missing prerequisite and next action; do not substitute more host tests and call the behavior shipped.

## Output Expectations

When reporting testing work, summarize:
- failing area and classification
- root cause
- targeted RED/GREEN evidence
- broader lane rerun performed
- residual risk, if any
