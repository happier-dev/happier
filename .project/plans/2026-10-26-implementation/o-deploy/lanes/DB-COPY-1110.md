PARTIAL — admitted copy mapping and native handoff implemented; public copy/cutover and live journeys await AUTHZ source-read purpose and the preview producer.

# DB-COPY-1110

- Reader action: AUTHZ-PURPOSE-1106 supplies the admitted source-read purpose below; DB-COPY then connects the public own-server→own-server remedy first. PREVIEW-DB-1110 supplies its per-PR creation/cleanup consumer next. O-DEPLOY retains live reload ownership; no lifecycle operation was performed here.
- Owner ruling consumed: Home admits Manage on both Environments once; source backup credentials stay under source bindings, through AUTHZ's new read-only copy-source purpose. No grant path was added. Managed destination adapter comes last.
- This is an intermediate owner-local slice explicitly requested after the 08:07Z ASK, not a claim that P45 or preview database copying is complete.

## Delivered

- `packages/deployments/src/backups/preMigrationBackup.ts`: `DeploymentRestoreCopyMappingV1` records exact source and destination Environment/service/adapter/database identities. The existing resolver checks the selected original producer capture against the source mapping and the native destination against the destination mapping. Manifest, repository, configuration ownership and snapshot tags stay source-owned. Ordinary recovery still rejects a foreign capture.
- Manifest-only legacy recovery cannot establish a copy's original database identity, so explicit copy requires the retained producer capture. No manufactured or relabeled source evidence.
- `apps/cli/src/deployments/targets/ownServer/nativeRestore.ts`: the existing ID-based native entry forwards the mapping to that same resolver before factory acquisition. Staging/import/activation, stream settlement and recovery remain the existing restore lifecycle.
- `packages/deployments/src/actions/backups.test.ts`: real backup producer→receipt serialization/read→copy mapping, ordinary recovery refusal, substituted mapping refusal, and refusal of a manifest-only copy.
- `packages/deployments/src/backups/restoreLifecycle.test.ts`: real backup producer→capture→copy resolution→prepare→confirm, successful and failed import. Native boundary refuses any service effect outside the destination database and destination writers. Failed import leaves the original database and running writers in place. These are constructed native-IO tests, not loaded PostgreSQL evidence.

## Destination ownership and preview cleanup

- Observed existing owner: `teardownVolumes.ts:6–16` discovers volumes by exact Compose project label and defaults them to retain. Ordinary teardown consumes explicit reviewed volume deletion operands; no new logical-database deleter or ownership inference was added.
- PREVIEW producer seam sent by board ASK: create a dedicated preview-owned PostgreSQL service/volume and preview-only bindings; retain exact destination Environment/target/service and cleanup operands. A preview designation alone must not authorize deleting unspecified volumes.
- Preview sublane's existing teardown volume test passed 2/2 through AUTO; parent independently read the owner and its retain/delete selection. This is baseline coverage, not RED or proof of automatic preview cleanup.
- Observed missing production setup consumer: `deploymentPreviewTemplateV1.ts:10–15` stores selections; SCM `previewStatusWorkflow.ts:17–44` only reads a receipt and publishes status. `pullRequestPreviewComposeJourney.testkit.ts:55–56` explicitly does not stand in for the SCM producer. PREVIEW-DB owns the new per-PR consumer, per the owner ruling; this lane adds no scheduler or inert template selection.

## AUTHZ handoff

- Normalized proposed public operands sent by board: existing root `environmentId/targetLinkId/machineId/installationId/expectedRevision` identify DESTINATION; existing `deploymentId`, optional `backupOperationId`, and `restoreBackupId` select source receipt/run/snapshot. New `copy = { source: { environmentId, targetLinkId }, destination: { service, database } }`. This avoids repeating deploymentId inside copy.source.
- Prepare/confirm must retain identical copy operands through the existing preparation receipt. Source service/database come from its original retained capture; destination service/database are explicitly reviewed. The internal typed mapping is already implemented; public wire changes are not enabled yet.
- AUTHZ source-read purpose must allow only the admitted source Environment's selected receipt/run/content and backup-binding credential acquisition on the admitted destination Machine. It grants no source native lifecycle writes. Existing source restriction is observable at `externalActionExecutionAuthorization.ts:2363–2407`; current destination-bound acquisition is at `ownServerDeploymentExecutor.ts:363–373` (moving-source line anchors).
- Waiting for AUTHZ's exact purpose/API before consuming it; no local secret-grant implementation or permission reevaluation was added.

