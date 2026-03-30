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
- Update the most relevant existing test first when possible.
- Consolidate overlapping tests instead of stacking new ones on top.

2. **Classify failures correctly**
- `production bug`: runtime behavior is wrong
- `test drift`: assertions/fixtures assume an obsolete contract
- `harness drift`: helpers/mocks/testkit no longer match real runtime wiring
- `infra/resource issue`: disk, Docker, stale child processes, or similar environment failures

3. **RED**
- Write or update the smallest relevant test first.
- Run only the smallest relevant slice and confirm it fails for the expected reason.

4. **GREEN**
- Implement the smallest fix that satisfies the failing behavior.
- Keep internal behavior real; mock only system boundaries.

5. **REFACTOR**
- Extract shared helpers only when there is repeated real duplication or repeated stale drift.
- Keep file responsibilities focused.

6. **Broaden validation**
- After a targeted green run in a shared area, rerun one broader related lane.
- Before handoff, rerun the touched package typecheck/build-enforcing lane and the relevant repo lanes.

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

## Output Expectations

When reporting testing work, summarize:
- failing area and classification
- root cause
- targeted RED/GREEN evidence
- broader lane rerun performed
- residual risk, if any
