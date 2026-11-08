Verdict: FOCUSED_VERIFIED — 115/115 route tests pass with no Vitest unhandled rejection. All 14 original failures were fixture/expectation drift; no production behavior changed. Broader checks are red/incomplete and routed below. This test/report/evidence packet is the lane's commit scope; RESULT goes to Systemic and VOICE-TEST-DEBT-1108.

# sync-route-hydration-red-1108

Scope: execute `briefs/sync-route-hydration-red-1108.md`; preserve concurrent source and Settings retry work. All commands explicitly select the 0.3 checkout. No database or stack lifecycle mutations.

## Attribution of the original 14 failures

All classifications below derive from current source and the original Voice evidence at `../../2026-10-02-voice-experience/evidence/voice-test-debt-1108/ui-red.log`.

- Stale document demand, two variants: stale expectation. `localSessionRouteReadiness.ts` throws `HappyError`, whose public retry field is `canTryAgain`; retain the no-polling and subsequent-publication assertions.
- Captured encryption instance replaced: fixture drift. Restore the encrypted Home with matching persisted-mode/currentness HTTP through the existing encrypted-Home helper.
- Socket-created row retained after omitted list: fixture drift. A Plain Account's request credentials must not claim active E2EE custody.
- Applied Home versus staged selection: same Plain Account credential drift; preserve the exact applied-Home isolation assertions.
- Retained Bot summary: fixture drift. Supply the canonical current display projection; preserve server omission counting and retained previews.
- Immutable Settings mutation during preflush: incomplete HTTP fixture and late rejection observation. Preserve unrelated default Account endpoints, including currentness, and attach the expected rejection before awaiting held HTTP.
- Same-ID missing encryption on another Home: fixture drift. Restore the matching E2EE Account through the existing helper and match the negotiated detail path independently of its query string; fail promptly if hydration settles before the held request.
- Recipient missing envelope: fixture drift. Restore matching E2EE Account mode/currentness at the actual HTTP boundary; retain locked-shell and cipher-removal assertions.
- Non-active socket-source Home: Plain Account credential drift; preserve no-active-snapshot assertions.
- Preferred owner Home: same credential drift; retain exact-Home row/index and cipher-isolation assertions.
- Explicit Home override, two variants: same credential drift; preserve both retained-row origins and active-list isolation.
- Advanced Account-key UI settlement: stale inline-editor contract. Drive the existing Connect-sheet selection through the canonical Modal boundary and bind an existing unbound SavedSecret; preserve newer-Settings settlement assertions.

## Owners and historical basis

- `syncEngine.ts#ensureSessionVisibleForMessageRoute`, `engine/sessions/sessionById.ts`, and the existing scoped request/reader owners retain hydration authority.
- `api/account/apiAccountEncryptionMode.ts` and `engine/settings/accountSettingsWriteMaterial.ts` retain persisted Account-mode/currentness authority. No guard was weakened and no competing mode decision was added.
- `8ab65f04cb`: Bot display custody; `270b1ea68e`: Account resource custody; `103bb932d3`: admitted target reuse; `f8c19b1481`: transcript acquisition after visibility admission. Current restore admission also reflects `4bec84aba4`.
- UI Account-key binding follows the existing `PluginSettingAccountSecretField` → `presentConnectSheet` flow; the test uses `createModalModuleMock().module` rather than mocking internal binding logic.

## Same-shape sweep

Same-shape sweep: active E2EE credential material paired with Plain Account fixtures — 10 sites: fixed 10 / routed 0.

Scanned all 48 top-level sync suites. Five sibling suites also contained both Plain mode and encrypted fixtures: `sync.sessionMissingServerScope`, `sync.machineCensusMembership.composed`, `sync.create.initialAwaitTimeout`, `sync.sessionDraftContextBatch`, and `sync.accountChangeCatchUp.composed`. Their credential-aware/mode-specific boundaries distinguish those shapes; no additional same-shape site was established.

