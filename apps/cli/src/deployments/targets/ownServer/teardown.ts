import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DeploymentChildRpcV1Schema, type DeploymentChildRpcV1, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createActionExecuteFailureError, ActionExecuteFailureSchema, projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildDeploymentTeardownInputV1, DeploymentTeardownNothingDeployedInputV1Schema,
    type DeploymentTeardownInputV1, type DeploymentTeardownRefusalDetailsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentOwnServerContentV1Schema, type DeploymentContentV1, type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1, type DeploymentOwnServerContentV1, type DeploymentReceiptHeaderV1 } from '@happier-dev/deployments/contracts/v1';
import { type DeploymentTeardownResourceV1 } from '@happier-dev/protocol/deployments/deploymentTeardownContentV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { observeNativeCaddyRetainedNetwork } from '@happier-dev/cli-common/machineSetup';
import { configuration } from '@/configuration';
import { createNativeComposeIncumbentBindReader } from '@/daemon/local/services/launch/nativeComposeSharedData';
import { logger } from '@/ui/logger';
import { authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readNativeComposeEngine } from '@/daemon/local/services/launch/nativeComposeEngine';
import { removeWitnessedContainers, resolveNativeComposeCandidateProjectName } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { readNativeComposeDeploymentImageReferences, removeNativeComposeDeploymentImageReferences } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { removeUnusedNativeComposeNetworks } from '@/daemon/local/services/launch/nativeComposeNetworks';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { createDeploymentTeardownExecutor, DeploymentTeardownObservationSchema, selectDeploymentTeardownStepResources, type DeploymentTeardownBoundary } from '../../actions/teardown';
import type { DeploymentReceiptDispatchV1 } from '../../createCliDeploymentActionDeps';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { projectOwnServerEnvironmentRemovalArchiveOrigins, retireEmptyOwnServerDeploymentEnvironment } from './releaseRetention';
import { retireOwnServerImageArchiveOriginsForHost } from './releaseProvenance';
import { createDeploymentLiveReferencesForHost } from '../../readReceiptForHost';
import { projectDeploymentException } from '../../deploymentFailure';
import { admitOwnServerDeploymentTargetLink } from './ownServerTargetAdmission';
import { readOwnServerTeardownVolumes, observeOwnServerTeardownVolumes, settleOwnServerTeardownVolumes } from './teardownVolumes';
import { DeploymentTeardownPreviewV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentTeardownRequestInputV1 } from '@happier-dev/protocol/deployments/deploymentTeardownRequestV1';

type Reference = Pick<DeploymentTeardownInputV1, 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;
type Host = OwnServerDeploymentTargetHostInput & Readonly<{
    readHistoryHeaders(request: Parameters<NonNullable<OwnServerDeploymentTargetHostInput['readBuildHistory']>>[0]): AsyncIterable<DeploymentReceiptHeaderV1>;
    findReceipt(input: Pick<DeploymentTeardownInputV1, 'environmentId' | 'targetLinkId' | 'requestKey'>,
        context: ActionExecutorContext): Promise<DeploymentReceiptDetailV1 | null>;
    sendChild?(job: DeploymentChildRpcV1, context: ActionExecutorContext): Promise<unknown>;
    createCandidate(environment: DeploymentEnvironmentDetailV1, content: DeploymentContentV1,
        context: ActionExecutorContext): Promise<Reference>;
}>;
const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
const unsupported = (reason: DeploymentTeardownRefusalDetailsV1['reason'], remedy: DeploymentTeardownRefusalDetailsV1['remedy'], error: unknown = new Error('unsupported_action'), requiredFact?: string): ActionExecuteFailure => ({
    ...failure('unsupported_action'), details: { reason, remedy, ...(requiredFact === undefined ? {} : { requiredFact }) }, effectAttempted: false,
    failureCause: projectActionFailureCauseV1(error, 'deployment.teardown.admission'),
});
const inventory = (environmentId: string, machineId: string) => [{ id: environmentId, kind: 'workload' as const,
    machineId, ownership: 'owned' as const, disposition: 'remove' as const }];
