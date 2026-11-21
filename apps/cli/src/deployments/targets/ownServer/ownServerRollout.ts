import { isDeepStrictEqual } from 'node:util';
import { configuration } from '@/configuration';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createOwnServerExpectedDownPublisher } from './expectedDown';
import { projectDeploymentFailure, projectDeploymentReceiptFailure } from '../../deploymentFailure';
import { DeploymentExecutionFailureDetailsV1Schema, DeploymentReceiptFailureV1Schema, type DeploymentReceiptFailureV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { isDeploymentSettledV1, type DeploymentEnvironmentDetailV1, type DeploymentMachineResultV1, type DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/contracts/v1';
import { projectDeploymentReviewRevisionV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import type { OwnServerDeploymentRequest, OwnServerDeploymentResult, OwnServerDeploymentTargetHostInput, OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';
import { isOwnServerBuildReceiptComplete, requiresOwnServerBuildReceipt } from './buildReceipt';
import { normalizeNativeComposePlatform } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { admitOwnServerDeploymentSource, selectOwnServerRetainedServingSource } from './ownServerTargetAdmission';
import { MIGRATION_STEP } from './migration';
import { createActionExecuteFailureError, ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readDeploymentUniformTargetLinkRevisionV1 } from '../../deploymentUniformProof';

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
    return { ...result, error: message };
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
    const finishChild = async (outcome: OwnServerDeploymentResult): Promise<OwnServerDeploymentResult> => {
        // The cancel route cannot observe a running child. Once that finite
        // child returns, this controller can confirm no later stage will start.
        // A lost child outcome still cannot establish that boundary.
        if (receipt.deployment.state === 'outcome_unknown' && receipt.deployment.cancelRequestedAtMs !== undefined
            && (outcome.ok ? outcome.state !== 'outcome_unknown' : outcome.errorCode !== 'outcome_unknown')) return write('cancelled');
        return result();
    };
    const current = () => receipt.deployment.state === 'running';
    const write = (state: 'running' | 'succeeded' | 'running_unverified' | 'failed' | 'cancelled' | 'outcome_unknown',
        content = receipt.content, telemetry?: Pick<DeploymentMachineResultV1, 'telemetryMachineId' | 'telemetryTokenHash'>) => host.writeTransition({ environmentId: receipt.deployment.environmentId,
        deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision, state, content, context, ...telemetry });
    const member = (machineId: string) => receipt.content.machineResults.find(row => row.machineId === machineId);
    const projectFailure = (phase: DeploymentReceiptFailureV1['phase'], code: string, error?: unknown): DeploymentReceiptFailureV1 => {
        const projected = error === undefined ? undefined : projectDeploymentReceiptFailure(projectDeploymentFailure(code, error), phase);
        const previous = receipt.content.failure;
        const authored = previous && (previous.code !== code || previous.phase !== phase) ? previous
            : { ...projected, ...previous, code, phase };
        return DeploymentReceiptFailureV1Schema.parse(projectDeploymentFailureRecoveryV1(authored));
    };
    const preserveFailure = async (machineId: string, installationId: string, phase: 'activate' | 'restore' | 'cleanup', dispatched: ActionExecuteFailure) => {
        const code = dispatched.errorCode;
        const previous = member(machineId);
        const unknown = code === 'outcome_unknown';
        let row: DeploymentMachineResultV1 = { ...previous, machineId, installationId, steps: previous?.steps ?? [],
            actionOperationId: receipt.deployment.actionOperationId,
            activation: phase !== 'activate' ? previous?.activation ?? 'pending' : unknown ? 'outcome_unknown' : code === 'cancelled' ? 'cancelled' : 'failed',
            health: previous?.health ?? 'unknown',
            ...(phase === 'restore' ? { restoration: unknown ? 'outcome_unknown' : code === 'machine_unavailable'
                || code === 'home_unreachable' ? 'unreachable' : 'failed' } : {}) };
        if (phase === 'cleanup') row = recordOwnServerCandidateCleanup(row, unknown ? 'outcome_unknown' : 'failed');
        const failure = projectFailure(phase, code, dispatched);
        if (isDeepStrictEqual(previous, row) && isDeepStrictEqual(receipt.content.failure, failure)) return result();
        const machineResults = previous ? receipt.content.machineResults.map(value => value.machineId === machineId ? row : value)
            : [...receipt.content.machineResults, row];
        const written = await write('running', { ...receipt.content, machineResults,
            // Preserve the originating failure across compensation's later refusals.
            failure });
        if (written.ok) await read();
        return written;
    };
    const dispatch = async (target: DeploymentTargetLinkHeaderV1['members'][number], phase: 'activate' | 'restore' | 'observe' | 'cleanup', selectedDeploymentId: string) => {
        initial.signal.throwIfAborted();
        const before = member(target.machineId);
        const beforeRevision = receipt.deployment.revision;
        // Children retain their native job, not this controller's local operation
        // publisher. The admitted serial phase owns its interruption projection.
        const selected = selectedDeploymentId === receipt.deployment.id ? receipt : admitted.selected;
        const approval = selected?.content.ownServer?.approvedInputBasis;
        const identity = context.operationOwnerUpdate && (phase === 'activate' || phase === 'restore')
            && approval && approval.ownServer?.rollout !== 'startFirst'
            ? await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                serverId: host.serverId, environmentId: receipt.deployment.environmentId }).catch(() => undefined) : undefined;
        const expectation = identity ? createOwnServerExpectedDownPublisher({ serverId: host.serverId,
            environmentId: receipt.deployment.environmentId, targetLinkId: receipt.deployment.targetLinkId,
            deploymentId: receipt.deployment.id, machineId: target.machineId, installationId: target.installationId,
            environmentInstanceId: identity.environmentInstanceId, operation: 'deploy', context,
            readDomains: affectedServices => host.readExpectedDownDomains?.({ environmentId: receipt.deployment.environmentId,
                targetLinkId: receipt.deployment.targetLinkId, affectedServices, context }) ?? Promise.resolve(null) }) : undefined;
        if (expectation && approval) await expectation(approval.runtimeProjections?.find(projection =>
            projection.machineId === target.machineId && projection.installationId === target.installationId)?.services ?? approval.services);
        const dispatched = await host.dispatchMember!({ request, machineId: target.machineId,
            installationId: target.installationId, phase, selectedDeploymentId });
        await expectation?.([]);
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
            && dispatched.errorCode !== 'effect_in_progress' && (phase !== 'cleanup' || cleanup?.state === 'succeeded')) {
            // A matching authored failure may predate the child's diagnostic.
            // Enrich only that failure; a native success still wins over a lost ACK.
            if (receipt.content.failure) {
                const failure = projectFailure(phase, dispatched.errorCode, dispatched);
                if (!isDeepStrictEqual(receipt.content.failure, failure)) {
                    const written = await write('running', { ...receipt.content, failure });
                    if (!written.ok) return written;
                    await read();
                }
            }
            // This failed activation authored its cleanup step, and the
            // child response carries the separate cleanup diagnostic.
            return phase === 'activate' && cleanup?.state === 'failed' ? dispatched : result();
        }
        if (!dispatched.ok && phase !== 'observe') await preserveFailure(target.machineId, target.installationId, phase, dispatched);
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
        if (!link || admitCandidate && (!approved
            || !isDeepStrictEqual(approved.bindings, environment.content.bindings)
            || !isDeepStrictEqual(approved.ownServer, environment.content.ownServer))) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' });
        }
        const selected = link.activeDeploymentId ? await host.readReceipt({ environmentId: receipt.deployment.environmentId,
            deploymentId: link.activeDeploymentId, context }) : undefined;
        const retainedSourceIntent = selectOwnServerRetainedServingSource({ actionId: request.actionId,
            environmentId: receipt.deployment.environmentId, link, sourceIntent: receipt.content.sourceIntent, servingReceipt: selected });
        if (admitCandidate && request.actionId !== 'deployments.rollback' && !retainedSourceIntent)
            admitOwnServerDeploymentSource(environment, receipt.content.sourceIntent);
        if (selected && (!selected.content.images.length || selected.deployment.environmentId !== receipt.deployment.environmentId
            || !['succeeded', 'running_unverified'].includes(selected.deployment.state))) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'rollback_image_unavailable', error: 'rollback_image_unavailable' });
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
            })) throw createActionExecuteFailureError({ ok: false, errorCode: 'rollback_image_unavailable', error: 'rollback_image_unavailable' });
        }
        return { link: { ...link, machines: initial.link.machines, members: initial.link.members }, selected, retainedSourceIntent };
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
    const joining = admitted.selected ? admitted.link.members.filter(member => member.state === 'joining') : [];
    const joinOnly = admitted.retainedSourceIntent !== null;
    if (joinOnly) {
        const requested = receipt.content.ownServer!.approvedInputBasis;
        const serving = admitted.selected!.content.ownServer!.approvedInputBasis;
        // Membership, ingress and Environment revisions can change during Add;
        // the captured workload inputs must still describe serving U exactly.
        if (!isDeepStrictEqual(requested.bindings, serving.bindings)
            || !isDeepStrictEqual(requested.ownServer, serving.ownServer)
            || !isDeepStrictEqual(requested.services, serving.services)
            || !isDeepStrictEqual(requested.profiles, serving.profiles)
            || !isDeepStrictEqual(requested.health, serving.health)
            || !isDeepStrictEqual(requested.configInputDigests, serving.configInputDigests)
            || requested.manifestFingerprint !== serving.manifestFingerprint
            || !isDeepStrictEqual(receipt.content.services, admitted.selected!.content.services)) {
            return rejectBeforeEffects('deployment_conflict');
        }
    }
    // Keep the refusal until the deployed-current-image producer and ingress
    // owner are both mounted. Native success alone never commits membership.
    const desiredIngress = receipt.content.ingress;
    const servingIngress = admitted.selected?.content.ingress;
    const reconcileTunnelConnectorsOnly = joining.length === 0 && admitted.selected !== undefined
        && request.actionId !== 'deployments.rollback' && desiredIngress?.kind === 'cloudflareTunnel'
        && (desiredIngress.connectorsPerMachine !== undefined
            || servingIngress?.kind === 'cloudflareTunnel' && servingIngress.connectorsPerMachine !== undefined);
    if ((joining.length || reconcileTunnelConnectorsOnly) && !host.enrollMemberRoutes) {
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
    const settle = async (content = receipt.content) => {
        const delivered = content.machineResults.find(row => row.activation === 'succeeded'
            && row.currentDeploymentId === receipt.deployment.id && row.telemetryMachineId && row.telemetryTokenHash);
        const settled = await write(content.machineResults.every(row => row.health === 'healthy') ? 'succeeded' : 'running_unverified', content,
            delivered ? { telemetryMachineId: delivered.telemetryMachineId, telemetryTokenHash: delivered.telemetryTokenHash } : undefined);
        if (settled.ok || settled.errorCode === 'outcome_unknown') return settled;
        throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: settled.errorCode, error: settled.errorCode }), { cause: settled });
    };
    try {
        if (admitted.selected) {
            for (const target of joining) {
                // Join with U's retained artifacts. A distinct requested B may
                // continue through ordinary build/rollout after enrollment.
                const restored = await dispatch(target, 'restore', admitted.selected.deployment.id);
                if (!current()) return finishChild(restored);
                const row = member(target.machineId);
                if (!restored.ok && restored.errorCode === 'outcome_unknown' || row?.restoration === 'outcome_unknown') {
                    return await write('outcome_unknown');
                }
                if (!restored.ok || row?.restoration !== 'succeeded' || row.health !== 'healthy' && row.health !== 'unverified') {
                    return await write('failed', { ...receipt.content,
                        failure: projectFailure('restore', restored.ok ? 'deployment_health_failed' : restored.errorCode,
                            restored.ok ? undefined : restored) });
                }
            }
            if (joinOnly) {
                for (const target of admitted.link.members.filter(member => member.state !== 'joining')) {
                    const observed = await dispatch(target, 'observe', admitted.selected.deployment.id);
                    if (!current()) return finishChild(observed);
                    if (!observed.ok) return await write(observed.errorCode === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
                        { ...receipt.content, failure: projectFailure('restore', observed.errorCode, observed) });
                }
                const proof = readDeploymentUniformTargetLinkRevisionV1({ deploymentId: receipt.deployment.id,
                    actionOperationId: receipt.deployment.actionOperationId, targetLink: admitted.link, content: receipt.content });
                if (proof?.servingDeploymentId !== admitted.selected.deployment.id) return await write('failed', {
                    ...receipt.content, failure: projectFailure('restore', receipt.content.machineResults.some(row =>
                        row.health === 'unknown' || row.health === 'unhealthy') ? 'deployment_health_failed' : 'deployment_conflict') });
            }
            if (joining.length || reconcileTunnelConnectorsOnly) {
                // The ingress owner reconciles the complete admitted member set,
                // after every joining receiver has restored serving U.
                const enrolled = await host.enrollMemberRoutes!(request, { link: admitted.link,
                    signal: initial.signal, ...(reconcileTunnelConnectorsOnly ? { reconcileTunnelConnectorsOnly: true } : {}) });
                await read();
                if (!current()) return finishChild(enrolled);
                if (!enrolled.ok) return await write(enrolled.errorCode === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
                    { ...receipt.content, failure: projectFailure('activate', enrolled.errorCode, enrolled) });
            }
            if (joinOnly) return await settle({ ...receipt.content, images: admitted.selected.content.images,
                ownServer: { ...receipt.content.ownServer!, imageArchives: admitted.selected.content.ownServer?.imageArchives } });
        }
        if (admitted.selected) for (const target of admitted.link.members) {
            const observed = await dispatch(target, 'observe', admitted.selected.deployment.id);
            if (!current()) return finishChild(observed);
            if (!observed.ok && observed.errorCode === 'outcome_unknown') return await write('outcome_unknown',
                { ...receipt.content, failure: projectFailure('restore', observed.errorCode, observed) });
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
            if (!current()) return finishChild(built);
            const complete = isOwnServerBuildReceiptComplete(receipt.content)
                && receipt.deployment.actionOperationId === buildOperationId && receipt.deployment.revision > beforeBuildRevision;
            if (!complete) return await write(!built.ok && built.errorCode === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
                { ...receipt.content, failure: projectFailure('build', built.ok ? 'deployment_image_unavailable' : built.errorCode,
                    built.ok ? undefined : built) });
        }
        const attempted: DeploymentTargetLinkHeaderV1['members'][number][] = [];
        for (const target of initial.link.members) {
            attempted.push(target);
            const executed = await dispatch(target, 'activate', receipt.deployment.id);
            if (!current()) return finishChild(executed);
            const row = member(target.machineId);
            if (!executed.ok && executed.errorCode === 'outcome_unknown' || row?.activation === 'outcome_unknown') return await write('outcome_unknown');
            if (!executed.ok || row?.activation !== 'succeeded' || row.health === 'unhealthy' || row.health === 'unknown') {
                const details = !executed.ok ? executed.details : undefined;
                const nativeCleanup = details && typeof details === 'object' && 'cleanupFailure' in details
                    ? DeploymentExecutionFailureDetailsV1Schema.shape.cleanupFailure.safeParse(details.cleanupFailure).data
                    : undefined;
                let cleanupFailure: ActionExecuteFailure | undefined = nativeCleanup ? {
                    ok: false, errorCode: nativeCleanup.code, error: nativeCleanup.code,
                    ...(nativeCleanup.failureCause ? { failureCause: nativeCleanup.failureCause } : {}),
                } : undefined;
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
                                const restored = await dispatch(currentMember, 'restore', recovery.selected.deployment.id);
                                if (!current()) return finishChild(restored);
                            }
                        }
                    }
                    else for (const currentMember of attempted) {
                        // A failed first activation has already tried removal
                        // while it held the native generation witness.
                        if (nativeCleanup && currentMember.machineId === target.machineId) continue;
                        const cleaned = await dispatch(currentMember, 'cleanup', receipt.deployment.id);
                        if (!cleaned.ok) cleanupFailure ??= cleaned;
                        if (!current()) return finishChild(cleaned);
                    }
                }
                const settled = await write('failed');
                if (settled.ok && cleanupFailure) return cleanupFailure;
                return settled.ok && !executed.ok && (backupRecovery || executed.errorCode === 'plan_changed'
                    || executed.errorCode === 'effect_in_progress') ? executed : settled;
            }
        }
        // A known refused settlement is an execution failure, just like a
        // thrown native refusal. An uncertain transport outcome must retain
        // its existing recovery path rather than overwrite a possible commit.
        return await settle();
    } catch (error) {
        await read();
        if (!current()) return result();
        const code = readRpcErrorCode(error) ?? (error instanceof Error && 'code' in error ? error.code : undefined);
        const settled = await write(initial.signal.aborted ? 'cancelled' : code === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
            { ...receipt.content, failure: projectFailure('activate',
                initial.signal.aborted ? 'cancelled' : typeof code === 'string' ? code : 'deployment_failed', error) });
        const original = error instanceof Error ? ActionExecuteFailureSchema.safeParse(error.cause) : null;
        return settled.ok && original?.success ? original.data : settled;
    }
}