The nine-suite sibling run is incomplete: `sync.sessionMissingServerScope` reported 20/148 failures, then the worker exhausted its heap during AccountChange catch-up and the runner exited 1 with a closed IPC channel. These failures are unattributed, not claimed pre-existing. Route their diagnosis to Systemic/VOICE-TEST-DEBT-1108 rather than silently absorbing unrelated transcript, Machine, Stop and metadata work.

An isolated four-owner run completed: route-readiness, locked-recipient continuity and display projection passed; Settings material admission failed two migration cases at `syncSettings.materialAdmission.test.ts:99` (expected an additional currentness read and, for matching material, a POST). Route to the existing Settings owner; do not alter Voice's in-progress Settings retry implementation.

## Validation and remaining work

- Original reproduced evidence: Voice log records the 14 route-suite failures and one unhandled Account-currentness rejection.
- First lane run: 101/115 passed; an intermediate Modal factory mistake caused 12 failures and was corrected.
- Next lane run: 112/115 passed, no unhandled rejection reported. Later runs reached 114/115 after correcting the UI baseline, per-page omission fixture and restored cross-Home Account context. The extra stale UI case now follows the Connect sheet and the real bind Action, using an admitted release declaration and deriving its presentation from that declaration. Its existing intentional approval waiver now also covers binding. A blanket modal-confirmation attempt did not repair the failure and was removed.
- Final focused run: `hstack-exec -- pnpm --dir apps/ui exec vitest run sources/sync/sync.ensureSessionVisibleForMessageRoute.test.ts` exited 0: 115/115 passed, no Vitest unhandled sections. Evidence: `../evidence/sync-route-hydration-red-1108/green.log`.
- [blocked] Whole-package green: public `hstack-exec -- pnpm --dir apps/ui run typecheck` has emitted compiler failures across shared packages, including UI, CLI, SDK and triage. Its outer runner remains pending on existing session 65873; do not cancel or re-pin it. Observed diagnostic locations are in `../evidence/sync-route-hydration-red-1108/typecheck.log`; no recorded baseline exists, so no delta claim is made. Integration owner consumes the terminal `/tmp/sync-route-hydration-typecheck.exit` and repairs/routes shared diagnostics.
- Isolated adjacent owner tests: 46 passed / 2 failed across four suites; failures routed above. Broad sibling run failed/incomplete, as above.
- Adjacent paths: `runtime/orchestration/serverScopedRpc/localSessionRouteReadiness.test.ts`, `engine/sessions/sessionById.lockedContinuity.test.ts`, `engine/settings/syncSettings.materialAdmission.test.ts`, `engine/sessions/sessionSnapshot.displayProjection.test.ts`, under `apps/ui/sources/sync`. Evidence: `../evidence/sync-route-hydration-red-1108/owners.log`; the nine-suite run adds the five sibling suites named above, evidence `siblings.log`.
- Entry-loads: not run because production TypeScript is unchanged, per the brief.
- Live browser/device QA: not applicable to this test-only repair; no product UI behavior changed.
- Product mechanism delta: checks/states/error codes/timers/retries +0 / −0. One existing test file changes; this designated report is added. No production owner, bypass or compatibility path was added or removed.

Self-review: retained the meaningful route/Home isolation, locked-recipient, omission, transcript and Settings-scope assertions. The extra UI fixture uses the canonical declaration producer and Connect-sheet boundary rather than mocking internal Settings logic. Commit includes pre-existing Voice/SYNC-VISIBLE test hunks in the same file; foreign production and shared-index contents remain untouched. Documentation changes are unnecessary because production behavior is unchanged.

Residual risk: validation uses the shared moving source, including existing foreign production hunks. The sibling sweep is incomplete after OOM; 22 observed adjacent/sibling failures need separate owner diagnosis. The public typecheck has not finished; whole-package health is blocked above. No production TS was edited, no new runtime guard was added, and no existing Account-mode guard was weakened.
