Verdict: VERIFIED_COMPLETE for the brief’s explicit unsupported-at-selection fallback. MySQL backup/restore remains unsupported; a restore activation change needs separate authorization. Focused test 1/1, real catalog read PASS, entry-loads 13/13 across initial run plus focused retry. No typechecks; live selection copy awaits reload.
# MYSQL-BACKUP-1110

## Outcome and required action
O-DEPLOY must tell Coordination that MySQL logical backup/restore needs a separately authorized restore activation change. On the next ORCH-TOP reload, QA must confirm the MySQL selection description exposes the limitation. Do not run the requested backup→restore row journey as a supported feature.

## Observed discovery and fallback basis
- Read `briefs/PAGE-FIX-100.md` shared rules and MYSQL-BACKUP-1110; read `lanes/T2-DATA-1107.md` first for the existing PostgreSQL chain. `HAPPIER_STACK_REPO_DIR` is set explicitly on each routed command.
- `packages/deployments/src/backups/restoreLifecycle.ts:14` limits destination to `postgres-v1`; :41 and :52 capture `postgresCustom`; :159 refuses other engines/formats before native work.
- The same owner :261 creates staging with `createdb`; :265 imports through `pg_restore`; :112/:115 and :282–285 activate through PostgreSQL `ALTER DATABASE … RENAME`. These are live lifecycle operations, not a replaceable dump command declaration.
- `apps/cli/src/deployments/targets/ownServer/backupDestination.ts:133` also admits only PostgreSQL restore destinations. The existing unsupported-adapter test is `packages/deployments/src/backups/restoreLifecycle.test.ts:293`.
- Derived: adding mysqldump/mysql argv plus a catalog adapter does not provide a consumed MySQL restore. It requires changing the restore activation/lifecycle, explicitly outside this brief's adapter-only boundary. No alternate stream, custody or activation implementation was built.
- Applied the brief's explicit fallback in `packages/plugins/deployment-templates/resources/registry/apps.json:146`: “A MySQL database with internal connectivity. Backups and restore are not supported in Happier yet.” Existing `backup:false` and absent `logicalBackup` remain truthful.
- Canonical presentation path: the plugin manifest declares `resources/registry/apps.json` as its packaged Data services source; the selected Registry app feeds `useStoreAppListing`, and `StoreAppListing.tsx:206` feeds `app.description` to the existing listing prose. No MySQL-specific UI branch or second capability decider.

## Validation
- Content-only description change: no production behavior change, no new wording test or RED required. The real-MySQL RED/composed backup/restore/live-row checks belong to the adapter branch and were deliberately not attempted after the required stop condition.
- AUTO focused plugin test passed 1/1, exit 0 (`.project/tmp/MYSQL-BACKUP-1110/catalog-tests.log`).
- AUTO real catalog producer→Registry read consumer probe passed, exit 0 (`.project/tmp/MYSQL-BACKUP-1110/catalog-read-green.log`): selected MySQL is ready, returns the unsupported description, has no logicalBackup and keeps backup:false. The initial scratch probe failed because it supplied fetch instead of the registry HTTP boundary’s getJson; corrected the probe only, no product change (`catalog-read.log`).
- AUTO entry-loads completed exit 1: 11/13 passed (`.project/tmp/MYSQL-BACKUP-1110/entry-loads.log`). Two failures were missing workflow/automation exports: WorkflowAcceptedDirectSourceV1Schema and AutomationOnceScheduleSchema. Current source exports them at workflowDefinitionV1.ts:416 and automationTriggerDefinition.ts:34; the workflow and automation files have concurrent changes, and this lane did not edit them. Focused retry of both graphs passed, exit 0 (`entry-loads-retry.log`), giving passing evidence for all 13 graphs (including the required 7). Initial failures are retained, not reported as a wholly green initial run.
- Private-index commit includes only the catalog description and this report; shared index untouched. No background check remains outstanding.
- Typecheck left to the package wave; no typecheck launched.
- Loaded-runtime selection copy not yet verified: ORCH-TOP owns reloads. No stack lifecycle action, browser, database, secret or QA fixture mutation.

## Same-shape sweep and self-review
- Same-shape sweep: MySQL catalog eligibility and native restore readiness — inspected packaged MySQL entry, shared protocol adapter declaration, domain restore lifecycle, native destination admission and Store selected-app consumer. The schema can name mysql-v1, but that is not executable readiness; kept catalog backup disabled. PostgreSQL remains on its existing owner; other engine support is outside this fallback.
- Attack: considered whether generic stream reuse alone could complete restore; direct lifecycle inspection falsifies that claim because staging, format, name observation and activation remain PostgreSQL-specific. Existing catalog description suffices for selection disclosure, so no new capability field, guard, UI component or runtime branch was added.
- Net mechanism delta: +0 / −0 checks, states, error codes, timers, retries, limits, credential paths or production files. One existing catalog description changed; one requested lane report added. No canonical technical contract changed, so no documentation amendment is needed.
- Residual risk: selection-copy delivery awaits the next loaded catalog; MySQL backup/restore remains unsupported. No success or row-restoration claim is made.
