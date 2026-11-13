# CLOUD-A-PLACEMENT-1113 — DIAGNOSED; no placement fix justified

**Verdict:** exact historical refusal recovered: `managed_acquire_unavailable` / `invalid_request`. Both supplied acquisitions select Agent37 `kind:default` (Container), `region:eu`, which the provider declaration rejects. This is an invalid launch, not evidence that a healthy controller is unavailable. No production change, daemon, stack lifecycle or paid-resource operation was performed. The requested valid stopped-daemon `daemon_unavailable` outcome remains **[blocked]**: these invalid requests never reach the availability decision; a valid-input replay is required and was not authorized under this lane's no-paid-resources rule.

## Observed evidence

- Local stack log `~/.happier/stacks/agent-qa-l12-c/logs/run.1794593420086.log:27943`: request `r126p-cloud-daemon-stopped`, 2026-11-13 **18:24:06.468Z**, phase `placement_refusal`, branch `managed_acquire_unavailable`, code `invalid_request`.
- Same local log **:43029**: `r126p-cloud-create-exact`, **18:26:45.885Z**, identical phase/branch/code. Addressed Machine was A's `1f90dbd5` in both.
- Independent nl3 stack log `/home/happier/.happier/dev-targets/nl3/stack-state/agent-qa-l12-c/logs/run.1794593455955.log:27678,42597` contains the same two events. Read using `hstack-exec --target=nl3`; current `server.log` alone did not retain them.
- `qa-shots5/r126p/cloud-{daemon-stopped-input,create-input,input}.json` all specify `{size:"2-4",kind:"default",region:"eu"}`. `cloud-{daemon-stopped,create-exact}.json` expose only `target_unavailable`.
- `qa-shots5/r126p/agent37-options.json`, `data.constraints`: image `default` requires location `us`; `vm` and `performance` allow `eu`. The original options response itself contradicts the submitted combination.
- nl3 A daemon log `cli-identities/qb-acct-a/logs/2026-11-13-19-24-26-pid-3541636-daemon.log:45` records successful daemon start at local **19:24:47.703** (18:24:47.703Z), between the two refusals. C log `cli-identities/qb-acct-c/logs/2026-11-13-19-13-40-pid-3334063-daemon.log:53` records its successful start. Narrow searches for both exact request ids found **zero matches in either daemon log**. This supports, but alone does not prove, pre-forwarding refusal.

## Owner and causal path

1. CLI authored-controller placement reaches server `apps/server/sources/app/api/socket/externalActionDispatcher.ts:888`, which calls `admitManagedAcquire` **before** machine availability resolution (:960).
2. `apps/server/sources/app/machines/managed/managedAcquire.ts:93` validates the one-off launch through `validateManagedLaunchInTx`.
3. `machinePresetService.ts:236,254` routes controller-bound launch validation into `validateManagedPresetLaunchChoices`.
4. **Refusal owner:** `apps/server/sources/app/machines/managed/machinePresetSave.ts:23–29` validates the provider's launch schema and throws `ManagedMachineError('invalid_request')` when parsing fails.
5. **Provider fact owner:** `packages/plugins/machine-agent37/src/machine/kinds.ts:7–9` permits Container only in `us`; `schemas.ts:25–26` derives the launch union from those same kinds. This is one shared owner, not a placement-specific provider list.
6. **Visible-code projection:** `externalActionDispatcher.ts:902–915` catches `ManagedMachineError`; for the non-v1 response path, all errors except permission/limit become `target_unavailable`, while logging the original code in `refusalCode`. That projection explains why the client loses the actionable `invalid_request` reason.

**Derived:** schema validation is sufficient to reject both exact inputs before daemon availability is evaluated. The historical logs identify the broad invalid-request refusal, not a schema-issue path or stack trace; the provider constraint and current schema reproduction establish the concrete invalid choice. No claim is made that the historical loaded schema bytes were independently recovered.

## Why options passes

`packages/plugins/machine-agent37/src/machine/options.ts:6–24` returns available dimensions and kind-specific constraints; it does not accept this submitted launch. The catalog permits Europe for other kinds, so returning Europe is correct. Its canonical selection projector and launch schema both reject Container/Europe. The successful options read establishes catalog access, not launch validity, acquisition admission or daemon availability. No controller stripping, admission bypass or region broadening is justified.

## Verification and disposition

- Direct source probe of `Agent37LaunchSchema.safeParse`: Container/Europe **rejected**; Container/US **accepted**; VM/Europe **accepted**. All three assertions passed. No network/provider call.
- Existing focused options test **PASS, 2/2**, exit 0: from `packages/plugins/machine-agent37`, `../../../apps/stack/bin/hstack-exec --local -- pnpm exec vitest run src/machine/options.test.ts`. Includes the discriminating “admits VM and Performance outside the US and excludes default containers there” case. Initial root-directory invocation found no tests because this package config includes `src/**/*.test.ts` relative to the working directory; exit 1 was a harness invocation failure, corrected by the package-directory run.
- Initial adapter probe **did not run**: guessed `json-schema-validation.ts` filesystem path does not exist (the package export resolves `jsonSchemaValidation.ts`). Corrected probe used the actual provider schema directly.
- No RED/GREEN implementation cycle: no production edit was justified by this invalid-input incident. No typecheck/build/live replay; no source changed. Net production mechanism delta: checks/states/error codes/timers/retries/files **+0 / −0**.
- Self-attack: checked neighbouring valid Container/US and VM/Europe, compared original options constraints, and correlated both server copies plus A/C daemon logs. These falsify the initial daemon-offline explanation for the observed invalid launch. Existing broad error projection is retained, not certified correct; changing public refusal semantics or admission ordering requires a separate scoped correction with its own deciding test.

**Next action / residual risk:** Fork C should prepare a valid Container/US choice through the canonical projector, then perform its separately authorized stopped-daemon test before any paid submission. Expected contract remains typed `daemon_unavailable`; this lane has not verified or fixed it. Do not retry the invalid Europe Container, infer provider outage from these refusals, or claim cloud lifecycle success. No Boat record was touched. This lane stops under the instruction to report when the cause is outside managed-machine placement.
