VERDICT — PARTIAL: five source repairs committed; package counts remain unmeasured on the pending original handles. A rejected fixture migration failed four tests and was removed. No package-green or zero-delta claim.

FIN-TYPE-FIX-1109; FIN orchestrator; 2026-11-09.
Repository and explicit HAPPIER_STACK_REPO_DIR: `/home/leeroy.guest/.happier-stack/workspace/0.3`.
Source commit: `e5d762f4a7fcdbc7e4e26821676ae40c28d23b87`.
Read TypeScript toolchain instructions and Systemic HANDOFF posts before repairs.

Observed input and comparison basis, using only `finOwned=true` rows:

| Package | Historical FIN rows | Excluding TS6307 | Current after count |
| --- | --- | --- | --- |
| UI | 1,156 | 101 | [blocked] pending public compiler |
| CLI, historical partial | 77 | 77 | [blocked] pending public compiler |

The two historical inputs contain 119 distinct non-TS6307 location keys, not 178 distinct defects.
The five repaired files contain seven historical keys: UI seven / CLI six, with overlap.
Those are addressed source locations, not seven proven compiler removals; line movement is not resolution.
Baseline: `.project/tmp/fin-typecheck-1108/{ui,cli}.observed.locs` and ownership JSON files.
Current evidence root for every filename below: `.project/tmp/fin-type-fix-1109/`.

Retained repairs, grouped by current source root cause:

- Duplicate import: remove the second contribution-key builder import in CLI `createCliActionInventoryDeps.ts`.
- Readonly JSON narrowing: reuse Protocol `common/records#isRecord` in TriggerPopover and useTriggerScheduleCommands; preserve their existing runtime predicates.
- Callback boundary: adapt WorkflowRunComposer's press callback to `() => retry()`; the options hook retains its context-aware retry API.
- Stale type name: automationEventCurrentness uses its existing `CurrentAutomationEventContributionV1` alias instead of the missing ParsedAutomationEventContributionV1 symbol.

Current source, owner functions, callers, existing tests and same-concept helpers were inspected before each retained edit.
No new decision-maker or competing parser was introduced; duplicate builder import removed, canonical record guard reused.
No runtime contract change or new runtime test was needed. The retry event probe already passed before the adapter; it is not behavioral RED evidence.
No documentation update is needed for these static type/import corrections.

Observed focused validation:

- UI Workflow options 17/17 and trigger controls 41/41 passed (`ui-focused.log`).
- CLI inventory 8/8 passed (`cli-focused.log`, terminal exit 0).
- Server automation currentness 1/1 passed (`server-focused.log`, terminal exit 0).
- Entry loads 7/7 passed (`entry-loads.log`, terminal exit 0): preparation, daemon, CLI, Voice worker, server, UI catalog, SDK browser.

Failed attempt, removed rather than weakening the tests:
Replacing Session Board's missing createUiApprovalRequest with createAgentApprovalRequest produced four failures in `ui-focused.log`.
Agent requests require their live origin; the portable Inbox replay assumptions do not survive a name-only migration.
Only this lane's rename was removed; the prior shared test bytes and assertions are preserved.
Its historical TS2724 stays unattributed to the approval-harness/current replay contract.

Public final checks (no cancellation, timeout, compiler fallback or manual re-pin):
UI: `./apps/stack/bin/hstack-exec -- pnpm --dir apps/ui run typecheck`; original handle **53994**, `ui-typecheck.log`.
CLI: `./apps/stack/bin/hstack-exec -- pnpm --dir apps/cli run typecheck`; original handle **32677**, `cli-typecheck.log`.
Both are PENDING / NOT RUN as completed package gates; neither has a terminal exit. CLI still awaits memory admission. UI has emitted 132 dependency-producer diagnostics in `packages/plugins/triage`, outside FIN; this is not FIN coverage (`ui-current-partial.json`, canonical parser).
[blocked] Exact file:line:code before/after comparison needs those original handles to complete; compare against the observed sets above, not the worker's automatic baseline.

TS6307 ownership: Systemic's typecheck-membership/project-projection owner (`scripts/workspaces/deriveTypecheckProjects.mjs` and app adapters), with `tsrs-ui-spin-1108` owning compiler stalls. HANDOFF explicitly assigns membership errors to Systemic.
Historical UI additions contain 6,101 TS6307 rows overall, 1,055 FIN-attributed; no tsconfig or membership workaround was made.
The exact defect in the old /home/ubuntu worker projection is not re-proven by this repair lane.

Remaining 112 distinct historical keys stay unattributed pending current compiler evidence; `candidate-assessment.json` lists each exact key and current-source excerpt.
They include Channels' 16 inferred-unknown rows despite explicit provider return types, terminal source/dist declaration identities, historical/current approval widening, deployment target APIs and daemon/Sync service contracts.
Those contracts were not narrowed, cast or redesigned to make historical consumer diagnostics disappear.
Net mechanisms: checks/states/error codes/timers/retries/files +0 / −0; five existing source files changed, one duplicate import removed.
Commit used a fresh private index, matching read-tree/commit parent and CAS update-ref; exact five-path packet checked; shared index untouched. No push or Stack lifecycle action.

Residual risk: package compilation and current attribution remain unavailable; moving-source location churn must not be reported as fixes. Resume the two original handles, route current non-FIN producer failures to their owners, and continue only verified FIN repairs.
