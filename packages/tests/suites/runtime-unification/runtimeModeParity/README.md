# Runtime-Mode Parity Bench

This bench implements A.13.7 for the runtime-mode-switch migration. It pins the live orchestrator path and gives Codex/Claude deletion lanes a concrete proof before removing or keeping legacy switching residue deleted.

## Recon Findings

- Live host entry points are `apps/cli/src/agent/runtime/mode/switching/launchGating.ts`, `switchTarget.ts`, and `pendingQueueHandoffOrchestrator.ts`, consumed by `apps/cli/src/agent/runtime/session/loop/lifecycle.ts` and terminal/attach flows.
- `apps/cli/src/backends/codex/**` and `apps/cli/src/backends/claude/**` are absent in the current tree, so no still-executing legacy runtime-mode switch path exists for this bench to A/B against.
- All rows are therefore `pin-only` orchestrator rows. `captureLegacyPath()` deliberately throws so a future lane cannot silently compare against a non-existent legacy path.
- OpenCode runtime switching remains retired and intentionally has no scenarios here.

## What Is Pinned

- launch fallback from requested terminal/local startup to remote when terminal support is unavailable
- runtime switch target parsing for `local`/`remote`
- pending-queue handoff actions and terminal pending-handoff status
- final runtime-slice state (`runtimeMode`, local-control attachment/writability)
- preservation of `providerSessionId` and mode values after normalization

## Normalization

`_normalize.ts` masks volatile timestamps and UUIDs, sorts object keys and same-tick arrays, and removes `hostRecoveryNoise`. It does not mask `providerSessionId`, `from`, `to`, or `reason`; those are the contract.

## Adding Rows

Add a `RuntimeModeParityScenario` in `scenarios.ts` with an explicit `expected` capture. New rows must not be skipped, and scenario ids should use `<backend>.<transition>.<reason-or-case>` naming.

## Commands

```bash
yarn workspace @happier-dev/tests test suites/runtime-unification/runtimeModeParity/
grep -c "RuntimeModeParityScenario" packages/tests/suites/runtime-unification/runtimeModeParity/scenarios.ts
grep -c "it\\.skip\\|test\\.skip" packages/tests/suites/runtime-unification/runtimeModeParity/parity.test.ts
```