## Validation

- AUTO RED: mapping-red.log, 1 failed/26 skipped, exact copy returned `stale_input` instead of resolved; assertion at backups.test.ts:220. Production was edited only after this intended RED.
- AUTO final GREEN: composed-final.log, 50/50 (backups 27, restore lifecycle 23), exit 0, terminal 08:16:27Z. Includes copy success/failure and ordinary recovery neighbors.
- AUTO native regression: native-green-corrected.log, 12/12, exit 0, terminal 08:19:48Z. Earlier native-green.log collected no tests because CLI config was invoked from the wrong root; corrected invocation uses `pnpm --dir apps/cli exec vitest run --config vitest.config.ts src/deployments/targets/ownServer/nativeRestore.test.ts`.
- AUTO entry-loads.log: 11/13 passed, exit 1; project-starter export and teardown transform failed outside this lane's edits. Current source had the export again and native regression loaded teardown, so only those two graphs were rerun via the canonical exported `loadEntryGraph` owner. entry-loads-delta.log: 2/2 passed, exit 0, terminal 08:24:26Z. Combined applicable evidence covers 13/13, including required 7/7; initial failures are not hidden.
- Logs reside in `/tmp/DB-COPY-1110/`; terminal outcomes above are retained here because scratch is temporary. `git diff --check` passed on all four changed source/test paths.
- Typecheck left to the package wave. No typecheck, package build, browser QA, live copy, reload, stack lifecycle, package.json edit or shared-index write was performed. All launched checks are terminal.

## Remaining work and risk

- [blocked: AUTHZ purpose/API] Public own-server copy admission and source-bound credential acquisition; then reviewed P45 private-export/binding cutover and injected failure recovery. The original service must remain usable on failure; no successful live move is claimed.
- [blocked: per-PR producer] PREVIEW-DB creates the dedicated destination, invokes copy, and invokes retained ordinary teardown. Source isolation and automatic deletion still need composed producer and live proof.
- [deferred by owner order] Managed destination: current data-target grammar (`deploymentTargets.ts:47–57`, Neon/Supabase manifests) has project/branch/connection-secret capabilities, while the native restore sink requires a Compose activation and service exec (`nativeRestore.ts:70–101,160–181`). It is more than wiring: a destination execution adapter must establish tool execution, connection-secret custody, supported staging/integrity operations and health. Reuse the restore engine; report adapter size after own-server integration, before building it.
- Same-shape sweep: cross-Environment recovery selection — two existing production resolver callers (nativeRestore and ownServerDeploymentExecutor). Mapping is accepted only at the existing resolver/native ID seam; ordinary executor recovery/rollback callers deliberately omit it and retain same-Environment behavior. No competing resolver, storage classifier, restore engine or credential owner was introduced.
- Author self-attack: rejected manifest-only copy because source database identity would be guessed; verified destination-only native effects in success/failure tests. Source credentials remain AUTHZ-owned and are not inferred from possession of a capture. Existing native teardown already suffices, so no cleanup machinery was added.
- Attributable mechanism delta: checks +2/−0 (explicit mapping match, retained-capture requirement); states/error codes/timers/retries/caches +0/−0; production files +0/−0 (two edited), tests +0/−0 (two edited), one required report added. The mapping type is identity data, not a permission grant or store.
- Commit scope: the four touched source/test paths and this report, preserving compatible T2-DATA hunks already present (native username/redaction support; restore stderr evidence and tree-blob/S3 fixture corrections). Shared-source checks are the lane gate; package-wave HEAD coherence remains with the integration owner.
- Residual risk: no user-facing copy path is activated yet. Manage-both admission, source-purpose credential custody, real destination activation identity, binding cutover, per-PR cleanup and both live consumers remain unverified. Temporary logs may disappear; this report preserves deciding terminal results.