type NativeRuntime = Awaited<ReturnType<NonNullable<OwnServerDeploymentTargetHostInput['runtime']['acquireTeardownReview']>>>;
function nativeRunner(runtime: NativeRuntime, context: ActionExecutorContext) {
    return async (args: readonly string[]) => {
        await runtime.assertCurrent();
        const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-teardown', cwd: runtime.deploymentRoot });
        const launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args, cwd: runtime.deploymentRoot }, { agentIsolation: null });
        try {
            await launch.recheckInputs?.();
            return await runtime.nativeIo.run({ command: launch.command, args: launch.args, cwd: runtime.deploymentRoot,
                env: launch.env, ...(context.signal ? { signal: context.signal } : {}) });
        } finally { await launch.release(); }
    };
}

/** Native workload and explicitly selected volume removal use the existing receipt and signed proof owner. */
type ReviewedNativeVolume = DeploymentTeardownResourceV1 & { displayName?: string };

export function createOwnServerTeardownForHost(host: Host) {
    const selectMembers = (input: Readonly<{ machines?: readonly string[] }>,
        link: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink']) =>
        (input.machines ?? link.machines).map(machineId => {
            const member = link.members.find(member => member.machineId === machineId);
            if (!member) throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' });
            return member;
        });
    const select = (environment: DeploymentEnvironmentDetailV1, targetLinkId: string, requiresNative = true) => {
        const row = environment.targetLinks.find(item => item.targetLink.id === targetLinkId);
        if ((requiresNative && !host.runtime.acquireTeardown) || !host.readBuildHistory) return unsupported('native_executor_unavailable',
            'Update the target Machine daemon to a version that supports native teardown, then prepare a new review.');
        if (!row) return unsupported('target_link_unavailable', 'Refresh the Environment and prepare teardown for its current target link.');
        if (row.content?.nativeOrigin) return unsupported('imported_workload',
            'Remove the imported workload through its native owner before detaching its target link.');
        try {
            admitOwnServerDeploymentTargetLink(row.targetLink, host.machineId, environment.environment.controllerMachineId);
            return row.targetLink;
        }
        catch (error) { return unsupported('target_placement_unsupported',
            'Run teardown on the recorded controller or a native target Machine.', error,
            `controllerMachineId=${environment.environment.controllerMachineId}`); }
    };
    const readVolumes = async (input: DeploymentTeardownRequestInputV1, context: ActionExecutorContext,
        environment: DeploymentEnvironmentDetailV1, localOnly = false): Promise<ReviewedNativeVolume[] | ActionExecuteFailure> => {
        const targetLinkId = input.targetLinkId ?? environment.environment.runtimeTargetLinkId;
        const link = targetLinkId ? select(environment, targetLinkId, false) : null;
        if (!link) return failure('target_mismatch');
        if ('errorCode' in link) return link;
        const deployments = new Set<string>();
        const activatedVolumes = new Map<string, Map<string, string>>();
        let deployed = link.activeDeploymentId !== undefined;
        for await (const receipt of host.readBuildHistory!({ environmentId: input.environmentId,
            targetLinkId: link.id, environment, context })) {
            if (receipt.deployment.operation === 'teardown') continue;
            deployed = true;
            deployments.add(receipt.deployment.id);
            for (const source of receipt.content.ownServer?.sources ?? []) {
                if (source.role !== 'runtime') continue;
                const key = JSON.stringify([source.machineId, source.installationId]);
                const names = activatedVolumes.get(key) ?? new Map<string, string>();
                for (const binding of source.namedVolumes ?? []) {
                    if (!names.has(binding.physicalName)) names.set(binding.physicalName, binding.volume);
                }
                activatedVolumes.set(key, names);
            }
        }
        if (!deployed) return [];
        const resources: ReviewedNativeVolume[] = [];
        for (const member of selectMembers(input, link).filter(member => !localOnly || member.machineId === host.machineId)) {
            const names = activatedVolumes.get(JSON.stringify([member.machineId, member.installationId]));
            let memberVolumes: DeploymentTeardownResourceV1[];
            if (member.machineId !== host.machineId) {
                if (!host.sendChild) throw createActionExecuteFailureError({ ok: false, errorCode: 'machine_unavailable', error: 'machine_unavailable' });
                const response = await host.sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare',
                    actionId: 'deployments.teardown', machineId: member.machineId, installationId: member.installationId, input: { serverId: input.serverId,
                        environmentId: input.environmentId, targetLinkId: link.id, reason: input.reason },
                    expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision }), context);
                const failed = ActionExecuteFailureSchema.safeParse(response);
                if (failed.success) return failed.data;
                memberVolumes = DeploymentTeardownPreviewV1Schema.parse(response).volumes.map(volume => ({ id: volume.name,
                    kind: 'data', machineId: volume.machineId, ownership: 'owned', disposition: 'retain' }));
            } else {
                if (!host.runtime.acquireTeardownReview) throw createActionExecuteFailureError({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' });
                const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                    serverId: host.serverId, environmentId: input.environmentId });
                const projects = new Set([identity.projectName,
                    ...[...deployments].map(id => resolveNativeComposeCandidateProjectName(identity.projectName, id))]);
                const runtime = await host.runtime.acquireTeardownReview({ ...member, request: { input, context } }, async () => {});
                try { memberVolumes = await readOwnServerTeardownVolumes({ projects, machineId: member.machineId,
                    activatedVolumes: [...(names?.keys() ?? [])],
                    run: nativeRunner(runtime, context) }); }
                finally { await runtime.release(); }
            }
            for (const resource of memberVolumes) {
                const displayName = names?.get(resource.id);
                resources.push(displayName === undefined ? resource : { ...resource, displayName });
            }
        }
        return resources;
    };
    const acquireBoundary = async (request: Extract<DeploymentReceiptDispatchV1, { actionId: 'deployments.teardown' }>,
        environment: DeploymentEnvironmentDetailV1, link: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink']) => {
        const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
            serverId: host.serverId, environmentId: request.input.environmentId });
        const projects = new Set([identity.projectName]);
        const headers: DeploymentReceiptHeaderV1[] = [];
        const liveReferences = createDeploymentLiveReferencesForHost();
        let mayHaveWorkload = link.activeDeploymentId !== undefined
            || environment.targetLinks.some(other => other.targetLink.id !== link.id);
        for await (const deployment of host.readHistoryHeaders({ environmentId: request.input.environmentId,
            targetLinkId: link.id, environment, context: request.context,
            ...(request.input.removeEnvironment === true ? { liveReferences } : {}) })) {
            headers.push(deployment);
            if (deployment.operation === 'teardown') continue;
            mayHaveWorkload = true;
            projects.add(resolveNativeComposeCandidateProjectName(identity.projectName, deployment.id));
        }
        const member = link.members.find(member => member.machineId === host.machineId);
        if (!member) throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' });
        const runtime = await host.runtime.acquireTeardown!({ request, ...member }, async () => {});
        try {
            const run = nativeRunner(runtime, request.context);
            type BoundaryRequest = Parameters<DeploymentTeardownBoundary['observe']>[0];
            const removesImages = (operation: BoundaryRequest) => request.input.removeEnvironment === true && operation.step === 'removeTarget';
            const readImages = () => readNativeComposeDeploymentImageReferences(identity.environmentInstanceId, run);
            const observe: (operation: BoundaryRequest, imageCleanup?: { reason?: string }) => ReturnType<DeploymentTeardownBoundary['observe']>
                = async (operation, imageCleanup) => {
                    if (!operation.resources.length && !removesImages(operation)) return { kind: 'proved', resources: [] };
                    const proved = async (reason?: string) => {
                        // This boundary is reached only by accepted teardown, including
                        // remote already-absent observation; preview has its own reader.
                        if (operation.step === 'removeTarget') await runtime.retireEnvironmentObservers({
                            homeServerIdentityId: identity.homeServerIdentityId, environmentId: operation.environmentId,
                        });
                        let archiveWarning: string | null = null;
                        if (removesImages(operation)) {
                            // Delete retires this member's holder archives under the same accepted
                            // teardown child; the retention owner selects the origins from headers.
                            archiveWarning = await retireOwnServerImageArchiveOriginsForHost({
                                deploymentRoot: runtime.deploymentRoot, environmentInstanceId: identity.environmentInstanceId,
                                deploymentIds: projectOwnServerEnvironmentRemovalArchiveOrigins({ headers,
                                    teardownDeploymentId: operation.deploymentId, liveReferences }),
                                assertCurrent: runtime.assertCurrent,
                            });
                            try {
                                await retireEmptyOwnServerDeploymentEnvironment({
                                    deploymentRoot: runtime.deploymentRoot, environmentInstanceId: identity.environmentInstanceId,
                                    assertCurrent: runtime.assertCurrent,
                                    readBindSources: () => createNativeComposeIncumbentBindReader({ projectName: '', run }).bindSources(),
                                });
                            } catch (error) {
                                logger.warnLocalFile('[Deployment] Empty Environment directory cleanup failed',
                                    projectActionFailureCauseV1(error, 'deployment.teardown.empty_directories', { allowUnknownErrorCode: false }));
                            }
                        }
                        const warning = reason ?? archiveWarning;
                        return { kind: 'proved' as const, ...(warning ? { reason: warning } : {}), resources: operation.resources.map(resource => ({
                            resourceId: resource.id, disposition: resource.disposition === 'retain' ? 'retained' as const : 'absent' as const,
                        })) };
                    };
                    // Native launches require an admitted deployment receipt. The
                    // complete history of a sole, never-deployed link proves it empty;
                    // a missing Docker executable alone cannot prove absence.
                    if (!mayHaveWorkload) return proved();
                    const networkIds = new Set<string>();
                    for (const project of projects) {
                        const result = await run(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
                        if (result.exitCode !== 0) return { kind: 'unknown', reason: 'observation_unavailable' };
                        if (result.stdout.trim()) return { kind: 'needed' };
                        const networks = await run(['network', 'ls', '--no-trunc', '--filter',
                            `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
                        if (networks.exitCode !== 0) return { kind: 'unknown', reason: 'network_observation_unavailable' };
                        for (const id of networks.stdout.trim().split(/\r?\n/u).filter(Boolean)) networkIds.add(id);
                        if (networkIds.size > 1) return { kind: 'needed' };
                    }
                    for (const networkId of networkIds) {
                        const network = await observeNativeCaddyRetainedNetwork({ networkId }, {
                            run: async command => {
                                const result = await run(command.args);
                                return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? '' };
                            },
                        });
                        if (network === 'unavailable') return { kind: 'unknown', reason: 'network_observation_unavailable' };
                        if (network === 'needed') return { kind: 'needed' };
                    }
                    if (await observeOwnServerTeardownVolumes({ resources: operation.resources, run }) === 'needed') return { kind: 'needed' };
                    if (removesImages(operation) && imageCleanup === undefined) {
                        const references = await readImages();
                        if (references === null) return proved('image_observation_unavailable');
                        if (references.length) return { kind: 'needed' };
                    }
                    return proved(imageCleanup?.reason);
                };
            const boundary: DeploymentTeardownBoundary = {
                observe,
                async execute(operation) {
                    const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-teardown', cwd: runtime.deploymentRoot });
                    const launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args: [], cwd: runtime.deploymentRoot }, { agentIsolation: null });
                    let engine;
                    try {
                        await launch.recheckInputs?.();
                        engine = await readNativeComposeEngine({ io: runtime.nativeIo, command: launch.command, prefix: launch.args,
                            cwd: runtime.deploymentRoot, env: launch.env, ...(request.context.signal ? { signal: request.context.signal } : {}) });
                    } finally { await launch.release(); }
                    const keys = [...projects].map(projectName => ({ kind: 'composeProject' as const, dockerEndpoint: engine.id, projectName }));
                    return machineNativeEffectAdmission.run({ operation: { operationId: operation.actionOperationId,
                        kind: 'deployments.teardown', ...(request.context.signal ? { signal: request.context.signal } : {}) },
                        keys, settleNative: runtime.settleNative }, async () => {
                        let undoExpectedStop: (() => void) | undefined;
                        try {
                            for (const project of projects) {
                                const listed = await run(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
                                if (listed.exitCode !== 0) return { kind: 'unknown' as const, reason: 'observation_unavailable' };
                                const ids = listed.stdout.trim() ? listed.stdout.trim().split('\n') : [];
                                if (!ids.length) continue;
                                undoExpectedStop ??= await runtime.expectEnvironmentStop({
                                    homeServerIdentityId: identity.homeServerIdentityId, environmentId: operation.environmentId,
                                });
                                if (!await removeWitnessedContainers({ ids, project, stopWithNativeGrace: true, run })) {
                                    return { kind: 'unknown' as const, reason: 'removal_unproved' };
                                }
                            }
                            if (operation.step === 'removeTarget') await runtime.releaseEnvironmentServiceReferences({
                                homeServerIdentityId: identity.homeServerIdentityId, environmentId: operation.environmentId,
                            }, keys);
                            // Retained forwards can hold the native network after the last workload leaves.
                            const networkFailure = await removeUnusedNativeComposeNetworks({ projects: [...projects], run });
                            if (networkFailure) return { kind: networkFailure === 'network_removal_failed' ? 'failed' as const : 'unknown' as const,
                                reason: networkFailure };
                            const volumeFailure = await settleOwnServerTeardownVolumes({ resources: operation.resources, run });
                            if (volumeFailure) return volumeFailure;
                            if (!removesImages(operation)) return await observe(operation);
                            const references = await readImages();
                            const reason = references === null ? 'image_observation_unavailable'
                                : await removeNativeComposeDeploymentImageReferences(references, run);
                            return await observe(operation, reason ? { reason } : {});
                        } finally {
                            // Proved removal retires the observer. A still-live observer resumes normal classification.
                            undoExpectedStop?.();
                        }
                    });
                },
            };
            return { boundary, release: () => runtime.release() };
        } catch (error) { await runtime.release(); throw error; }
    };
    async function executeNative(job: Extract<DeploymentChildRpcV1, { actionId: 'deployments.teardown' }>, context: ActionExecutorContext) {
        try {
            if (job.kind === 'prepare') {
                const environment = await host.readEnvironment({ environmentId: job.input.environmentId, targetLinkId: job.input.targetLinkId, context });
                const link = select(environment, job.input.targetLinkId);
                if ('errorCode' in link) return link;
                if (environment.environment.revision !== job.expectedRevision || link.revision !== job.expectedTargetLinkRevision
                    || job.machineId !== host.machineId || !link.members.some(member => member.machineId === job.machineId
                        && member.installationId === job.installationId)) return failure('deployment_conflict');
                const resources = await readVolumes(job.input, context, environment, true);
                if ('errorCode' in resources) return resources;
                return DeploymentTeardownPreviewV1Schema.parse({ ok: true, kind: 'preview', volumes: resources.map(resource => ({
                    name: resource.id, machineId: resource.machineId })) });
            }
            const receipt = await host.readReceipt({ environmentId: job.input.environmentId,
                deploymentId: job.deploymentId, context });
            const environment = await host.readEnvironment({ environmentId: job.input.environmentId, targetLinkId: job.input.targetLinkId, context });
            const link = select(environment, job.input.targetLinkId);
            if ('errorCode' in link) return link;
            const intent = receipt.content.teardown;
            if (job.machineId !== host.machineId || !link.members.some(member => member.machineId === job.machineId
                && member.installationId === job.installationId)
                || receipt.deployment.operation !== 'teardown' || receipt.deployment.actionOperationId !== job.actionOperationId
                || receipt.deployment.environmentId !== job.input.environmentId || receipt.deployment.targetLinkId !== job.input.targetLinkId
                || receipt.deployment.requestKey !== job.input.requestKey || !intent || intent.reason !== job.input.reason
                || !intent.machines.some(member => member.machineId === job.machineId && member.installationId === job.installationId)) {
                return failure('deployment_conflict');
            }
            if (context.signal?.aborted || receipt.deployment.cancelRequestedAtMs !== undefined
                || receipt.deployment.state === 'cancelled') return failure('cancelled');
            const request = { actionId: job.actionId, input: job.input, context,
                receipt: { ok: true as const, environmentId: receipt.deployment.environmentId,
                    revision: environment.environment.revision, deploymentId: receipt.deployment.id,
                    deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state } };
            const resources = selectDeploymentTeardownStepResources({ resources: intent.resources, step: job.step,
                machineId: job.machineId, allMachines: intent.machines.length === link.machines.length });
            if (!resources.length) return { kind: 'proved' as const, resources: [] };
            const native = await acquireBoundary(request, environment, link);
            try { return await native.boundary[job.mode]({ environmentId: job.input.environmentId,
                targetLinkId: job.input.targetLinkId, deploymentId: job.deploymentId, actionOperationId: job.actionOperationId,
                machineId: job.machineId, installationId: job.installationId, step: job.step, resources, context }); }
            finally { await native.release(); }
        } catch (error) {
            return { ok: false as const, ...normalizeActionExecutorThrownError(error, `deployment.teardown.${job.kind === 'prepare' ? 'preview' : job.mode}`),
                ...(job.kind === 'prepare' ? { effectAttempted: false } : {}) };
        }
    }
    return {
        async preview(input: DeploymentTeardownRequestInputV1, context: ActionExecutorContext) {
            try {
                const environment = await host.readEnvironment({ environmentId: input.environmentId, targetLinkId: input.targetLinkId, context });
                const resources = await readVolumes(input, context, environment);
                if ('errorCode' in resources) return resources;
                return DeploymentTeardownPreviewV1Schema.parse({ ok: true, kind: 'preview', volumes: resources.map(resource => ({
                    name: resource.id, machineId: resource.machineId })) });
            } catch (error) { return {
                ...projectDeploymentException(error, { signal: context.signal, phase: 'deployment.teardown.preview' }),
                effectAttempted: false }; }
        },
        async admit(environment: DeploymentEnvironmentDetailV1, targetLinkId: string, content: DeploymentContentV1,
            input: DeploymentTeardownInputV1, context: ActionExecutorContext, retainedIntent = false) {
            const link = select(environment, targetLinkId);
            if ('errorCode' in link) return link;
            const members = selectMembers(input, link);
            const resources = members.flatMap(member => inventory(environment.environment.id, member.machineId));
            if (!isDeepStrictEqual(content.teardown?.machines, members.map(({ machineId, installationId }) => ({ machineId, installationId }))))
                return failure('deployment_conflict');
            const data = content.teardown?.resources.filter(resource => resource.kind === 'data') ?? [];
            if (input.volumes?.some(volume => !data.some(resource => resource.id === volume.name))) return failure('deployment_conflict');
            if (data.length) {
                const owned = retainedIntent ? data : await readVolumes({ serverId: input.serverId, environmentId: input.environmentId,
                    targetLinkId, reason: input.reason, ...(input.machines ? { machines: input.machines } : {}) }, context, environment);
                if ('errorCode' in owned) return owned;
                const selected = new Map(input.volumes?.map(volume => [volume.name, volume.disposition]));
                for (const resource of data) {
                    if (!members.some(member => member.machineId === resource.machineId) || resource.ownership !== 'owned'
                        || !owned.some(volume => volume.id === resource.id && volume.machineId === resource.machineId)) return unsupported('inventory_mismatch', 'Refresh the native volume review.');
                    if (resource.disposition !== (selected.get(resource.id) === 'delete' ? 'remove' : 'retain')) return failure('deployment_conflict');
                }
            }
            return isDeepStrictEqual(content.teardown?.resources.filter(resource => resource.kind !== 'data'), resources) ? null
                : unsupported('inventory_mismatch', 'Prepare a new teardown review for this Environment’s owned native workload.');
        },
        async prepare({ input: request, context }: Parameters<NonNullable<ActionExecutorDeps['prepareDeploymentTeardown']>>[0],
            preparedEnvironment?: DeploymentEnvironmentDetailV1) {
            try {
                if ('contentArtifactId' in request || 'dataCreation' in request) return failure('deployment_invalid');
                if (request.serverId !== host.serverId) return failure('server_scope_mismatch');
                const environment = preparedEnvironment ?? await host.readEnvironment({ environmentId: request.environmentId, targetLinkId: request.targetLinkId, context });
                const targetLinkId = request.targetLinkId ?? environment.environment.runtimeTargetLinkId;
                const link = targetLinkId ? select(environment, targetLinkId, false)
                    : unsupported('target_link_unavailable', 'Select the Environment’s current native target before preparing teardown.');
                if ('errorCode' in link) return link;
                const input = 'expectedRevision' in request ? request : { ...request,
                    requestKey: request.requestKey ?? randomUUID(), targetLinkId: link.id,
                    expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision };
                const machines = 'machines' in input ? input.machines : undefined;
                const volumesInput = 'volumes' in input ? input.volumes : undefined;
                const removeEnvironment = 'removeEnvironment' in input ? input.removeEnvironment : undefined;
                const members = selectMembers({ machines }, link);
                const prior = await host.findReceipt(input, context);
                if (prior && (prior.deployment.operation !== 'teardown' || prior.content.teardown?.reason !== input.reason
                    || prior.content.teardown.targetLinkRevision !== input.expectedTargetLinkRevision)) return failure('deployment_conflict');
                if (!prior && (environment.environment.revision !== input.expectedRevision
                    || link.revision !== input.expectedTargetLinkRevision)) return failure('deployment_conflict');
                if (!prior && removeEnvironment === true
                    && environment.targetLinks.every(row => row.targetLink.activeDeploymentId === undefined && !row.content?.nativeOrigin)) {
                    let hasHistory = false;
                    for await (const _receipt of host.readHistoryHeaders({ environmentId: input.environmentId, environment, context })) {
                        hasHistory = true;
                        break;
                    }
                    if (!hasHistory) {
                        if (volumesInput?.length) return failure('deployment_conflict');
                        const prepared = DeploymentTeardownNothingDeployedInputV1Schema.parse({ serverId: input.serverId,
                            environmentId: input.environmentId, targetLinkId: link.id, expectedRevision: input.expectedRevision,
                            expectedTargetLinkRevision: input.expectedTargetLinkRevision, requestKey: input.requestKey,
                            reason: input.reason, removeEnvironment: true, nothingDeployed: true,
                            ...(volumesInput ? { volumes: [] } : {}) });
                        return { input: prepared, preview: normalizeStrictJsonValue({
                            removal: { subject: { kind: 'ownServer' }, environment: environment.content.name,
                                projectSourceId: environment.environment.projectSourceId, removeEnvironment: true },
                        }) };
                    }
                }
                if (!host.runtime.acquireTeardown) return unsupported('native_executor_unavailable',
                    'Update the target Machine daemon to a version that supports native teardown, then prepare a new review.');
                let sourceIntent: DeploymentOwnServerContentV1['sourceIntent'] | undefined =
                    environment.content.definition.kind === 'stored' ? environment.content.definition : undefined;
                let serving: Awaited<ReturnType<Host['readReceipt']>> | undefined;
                if (!prior) {
                    for await (const receipt of host.readBuildHistory!({ environmentId: input.environmentId,
                        targetLinkId: link.id, environment, context })) {
                        sourceIntent = receipt.content.sourceIntent;
                        if (receipt.deployment.id === link.activeDeploymentId) serving = receipt;
                        break;
                    }
                }
                if (!serving && link.activeDeploymentId) {
                    // Additional display evidence must not make an admitted removal depend on opening its incumbent.
                    const receipt = await host.readReceipt({ environmentId: input.environmentId,
                        deploymentId: link.activeDeploymentId, context }).catch(() => null);
                    if (receipt?.deployment.targetLinkId === link.id && receipt.deployment.id === link.activeDeploymentId) serving = receipt;
                }
                const volumes: ReviewedNativeVolume[] | ActionExecuteFailure = prior
                    ? prior.content.teardown?.resources.filter(resource => resource.kind === 'data') ?? []
                    : volumesInput?.length ? await readVolumes({ serverId: input.serverId, environmentId: input.environmentId,
                        targetLinkId: link.id, reason: input.reason, ...(machines ? { machines } : {}) }, context, environment) : [];
                if ('errorCode' in volumes) return volumes;
                const selected = new Map(volumesInput?.map(volume => [volume.name, volume.disposition]));
                if (volumesInput?.some(volume => !volumes.some(resource => resource.id === volume.name))) return failure('deployment_conflict');
                const resources = [...members.flatMap(member => inventory(input.environmentId, member.machineId)),
                    ...volumes.map(({ displayName: _displayName, ...resource }) => ({
                        ...resource, disposition: selected.get(resource.id) === 'delete' ? 'remove' as const : 'retain' as const,
                    }))];
                if (prior && !isDeepStrictEqual(prior.content.teardown?.resources, resources)) return failure('deployment_conflict');
                const content = prior?.content ?? DeploymentOwnServerContentV1Schema.parse({ sourceIntent,
                    machines: link.machines, buildMachineId: environment.environment.buildMachineId,
                    onFailure: 'keepPartial', images: [], machineResults: [], steps: [], teardown: { reason: input.reason,
                        targetLinkRevision: link.revision, machines: members.map(({ machineId, installationId }) => ({ machineId, installationId })),
                        resources, proofs: [] } });
                const reference = prior ? { contentArtifactId: prior.deployment.contentArtifactId,
                    contentHeaderVersion: prior.deployment.contentHeaderVersion, contentBodyVersion: prior.deployment.contentBodyVersion }
                    : await host.createCandidate(environment, content, context);
                const servingFacts = serving?.content.ownServer;
                const basis = servingFacts?.approvedInputBasis;
                const placements = members.map(({ machineId, installationId }) => {
                    const servesOnlyHere = basis?.members.length === 1 && basis.members[0]?.machineId === machineId
                        && basis.members[0]?.installationId === installationId;
                    const services = basis?.runtimeProjections?.find(projection => projection.machineId === machineId
                        && projection.installationId === installationId)?.services ?? (servesOnlyHere ? basis?.services : undefined);
                    return { machineId, ...(services ? { services } : {}) };
                });
                const reviewedVolumes = new Map<string, { name: string; machineId?: string; removed: boolean }>();
                for (const source of servingFacts?.sources ?? []) {
                    if (source.role !== 'runtime' || !members.some(member => member.machineId === source.machineId
                        && member.installationId === source.installationId)) continue;
                    for (const { physicalName, volume } of source.namedVolumes ?? []) {
                        reviewedVolumes.set(JSON.stringify([source.machineId, physicalName]),
                            { name: volume, machineId: source.machineId, removed: false });
                    }
                }
                for (const resource of volumes) {
                    const key = JSON.stringify([resource.machineId, resource.id]);
                    reviewedVolumes.set(key, {
                        name: reviewedVolumes.get(key)?.name ?? resource.displayName ?? resource.id,
                        ...(resource.machineId ? { machineId: resource.machineId } : {}),
                        removed: selected.get(resource.id) === 'delete',
                    });
                }
                return { input: buildDeploymentTeardownInputV1(input, { requestKey: input.requestKey,
                    expectedRevision: input.expectedRevision, targetLinkId: link.id,
                    expectedTargetLinkRevision: input.expectedTargetLinkRevision, candidate: reference }),
                    preview: normalizeStrictJsonValue({
                        summary: removeEnvironment
                            ? 'Remove this Environment’s containers, owned networks, private image tags, and selected named volumes. Shared image tags and unselected volumes stay.'
                            : 'Remove this target’s containers, owned networks, and selected named volumes. Images and unselected volumes stay.',
                        removal: { subject: { kind: 'ownServer' }, environment: environment.content.name, removeEnvironment: removeEnvironment === true,
                            projectSourceId: environment.environment.projectSourceId, placements,
                            volumes: [...reviewedVolumes.values()] },
                    }) };
            } catch (error) { return {
                ...projectDeploymentException(error, { signal: context.signal, phase: 'deployment.teardown.prepare' }),
                effectAttempted: false }; }
        },
        executeNative,
        async execute(request: DeploymentReceiptDispatchV1, openedEnvironment?: DeploymentEnvironmentDetailV1) {
            if (request.actionId !== 'deployments.teardown') return failure('unsupported_action');
            const environment = openedEnvironment ?? await host.readEnvironment({ environmentId: request.input.environmentId,
                targetLinkId: request.input.targetLinkId, context: request.context });
            const link = select(environment, request.input.targetLinkId);
            if ('errorCode' in link) return link;
            if (link.members.length === 1 && link.members[0].machineId === host.machineId) {
                const native = await acquireBoundary(request, environment, link);
                try { return await createDeploymentTeardownExecutor({ ...host, boundary: native.boundary })(request, environment); }
                finally { await native.release(); }
            }
            const dispatch = async (mode: 'observe' | 'execute', operation: Parameters<DeploymentTeardownBoundary['observe']>[0]) => {
                if (!operation.resources.length) return { kind: 'proved' as const, resources: [] };
                const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'teardown',
                    actionId: request.actionId, input: request.input, deploymentId: operation.deploymentId,
                    actionOperationId: operation.actionOperationId, machineId: operation.machineId,
                    installationId: operation.installationId, step: operation.step, mode });
                if (job.actionId !== 'deployments.teardown') throw new Error('Expected teardown child');
                if (operation.machineId !== host.machineId && !host.sendChild)
                    throw createActionExecuteFailureError({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' });
                const result = operation.machineId === host.machineId ? await executeNative(job, request.context)
                    : await host.sendChild!(job, request.context);
                const refusal = ActionExecuteFailureSchema.safeParse(result);
                if (refusal.success) throw refusal.data;
                return DeploymentTeardownObservationSchema.parse(result);
            };
            return createDeploymentTeardownExecutor({ ...host, boundary: {
                observe: operation => dispatch('observe', operation), execute: operation => dispatch('execute', operation),
            } })(request, environment);
        },
    };
}
