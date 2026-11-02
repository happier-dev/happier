import { isDeepStrictEqual } from 'node:util';
import { isDeploymentSettledV1, projectDeploymentReviewRevisionV1, type DeploymentEnvironmentDetailV1,
    type DeploymentMachineResultV1, type DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol';
import type { OwnServerDeploymentRequest, OwnServerDeploymentResult, OwnServerDeploymentTargetHostInput, OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';
import { isOwnServerBuildReceiptComplete, requiresOwnServerBuildReceipt } from './buildReceipt';
import { normalizeNativeComposePlatform } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { admitOwnServerDeploymentSource } from './ownServerTargetAdmission';
import { MIGRATION_STEP } from './migration';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export const OWN_SERVER_CANDIDATE_CLEANUP_STEP_ID = 'own-server-candidate-cleanup';
export function recordOwnServerCandidateCleanup(row: DeploymentMachineResultV1, state: 'succeeded' | 'failed' | 'outcome_unknown'): DeploymentMachineResultV1 {
    return { ...row, steps: [...row.steps.filter(step => step.id !== OWN_SERVER_CANDIDATE_CLEANUP_STEP_ID),
        { id: OWN_SERVER_CANDIDATE_CLEANUP_STEP_ID, label: 'Remove first-deploy candidate', state }] };
}
export function projectOwnServerCandidateCleanupFailure(result: ActionExecuteFailure,
    log?: (message: string) => void): ActionExecuteFailure {
    const message = result.errorCode === 'deployment_generation_required'
        ? 'Candidate cleanup failed (deployment_generation_required).'
        : result.errorCode === 'native_service_control_unconfirmed'
            ? 'Candidate cleanup failed (native_service_control_unconfirmed).' : undefined;
    if (!message) return result;
    log?.(message);
    return { ok: false, errorCode: result.errorCode, error: message };
}

/** Ordered reference dispatch only. Each receiving daemon owns its native
 * settlement and signed row; this owner alone settles the Environment receipt. */
export async function executeOwnServerRollout(host: OwnServerDeploymentTargetHostInput, request: OwnServerDeploymentRequest,
    initial: Readonly<{ environment: DeploymentEnvironmentDetailV1; link: DeploymentTargetLinkHeaderV1;
        receipt: OwnServerDeploymentReceipt; signal: AbortSignal }>): Promise<OwnServerDeploymentResult> {
    let receipt = initial.receipt;
    const backupRecovery = request.actionId === 'deployments.rollback' && 'restoreBackupId' in request.input
        && request.input.restoreBackupId !== undefined;
    const context = request.context;
    const read = async () => receipt = await host.readReceipt({ environmentId: receipt.deployment.environmentId,
        deploymentId: receipt.deployment.id, context });
    const result = (): OwnServerDeploymentResult => ({ ok: true, environmentId: receipt.deployment.environmentId,
        revision: initial.environment.environment.revision, deploymentId: receipt.deployment.id,
        deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state });
    const current = () => receipt.deployment.state === 'running';
    const write = (state: 'running' | 'succeeded' | 'running_unverified' | 'failed' | 'cancelled' | 'outcome_unknown',
        content = receipt.content) => host.writeTransition({ environmentId: receipt.deployment.environmentId,
        deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision, state, content, context });
    const member = (machineId: string) => receipt.content.machineResults.find(row => row.machineId === machineId);
    const preserveFailure = async (machineId: string, installationId: string, phase: 'activate' | 'restore' | 'cleanup', code: string) => {
        const previous = member(machineId);
        const unknown = code === 'outcome_unknown';
        let row: DeploymentMachineResultV1 = { ...previous, machineId, installationId, steps: previous?.steps ?? [],
            actionOperationId: receipt.deployment.actionOperationId,
            activation: phase !== 'activate' ? previous?.activation ?? 'pending' : unknown ? 'outcome_unknown' : code === 'cancelled' ? 'cancelled' : 'failed',
            health: previous?.health ?? 'unknown',
            ...(phase === 'restore' ? { restoration: unknown ? 'outcome_unknown' : code === 'machine_unavailable'
                || code === 'home_unreachable' ? 'unreachable' : 'failed' } : {}) };
        if (phase === 'cleanup') row = recordOwnServerCandidateCleanup(row, unknown ? 'outcome_unknown' : 'failed');
        if (isDeepStrictEqual(previous, row) && receipt.content.failure !== undefined) return result();
        const machineResults = previous ? receipt.content.machineResults.map(value => value.machineId === machineId ? row : value)
            : [...receipt.content.machineResults, row];
        const written = await write('running', { ...receipt.content, machineResults,
            // Preserve the originating failure across compensation's later refusals.
            failure: receipt.content.failure ?? { code, phase } });
        if (written.ok) await read();
        return written;
    };
    const dispatch = async (target: DeploymentTargetLinkHeaderV1['members'][number], phase: 'activate' | 'restore' | 'observe' | 'cleanup', selectedDeploymentId: string) => {
        initial.signal.throwIfAborted();
        const before = member(target.machineId);
        const beforeRevision = receipt.deployment.revision;
        const dispatched = await host.dispatchMember!({ request, machineId: target.machineId,
            installationId: target.installationId, phase, selectedDeploymentId });
        await read();
        if (!current()) return dispatched;
        const observed = member(target.machineId);
        const cleanup = observed?.steps.find(step => step.id === OWN_SERVER_CANDIDATE_CLEANUP_STEP_ID);
        const authored = observed !== undefined && observed.installationId === target.installationId
            && observed.actionOperationId === receipt.deployment.actionOperationId
            && receipt.deployment.revision > beforeRevision && !isDeepStrictEqual(before, observed);
        const settled = phase === 'activate' ? observed?.activation !== 'pending' && observed?.activation !== 'outcome_unknown'
            : phase === 'restore' ? observed?.restoration !== undefined && observed.restoration !== 'outcome_unknown'
                : phase === 'cleanup' ? cleanup !== undefined && cleanup.state !== 'pending' && cleanup.state !== 'outcome_unknown' : false;
        // A lost transport ACK cannot withdraw a newly signed native result.
        // Initial/preserved candidate rows alone are not new execution proof.
        // A known pre-effect refusal is not accepted dispatch, even when its
        // failed member row was persisted. Preserve the incumbent operation link.
        if (!backupRecovery && !dispatched.ok && authored && settled && dispatched.errorCode !== 'plan_changed'
            && dispatched.errorCode !== 'effect_in_progress' && (phase !== 'cleanup' || cleanup?.state === 'succeeded')) return result();
        if (!dispatched.ok && phase !== 'observe') await preserveFailure(target.machineId, target.installationId, phase, dispatched.errorCode);
        return !dispatched.ok && phase === 'cleanup' ? projectOwnServerCandidateCleanupFailure(dispatched) : dispatched;
    };
    if (isDeploymentSettledV1(receipt.deployment.state) || receipt.deployment.state === 'outcome_unknown') return result();
    if (!host.dispatchMember) return { ok: false, errorCode: 'deployment_executor_unavailable', error: 'deployment_executor_unavailable' };
    if (receipt.deployment.state !== 'queued') return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
    if (!receipt.content.ownServer?.approvedInputBasis) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const rejectBeforeEffects = async (errorCode: string): Promise<OwnServerDeploymentResult> => {
        const settled = await write('failed', { ...receipt.content, failure: { code: errorCode, phase: 'admission' } });
        if (!settled.ok) return settled;
        await read();
        return receipt.deployment.state === 'failed' ? { ok: false, errorCode, error: errorCode } : result();
    };
    const uniform = async (admitCandidate: boolean) => {
        const environment = await host.readEnvironment({ environmentId: receipt.deployment.environmentId, context });
        const link = environment.targetLinks.find(value => value.targetLink.id === receipt.deployment.targetLinkId)?.targetLink;
        const approved = receipt.content.ownServer?.approvedInputBasis;
        if (!link || admitCandidate && (link.revision !== initial.link.revision || !approved
            || !isDeepStrictEqual(approved.bindings, environment.content.bindings)
            || !isDeepStrictEqual(approved.ownServer, environment.content.ownServer))) {
            throw Object.assign(new Error('deployment_conflict'), { code: 'deployment_conflict' });
        }
        if (admitCandidate && request.actionId !== 'deployments.rollback') admitOwnServerDeploymentSource(environment, receipt.content.sourceIntent);
        const selected = link.activeDeploymentId ? await host.readReceipt({ environmentId: receipt.deployment.environmentId,
            deploymentId: link.activeDeploymentId, context }) : undefined;
        if (selected && (!selected.content.images.length || selected.deployment.environmentId !== receipt.deployment.environmentId
            || !['succeeded', 'running_unverified'].includes(selected.deployment.state))) {
            throw Object.assign(new Error('rollback_image_unavailable'), { code: 'rollback_image_unavailable' });
        }
        if (selected) {
            const baseline = selected.content.ownServer?.approvedInputBasis;
            const projections = receipt.content.ownServer?.approvedInputBasis.runtimeProjections;
            if (!baseline || projections?.some(projection => {
                const selectedProjection = baseline.runtimeProjections?.find(value => value.machineId === projection.machineId
                    && value.installationId === projection.installationId);
                // A newer member's U platform is established by its native U
                // render below, never by the first member's effective vector.
                if (!selectedProjection) return false;
                return selectedProjection.services.some(service => !selected.content.images.some(image => image.service === service
                    && normalizeNativeComposePlatform(image.platform) === normalizeNativeComposePlatform(
                        selectedProjection.servicePlatforms?.find(value => value.service === service)?.platform ?? projection.platform)));
            })) throw Object.assign(new Error('rollback_image_unavailable'), { code: 'rollback_image_unavailable' });
        }
        return { link, selected };
    };
    // Read the existing pointer, never persist a second rollback target. The
    // failure branch reads current U again, without re-admitting the failed
    // candidate against edits that arrived while its rollout was running.
    let admitted: Awaited<ReturnType<typeof uniform>>;
    try { admitted = await uniform(true); }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'rollback_image_unavailable') {
            return rejectBeforeEffects('rollback_image_unavailable');
        }
        throw error;
    }
    // Joining a retained fleet requires route enrollment and the member CAS;
    // native image/health success alone cannot prove that transition.
    if (admitted.link.activeDeploymentId && admitted.link.members.some(member => member.state === 'joining')) {
        return rejectBeforeEffects('unsupported_action');
    }
    const versions = await host.readMemberVersions?.({ environmentId: receipt.deployment.environmentId,
        targetLinkId: initial.link.id, context });
    if (receipt.content.onFailure === 'rollbackAll' && !admitted.selected
        && (versions ?? receipt.content.machineResults).some(row => row.currentDeploymentId !== undefined)) {
        return rejectBeforeEffects('rollback_image_unavailable');
    }
    const started = await write('running', { ...receipt.content, ...(versions ? { machineResults: [...versions] } : {}),
        ownServer: { ...receipt.content.ownServer!, rollbackTarget: admitted.selected
            ? { deploymentId: admitted.selected.deployment.id, revision: projectDeploymentReviewRevisionV1(
                admitted.selected.content.sourceIntent, admitted.selected.content.commitSubject) } : null } });
    if (!started.ok) return started;
    await read();
    try {
        if (admitted.selected) for (const target of admitted.link.members) {
            const observed = await dispatch(target, 'observe', admitted.selected.deployment.id);
            if (!current()) return result();
            if (!observed.ok && observed.errorCode === 'outcome_unknown') return await write('outcome_unknown');
            if (!observed.ok && observed.errorCode === 'rollback_image_unavailable' && receipt.content.onFailure === 'rollbackAll') {
                return rejectBeforeEffects('rollback_image_unavailable');
            }
        }
        // Rollback reuses the selected release's immutable images. Its fresh
        // approval has no new builder outcomes and must never request a rebuild.
        if (request.actionId !== 'deployments.rollback'
            && requiresOwnServerBuildReceipt(receipt.content) && !isOwnServerBuildReceiptComplete(receipt.content)) {
            if (!host.dispatchBuild) return await write('failed', { ...receipt.content,
                failure: { code: 'deployment_executor_unavailable', phase: 'build' } });
            const beforeBuildRevision = receipt.deployment.revision;
            const buildOperationId = receipt.deployment.actionOperationId;
            const built = await host.dispatchBuild(request, receipt.deployment);
            await read();
            if (!current()) return result();
            const complete = isOwnServerBuildReceiptComplete(receipt.content)
                && receipt.deployment.actionOperationId === buildOperationId && receipt.deployment.revision > beforeBuildRevision;
            if (!complete) return await write(!built.ok && built.errorCode === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
                { ...receipt.content, failure: receipt.content.failure ?? {
                    code: built.ok ? 'deployment_image_unavailable' : built.errorCode, phase: 'build' } });
        }
        const attempted: DeploymentTargetLinkHeaderV1['members'][number][] = [];
        for (const target of initial.link.members) {
            attempted.push(target);
            const executed = await dispatch(target, 'activate', receipt.deployment.id);
            if (!current()) return result();
            const row = member(target.machineId);
            if (!executed.ok && executed.errorCode === 'outcome_unknown' || row?.activation === 'outcome_unknown') return await write('outcome_unknown');
            if (!executed.ok || row?.activation !== 'succeeded' || row.health === 'unhealthy' || row.health === 'unknown') {
                let cleanupFailure: ActionExecuteFailure | undefined;
                const migrationRan = receipt.content.steps.some(step => step.id === MIGRATION_STEP && step.state !== 'skipped');
                const migrationPolicy = initial.environment.content.ownServer?.migrationFailurePolicy;
                // Post-migration policy is independent of the no-migration
                // auto-restore setting. Ask/restore+code never become code-only.
                if (!backupRecovery && (migrationRan ? migrationPolicy === 'rollbackCodeOnly' : receipt.content.onFailure === 'rollbackAll')) {
                    const recovery = await uniform(false);
                    if (recovery.selected) {
                        // A single-runtime no-migration rollout honors its
                        // reviewed manual-recovery choice. Fleet rollbackAll
                        // still converges every admitted member to uniform U.
                        if (migrationRan || recovery.link.members.length > 1
                            || initial.environment.content.ownServer?.autoRestorePreviousRelease !== false) {
                            for (const currentMember of recovery.link.members) {
                                await dispatch(currentMember, 'restore', recovery.selected.deployment.id);
                                if (!current()) return result();
                            }
                        }
                    }
                    else for (const currentMember of attempted) {
                        const cleaned = await dispatch(currentMember, 'cleanup', receipt.deployment.id);
                        if (!cleaned.ok) cleanupFailure ??= cleaned;
                        if (!current()) return result();
                    }
                }
                const settled = await write('failed');
                if (settled.ok && cleanupFailure) return cleanupFailure;
                return settled.ok && !executed.ok && (backupRecovery || executed.errorCode === 'plan_changed'
                    || executed.errorCode === 'effect_in_progress') ? executed : settled;
            }
        }
        return await write(receipt.content.machineResults.every(row => row.health === 'healthy') ? 'succeeded' : 'running_unverified');
    } catch (error) {
        await read();
        if (!current()) return result();
        const code = readRpcErrorCode(error) ?? (error instanceof Error && 'code' in error ? error.code : undefined);
        return await write(initial.signal.aborted ? 'cancelled' : code === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
            { ...receipt.content, failure: receipt.content.failure ?? {
                code: initial.signal.aborted ? 'cancelled' : typeof code === 'string' ? code : 'deployment_failed', phase: 'activate' } });
    }
}
