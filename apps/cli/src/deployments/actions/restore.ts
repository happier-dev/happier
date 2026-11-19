import { isDeepStrictEqual } from 'node:util';
import type { ActionExecutorContext, ActionExecuteFailure, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import { ManagedNativeFailureDetailsV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { DeploymentBackupRestoreInputV1Schema, DeploymentBackupRestoreResultV1Schema,
    DeploymentRestoreStepV1Schema, DeploymentBackupRunResultV1Schema, readDeploymentBackupMaintenanceFailureEvidenceV1,
    DeploymentNativeSnapshotOfferV1Schema, DeploymentNativeSnapshotUnavailableV1Schema, summarizeDeploymentRestoreReviewV1, buildDeploymentRestoreRecoveryActionV1,
    type DeploymentNativeSnapshotOfferV1, type DeploymentNativeSnapshotUnavailableV1, type DeploymentBackupRestoreInputV1, type DeploymentBackupRestoreResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { MachineProvisionerSnapshotResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { OwnServerDeploymentTargetForHost } from '../targets/ownServer/ownServerDeploymentTarget';
import { OwnServerRestorePreparationForHostSchema } from '../targets/ownServer/restorePreparation';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { projectDeploymentException } from '../deploymentFailure';
import { carryActionFailureDiagnostic } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { AdmittedDeploymentRestoreUpload } from '@/transfers/targets/deploymentRestoreUpload';
import { DeploymentRestoreRecoveryPointV1Schema } from '@happier-dev/deployment-protocol';
import {
    DatabaseReadStatementInputV1Schema,
    type DatabaseReadStatementInputV1,
    type DatabaseDeploymentServiceTargetV1,
    type DatabaseOperationResultV1,
} from '@happier-dev/plugin-sdk/database';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
type Confirm = Extract<DeploymentBackupRestoreInputV1, { mode: 'confirm' }>;
type Recover = Extract<DeploymentBackupRestoreInputV1, { mode: 'recover' }>;

/** Plan45's owner-approved selector policy; no physical host or enrolled-Machine inference. */
function restoreHasRemoteEngineSelector(selection: Readonly<{ prefix: readonly string[]; env: Readonly<Record<string, string>> }>): boolean {
    const environment = new Map(Object.entries(selection.env).map(([key, value]) => [process.platform === 'win32' ? key.toUpperCase() : key, value]));
    const selected = (name: 'host' | 'context', short: string, environmentName: string) => {
        let value = environment.get(environmentName);
        for (let index = 0; index < selection.prefix.length; index++) {
            const token = selection.prefix[index]!;
            if (token === `--${name}` || token === `-${short}`) value = selection.prefix[++index];
            else if (token.startsWith(`--${name}=`)) value = token.slice(name.length + 3);
            else if (token.startsWith(`-${short}`) && token.length > 2) value = token.slice(2).replace(/^=/u, '');
        }
        return value;
    };
    const context = selected('context', 'c', 'DOCKER_CONTEXT');
    if (context && context !== 'default') return true;
    const host = selected('host', 'H', 'DOCKER_HOST');
    return !!host && !/^(?:unix|npipe):/iu.test(host);
}

/** Public restore consumes its retained prepare Action and the incumbent native lifecycle. */
export function createDeploymentRestoreActionForHost(host: Readonly<{
    serverId: string;
    machineId: string;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    readPreparation?(operationId: string, context: ActionExecutorContext): Promise<ActionOperationSnapshotV1 | null>;
    readBackupOperations?(target: Parameters<HostActionOperationRuntime['readDeploymentBackupOperations']>[0]['target'],
        context: ActionExecutorContext): ReturnType<HostActionOperationRuntime['readDeploymentBackupOperations']>;
    acquireUpload?(input: Readonly<{ transferId: string; environmentId: string }>, context: ActionExecutorContext):
        Promise<Readonly<{ source: AdmittedDeploymentRestoreUpload; release(): void }> | null>;
    nativeSnapshot?: Readonly<{
        read(input: DeploymentBackupRestoreInputV1, context: ActionExecutorContext): Promise<DeploymentNativeSnapshotOfferV1 | null>;
        execute(request: Readonly<{ input: Confirm; offer: DeploymentNativeSnapshotOfferV1; label: string; reason: string;
            context: ActionExecutorContext }>): Promise<MachineProvisionerSnapshotResultV1 | ActionExecuteFailure>;
    }>;
    restore: OwnServerDeploymentTargetForHost['restore'];
    checkData?(request: DatabaseReadStatementInputV1 & { target: DatabaseDeploymentServiceTargetV1 },
        input: Confirm, context: ActionExecutorContext): Promise<DatabaseOperationResultV1>;
}>) {
    const readRecovery = async (input: Recover, context: ActionExecutorContext) => {
        // The existing operation reader enforces requester and Machine custody.
        const operation = await host.readPreparation?.(input.operationId, context);
        const result = DeploymentBackupRestoreResultV1Schema.safeParse(operation?.result);
        if (operation?.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || operation.state !== 'succeeded'
            || !result.success || result.data.kind !== 'recoveryRequired'
            || !buildDeploymentRestoreRecoveryActionV1(input, input.operationId, result.data.nextAction)) {
            return failure('restore_recovery_required');
        }
        const point = DeploymentRestoreRecoveryPointV1Schema.safeParse(result.data.evidence);
        if (!point.success || point.data.destination.adapter !== 'volume-v1') return failure('restore_recovery_required');
        const { destination, source } = point.data;
        if (destination.environmentId !== input.environmentId || destination.revision !== input.expectedRevision
            || (source.kind === 'upload' ? input.source.kind !== 'upload' || source.transferId !== input.source.transferId
                : input.source.kind !== 'repository' || source.snapshot.snapshotId !== input.source.snapshotId)
            || (input.destination && (input.destination.kind !== 'volume' || input.destination.service !== destination.service
                || input.destination.volume !== destination.volume))
            || (result.data.recovery && !isDeepStrictEqual(result.data.recovery.input, input))) return failure('stale_input');
        return { recovery: { ...point.data, destination } };
    };
    const readRetained = async (input: Confirm, context: ActionExecutorContext) => {
        const operation = await host.readPreparation?.(input.prepareOperationId, context);
        const result = DeploymentBackupRestoreResultV1Schema.safeParse(operation?.result);
        if (operation?.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || operation.state !== 'succeeded'
            || !result.success || result.data.kind !== 'prepared' || result.data.operationId !== input.prepareOperationId) {
            return failure('restore_prepare_required');
        }
        const evidence = result.data.evidence;
        if (!isRecord(evidence)) return failure('restore_prepare_required');
        const original = DeploymentBackupRestoreInputV1Schema.safeParse(evidence.input);
        const { prepareOperationId: _prepareOperationId, snapshot: _snapshot, snapshotReview: _snapshotReview, ...operands } = input;
        if (!original.success || original.data.mode !== 'prepare'
            || !isDeepStrictEqual(original.data, { ...operands, mode: 'prepare' })) return failure('stale_input');
        const native = OwnServerRestorePreparationForHostSchema.safeParse(evidence.native);
        if (!native.success || native.data.prepared.operationId !== input.prepareOperationId) return failure('restore_prepare_required');
        const snapshot = evidence.snapshot === undefined ? null : DeploymentNativeSnapshotOfferV1Schema.safeParse(evidence.snapshot);
        if (snapshot && !snapshot.success) return failure('restore_prepare_required');
        return { native: native.data, snapshot: snapshot?.success ? snapshot.data : null };
    };
    const prepare = async (request: Readonly<{ input: DeploymentBackupRestoreInputV1; context: ActionExecutorContext }>) => {
        const { input, context } = request;
        if (input.mode === 'prepare') return { input, preview: normalizeStrictJsonValue({}) };
        if (input.mode === 'recover') {
            const retained = await readRecovery(input, context);
            if ('errorCode' in retained) return retained;
            return { input, preview: normalizeStrictJsonValue({ summary: summarizeDeploymentRestoreReviewV1(input) }) };
        }
        // Presentation reads the retained offer; exact operand/native admission stays at execute.
        const operation = await host.readPreparation?.(input.prepareOperationId, context);
        const result = DeploymentBackupRestoreResultV1Schema.safeParse(operation?.result);
        if (operation?.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || operation.state !== 'succeeded'
            || !result.success || result.data.kind !== 'prepared' || result.data.operationId !== input.prepareOperationId
            || !isRecord(result.data.evidence))
            return failure('restore_prepare_required');
        const raw = result.data.evidence.snapshot;
        const parsed = raw === undefined ? null : DeploymentNativeSnapshotOfferV1Schema.safeParse(raw);
        if (parsed && !parsed.success) return failure('restore_prepare_required');
        const offer = parsed?.success ? parsed.data : null;
        const { snapshotReview: _suppliedReview, ...authored } = input;
        const reviewed = offer ? { ...authored, snapshot: input.snapshot !== false, snapshotReview: offer } : authored;
        const unavailable = DeploymentNativeSnapshotUnavailableV1Schema.safeParse(result.data.evidence.snapshotUnavailable);
        const summary = summarizeDeploymentRestoreReviewV1(reviewed, unavailable.success ? unavailable.data : null);
        return { input: reviewed, preview: normalizeStrictJsonValue({ summary, snapshot: offer,
            ...(unavailable.success ? { snapshotUnavailable: unavailable.data } : {}) }) };
    };
    const execute = async (input: DeploymentBackupRestoreInputV1, context: ActionExecutorContext): Promise<DeploymentBackupRestoreResultV1 | ActionExecuteFailure> => {
        let upload: Awaited<ReturnType<NonNullable<typeof host.acquireUpload>>> = null;
        let snapshot: MachineProvisionerSnapshotResultV1 | undefined = context.operationAcceptance?.previousRestoreSnapshot;
        const refuse = (code: string): ActionExecuteFailure => ({ ...failure(code),
            ...(snapshot ? { details: normalizeStrictJsonValue({ steps: [], snapshot }),
                ...(snapshot.kind === 'confirmed' ? { effectAttempted: true } : {}) } : {}) });
        try {
            const check = input.mode !== 'recover' && input.dataCheck !== undefined
                ? DatabaseReadStatementInputV1Schema.safeParse(input.dataCheck) : null;
            if (check && (!check.success || check.data.target.kind !== 'deployment_service')) return refuse('invalid_input');
            const dataCheck = check?.success && check.data.target.kind === 'deployment_service'
                ? { ...check.data, target: check.data.target } : undefined;
            if (dataCheck && (input.destination?.kind !== 'database'
                || dataCheck.target.environment.serverId !== input.serverId
                || dataCheck.target.environment.environmentId !== input.environmentId
                || dataCheck.target.targetLinkId !== input.targetLinkId
                || dataCheck.target.serviceId !== input.destination.service
                || dataCheck.target.database !== input.destination.database)) return refuse('target_mismatch');
            await host.assertCurrent(context);
            if (input.serverId !== host.serverId || input.machineId !== host.machineId
                || readInstallationIdentityIfExistsSync()?.installationId !== input.installationId) return refuse('target_mismatch');
            const acceptance = context.operationAcceptance;
            if (!acceptance || acceptance.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1) return refuse('service_operation_unavailable');
            const projectResult = (result: Exclude<Awaited<ReturnType<typeof host.restore>>, { kind: 'prepared' }>) => {
                if ('evidence' in result) return DeploymentBackupRestoreResultV1Schema.parse(result);
                const recovery = result.kind === 'recoveryRequired' ? buildDeploymentRestoreRecoveryActionV1(input,
                    acceptance.operationId, result.nextAction) : undefined;
                return DeploymentBackupRestoreResultV1Schema.parse({ kind: result.kind, steps: result.steps,
                    verified: result.verified, nextAction: result.nextAction, ...('integrity' in result ? { integrity: result.integrity } : {}),
                    ...(recovery ? { recovery } : {}),
                    evidence: normalizeStrictJsonValue({ ...result, ...(snapshot ? { snapshot } : {}) }) });
            };
            if (input.mode === 'recover') {
                const retained = await readRecovery(input, context);
                if ('errorCode' in retained) return refuse(retained.errorCode);
                const result = await host.restore({ input, context, recovery: retained.recovery });
                return result.kind === 'prepared' ? refuse('restore_recovery_required') : projectResult(result);
            }
            if (input.source.kind === 'upload') {
                upload = await host.acquireUpload?.({ transferId: input.source.transferId, environmentId: input.environmentId }, context) ?? null;
                if (!upload) return refuse('restore_upload_unavailable');
            }
            if (input.mode === 'prepare') {
                let backup: Parameters<typeof host.restore>[0]['backup'];
                if (input.source.kind === 'repository' && input.source.backupOperationId) {
                    const source = input.source;
                    const operations = await host.readBackupOperations?.({ ...input, ...source.origin }, context);
                    if (!operations) return refuse('service_operation_unavailable');
                    const selected = operations.find(({ snapshot }) => snapshot.operationId === source.backupOperationId
                        && snapshot.actionId === DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 && snapshot.state === 'succeeded');
                    const result = DeploymentBackupRunResultV1Schema.safeParse(selected?.snapshot.result);
                    const manifest = result.success && result.data.operationId === source.backupOperationId
                        ? result.data.manifests.find(item => item.snapshot.snapshotId === source.snapshotId) : undefined;
                    if (!manifest) return refuse('backup_required');
                    const capture = result.success ? result.data.restoreCaptures?.find(item => isDeepStrictEqual(item.source, manifest)) : undefined;
                    backup = { manifest, ...(capture ? { capture } : {}) };
                }
                let offer: DeploymentNativeSnapshotOfferV1 | null = null;
                let snapshotUnavailable: DeploymentNativeSnapshotUnavailableV1 | undefined;
                const result = await host.restore({ input, context, ...(backup ? { backup } : {}), ...(upload ? { upload: upload.source } : {}),
                    async reviewNativeSnapshot({ destination, selection }) {
                        if (!destination.hasMeaningfulData) return;
                        if (restoreHasRemoteEngineSelector(selection)) {
                            snapshotUnavailable = { code: 'restore_snapshot_remote_engine' };
                            return;
                        }
                        offer = await host.nativeSnapshot?.read(input, context) ?? null;
                    } });
                if (result.kind !== 'prepared') return refuse('restore_prepare_required');

                return { kind: 'prepared', operationId: acceptance.operationId,
                    ...(result.prepared.steps ? { steps: [...result.prepared.steps] } : {}),
                    evidence: normalizeStrictJsonValue({ input, native: { prepared: result.prepared, ...('configuration' in result ? { configuration: result.configuration } : {}) },
                        ...(offer ? { snapshot: offer } : {}), ...(snapshotUnavailable ? { snapshotUnavailable } : {}) }) };
            }
            const retained = await readRetained(input, context);
            if ('errorCode' in retained) return refuse(retained.errorCode);
            if (!isDeepStrictEqual(input.snapshotReview ?? null, retained.snapshot)) return refuse('stale_input');
            if (input.snapshot === true && !retained.snapshot) return refuse('snapshot_unavailable');
            if (retained.snapshot && input.snapshot !== false) {
                if (!host.nativeSnapshot) return refuse('snapshot_unavailable');
                const result = await host.nativeSnapshot.execute({ input, offer: retained.snapshot,
                    label: `happier-restore-${acceptance.operationId}`, reason: `Before replacing data in ${input.environmentId}`, context });
                const nativeFailure = 'ok' in result ? result : undefined;
                const nativeDetails = nativeFailure ? ManagedNativeFailureDetailsV1Schema.safeParse(nativeFailure.details) : undefined;
                snapshot = 'kind' in result ? result : { kind: 'unknown', code: result.errorCode,
                    ...(nativeDetails?.success ? { nativeCause: nativeDetails.data.nativeCause } : {}) };
                if (snapshot.kind !== 'confirmed') {
                    context.operationOwnerUpdate?.update({ domainRef: { kind: 'deployment', serverId: input.serverId,
                        environmentId: input.environmentId, deploymentId: input.deploymentId },
                        observation: { kind: 'review_required', code: 'restore_snapshot_not_confirmed', snapshot } });
                    const refused = nativeFailure ?? failure('restore_snapshot_not_confirmed');
                    return carryActionFailureDiagnostic({ ...refused, details: normalizeStrictJsonValue({
                        ...(isRecord(refused.details) ? refused.details : {}), steps: [], snapshot,
                    }) }, refused);
                }
            }
            const confirmed = await host.restore({ input, context, prepared: retained.native, ...(upload ? { upload: upload.source } : {}) });
            if (confirmed.kind === 'prepared') return refuse('restore_prepare_required');
            const restored = projectResult(confirmed);
            if (restored.kind !== 'restored' || !dataCheck) return restored;
            let checked: DatabaseOperationResultV1;
            try {
                checked = host.checkData ? await host.checkData(dataCheck, input, context)
                    : { ok: false, status: 'unavailable', code: 'database_unavailable', reason: 'database_unavailable' };
            } catch (error) {
                const projected = projectDeploymentException(error, { signal: context.signal, phase: 'deployment.restore.dataCheck' });
                checked = context.signal?.aborted ? { ok: false, status: 'cancelled', code: 'database_cancelled' }
                    : { ok: false, status: 'unavailable', code: projected.errorCode, reason: projected.errorCode };
            }
            // The restore's outcome remains true even when the subsequent read is unavailable or incomplete.
            return { ...restored, evidence: normalizeStrictJsonValue({
                ...(isRecord(restored.evidence) ? restored.evidence : {}), dataCheck: checked,
            }) };
        } catch (error) {
            const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
            const steps = isRecord(details) && Array.isArray(details.steps) ? details.steps.flatMap(value => {
                const step = DeploymentRestoreStepV1Schema.safeParse(value); return step.success ? [step.data] : [];
            }) : [];
            const projected = projectDeploymentException(error, { signal: context.signal, phase: `deployment.restore.${input.mode}` });
            const nativeFailure = readDeploymentBackupMaintenanceFailureEvidenceV1(error)?.nativeFailure;
            const { effectAttempted: nativeEffectAttempted, ...projectedFailure } = projected;
            const effectAttempted = snapshot?.kind === 'confirmed' ? true
                : nativeEffectAttempted === false && (snapshot?.kind === 'unknown' || snapshot?.kind === 'failed')
                    ? undefined : nativeEffectAttempted;
            return carryActionFailureDiagnostic({ ...projectedFailure, ...(effectAttempted === undefined ? {} : { effectAttempted }),
                ...(steps.length || nativeFailure || snapshot ? { details: {
                ...(isRecord(projected.details) ? projected.details : {}), steps,
                ...(nativeFailure ? { nativeFailure } : {}), ...(snapshot ? { snapshot } : {}),
            } } : {}) }, projected);
        } finally { upload?.release(); }
    };
    return Object.assign(execute, { prepare });
}
