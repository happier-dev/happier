IMPLEMENTED_NOT_VERIFIED — engine owner fix and stale provider-query test correction are in the shared worktree; commit and F3 completion are pending.

# DBW-ENGINE-CONFLICT-1118

## Owned changes

- `packages/databases/src/{postgresql,mysql,sqlite}/operations.ts`: on a zero-row update only, query existence by the compiled primary-key values. Missing key returns `row_missing`; an existing key returns `row_changed`. Success paths perform no extra query. Delete and non-zero row-count behavior remain unchanged.
- `apps/cli/src/plugins/runtime/invocation/targetActionRegistry.test.ts`: replaced the retired provider-specific Supabase query admission test with a manifest assertion that provider contributions remain data-only after the generic database Action migration. This removes the DBW-caused `Missing qualified Supabase query declaration` failure.

## Validation

- Database operation unit fixtures passed through `hstack-exec`: PostgreSQL 2/2, MySQL 8/8, SQLite 2/2.
- F3 composed PostgreSQL run is still queued in the routed executor, so the required post-fix F3 result is pending.
- Focused CLI registry run: the replacement test passed. The run still had one unrelated pre-existing `managedServices.observeWorkload` failure in the moving shared test file.

## Adjacent audit (20 failures from `adjacent.log`)

| Test | Attribution and cause |
|---|---|
| `fetch/service.test.ts` traced HTTP stage | Unattributed; `98c9e76e04c` owns finite HTTP acknowledgment retention and the current record remains empty. |
| `actionExecutor.test.ts` requester rejection | Unattributed; `6b852d9d5827` owns final failure projection, which now reports `plugin_action_execution_failed`. |
| Supabase purpose HTTP: principal | Unattributed; pre-DBW credential-principal admission emits `failed/deployment_access_denied`. |
| Supabase purpose HTTP: native | Unattributed; pre-DBW provider-identity admission emits `failed/deployment_access_denied`. |
| Supabase purpose HTTP: source | Unattributed; pre-DBW link-identity admission emits `failed/target_mismatch`. |
| Supabase purpose HTTP: author | Unattributed; pre-DBW link-author admission emits `failed/deployment_access_denied`. |
| Neon purpose HTTP: principal | Unattributed; pre-DBW credential-principal admission emits `failed/deployment_access_denied`. |
| Neon purpose HTTP: native | Unattributed; pre-DBW provider-identity admission emits `failed/deployment_access_denied`. |
| Neon purpose HTTP: source | Unattributed; pre-DBW link-identity admission emits `failed/target_mismatch`. |
| Neon purpose HTTP: author | Unattributed; pre-DBW link-author admission emits `failed/deployment_access_denied`. |
| Semantic Neon statement Action | DBW commit `8ed8daff0bb` owns the migrated generic Action fixture; current result is `plugin_action_generation_retired/subject_kind_unavailable`. Existing DBW-DEPLOYQ audit records this as separately fixed, so this captured log is stale against current source. |
| Stored deployment role custody: principal | Unattributed; unchanged credential-principal admission emits `failed/deployment_access_denied`. |
| Stored deployment role custody: scope | Unattributed; unchanged provider-environment admission emits `failed/deployment_access_denied`. |
| Managed byte custody `refused=true` | Unattributed; `e504c9d3773e` added `requestId` to the warning and exact test equality was not updated. |
| Optional Connected Accounts authorization | Unattributed; canonical form-input validation now returns `plugin_action_form_connected_account_options_unavailable`. |
| `writesLocal` current intent | Unattributed; canonical CLI direct default `0977297e5cfe` executes, while the old test expects Ask. |
| Desired-generation recheck | Unattributed; admitted-operands contract `6b852d9d5827` removed the policy re-read. |
| Applied-generation recheck | Unattributed; same admitted-operands contract removed the policy re-read. |
| Retired provider-query declaration | DBW commit `8ed8daff0bb` removed the legacy Supabase query Action. The owner-level test now asserts the data-only contribution. |
| `databaseEngines` service-family assertion | DBW commit `d0a3c489da4` added the service. The shared moving worktree already contains the catalog-derived descriptor iteration, which removes the hand-copied family assumption. |

## Evidence and residual risk

`git blame` and `git log` identify the DBW causes above. The 18 remaining failures are retained as unattributed with their owner/cause rather than changing unrelated admission or intent contracts. The F3 routed run and the required partial commit gate remain outstanding.
