import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DeploymentChildRpcV1Schema, type DeploymentChildRpcV1, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildDeploymentTeardownInputV1, DeploymentTeardownNothingDeployedInputV1Schema,
    type DeploymentTeardownInputV1, type DeploymentTeardownRefusalDetailsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentOwnServerContentV1Schema, type DeploymentContentV1, type DeploymentEnvironmentDetailV1,
    type DeploymentReceiptDetailV1, type DeploymentOwnServerContentV1, type DeploymentTeardownResourceV1 } from '@happier-dev/deployment-protocol';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { configuration } from '@/configuration';
import { authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readNativeComposeEngine } from '@/daemon/local/services/launch/nativeComposeEngine';
import { removeWitnessedContainers, resolveNativeComposeCandidateProjectName } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { removeUnusedNativeComposeNetworks } from '@/daemon/local/services/launch/nativeComposeNetworks';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { createDeploymentTeardownExecutor, DeploymentTeardownObservationSchema, selectDeploymentTeardownStepResources, type DeploymentTeardownBoundary } from '../../actions/teardown';
import type { DeploymentReceiptDispatchV1 } from '../../createCliDeploymentActionDeps';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { projectDeploymentException } from '../../deploymentFailure';
import { admitOwnServerDeploymentTargetLink } from './ownServerTargetAdmission';
import { readOwnServerTeardownVolumes, observeOwnServerTeardownVolumes, settleOwnServerTeardownVolumes } from './teardownVolumes';
import { DeploymentTeardownPreviewV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentTeardownRequestInputV1 } from '@happier-dev/protocol/deployments/deploymentTeardownRequestV1';

type Reference = Pick<DeploymentTeardownInputV1, 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;
type Host = OwnServerDeploymentTargetHostInput & Readonly<{
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
export function createOwnServerTeardownForHost(host: Host) {
    const selectMembers = (input: Readonly<{ machines?: readonly string[] }>,
        link: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink']) =>
        (input.machines ?? link.machines).map(machineId => {
            const member = link.members.find(member => member.machineId === machineId);
            if (!member) throw Object.assign(new Error('deployment_conflict'), { code: 'deployment_conflict' });
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
        environment: DeploymentEnvironmentDetailV1, localOnly = false): Promise<DeploymentTeardownResourceV1[] | ActionExecuteFailure> => {
        const targetLinkId = input.targetLinkId ?? environment.environment.runtimeTargetLinkId;
        const link = targetLinkId ? select(environment, targetLinkId, false) : null;
        if (!link) return failure('target_mismatch');
        if ('errorCode' in link) return link;
        const deployments = new Set<string>();
        let deployed = link.activeDeploymentId !== undefined;
        for await (const receipt of host.readBuildHistory!({ environmentId: input.environmentId,
            targetLinkId: link.id, environment, context })) {
            if (receipt.deployment.operation === 'teardown') continue;
            deployed = true;
            deployments.add(receipt.deployment.id);
        }
        if (!deployed) return [];
        const resources: DeploymentTeardownResourceV1[] = [];
        for (const member of selectMembers(input, link).filter(member => !localOnly || member.machineId === host.machineId)) {
            if (member.machineId !== host.machineId) {
                if (!host.sendChild) throw Object.assign(new Error('machine_unavailable'), { code: 'machine_unavailable' });
                const response = await host.sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare',
                    actionId: 'deployments.teardown', machineId: member.machineId, installationId: member.installationId, input: { serverId: input.serverId,
                        environmentId: input.environmentId, targetLinkId: link.id, reason: input.reason },
                    expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision }), context);
                const failed = ActionExecuteFailureSchema.safeParse(response);
                if (failed.success) return failed.data;
                resources.push(...DeploymentTeardownPreviewV1Schema.parse(response).volumes.map(volume => ({ id: volume.name,
                    kind: 'data' as const, machineId: volume.machineId, ownership: 'owned' as const, disposition: 'retain' as const })));
                continue;
            }
            if (!host.runtime.acquireTeardownReview) throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
            const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                serverId: host.serverId, environmentId: input.environmentId });
            const projects = new Set([identity.projectName,
                ...[...deployments].map(id => resolveNativeComposeCandidateProjectName(identity.projectName, id))]);
            const runtime = await host.runtime.acquireTeardownReview({ ...member, request: { input, context } }, async () => {});
            try { resources.push(...await readOwnServerTeardownVolumes({ projects, machineId: member.machineId, run: nativeRunner(runtime, context) })); }
            finally { await runtime.release(); }
        }
        return resources;
    };
    const acquireBoundary = async (request: Extract<DeploymentReceiptDispatchV1, { actionId: 'deployments.teardown' }>,
        environment: DeploymentEnvironmentDetailV1, link: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink']) => {
        const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
            serverId: host.serverId, environmentId: request.input.environmentId });
        const projects = new Set([identity.projectName]);
        let mayHaveWorkload = link.activeDeploymentId !== undefined
            || environment.targetLinks.some(other => other.targetLink.id !== link.id);
        // select already proved the two native producer ports are present.
        for await (const receipt of host.readBuildHistory!({ environmentId: request.input.environmentId,
            targetLinkId: link.id, environment, context: request.context })) {
            if (receipt.deployment.operation === 'teardown') continue;
            mayHaveWorkload = true;
            projects.add(resolveNativeComposeCandidateProjectName(identity.projectName, receipt.deployment.id));
        }
        const member = link.members.find(member => member.machineId === host.machineId);
        if (!member) throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
        const runtime = await host.runtime.acquireTeardown!({ request, ...member }, async () => {});
        try {
            const run = nativeRunner(runtime, request.context);
            const boundary: DeploymentTeardownBoundary = {
                async observe(operation) {
                    if (!operation.resources.length) return { kind: 'proved', resources: [] };
                    const proved = async () => {
                        // This boundary is reached only by accepted teardown, including
                        // remote already-absent observation; preview has its own reader.
                        if (operation.step === 'removeTarget') await runtime.retireEnvironmentObservers({
                            homeServerIdentityId: identity.homeServerIdentityId, environmentId: operation.environmentId,
                        });
                        return { kind: 'proved' as const, resources: operation.resources.map(resource => ({
                            resourceId: resource.id, disposition: resource.disposition === 'retain' ? 'retained' as const : 'absent' as const,
                        })) };
                    };
                    // Native launches require an admitted deployment receipt. The
                    // complete history of a sole, never-deployed link proves it empty;
                    // a missing Docker executable alone cannot prove absence.
                    if (!mayHaveWorkload) return proved();
                    for (const project of projects) {
                        const result = await run(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
                        if (result.exitCode !== 0) return { kind: 'unknown', reason: 'observation_unavailable' };
                        if (result.stdout.trim()) return { kind: 'needed' };
                        const networks = await run(['network', 'ls', '--no-trunc', '--filter',
                            `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
                        if (networks.exitCode !== 0) return { kind: 'unknown', reason: 'network_observation_unavailable' };
                        if (networks.stdout.trim()) return { kind: 'needed' };
                    }
                    if (await observeOwnServerTeardownVolumes({ resources: operation.resources, run }) === 'needed') return { kind: 'needed' };
                    return proved();
                },
                async execute(operation) {
                    const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-teardown', cwd: runtime.deploymentRoot });
                    const launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args: [], cwd: runtime.deploymentRoot }, { agentIsolation: null });
                    let engine;
                    try {
                        await launch.recheckInputs?.();
                        engine = await readNativeComposeEngine({ io: runtime.nativeIo, command: launch.command, prefix: launch.args,
                            cwd: runtime.deploymentRoot, env: launch.env, ...(request.context.signal ? { signal: request.context.signal } : {}) });
                    } finally { await launch.release(); }
                    return machineNativeEffectAdmission.run({ operation: { operationId: operation.actionOperationId,
                        kind: 'deployments.teardown', ...(request.context.signal ? { signal: request.context.signal } : {}) },
                        keys: [...projects].map(projectName => ({ kind: 'composeProject', dockerEndpoint: engine.id, projectName })),
                        settleNative: runtime.settleNative }, async () => {
                        for (const project of projects) {
                            const listed = await run(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
                            if (listed.exitCode !== 0) return { kind: 'unknown' as const, reason: 'observation_unavailable' };
                            const ids = listed.stdout.trim() ? listed.stdout.trim().split('\n') : [];
                            if (ids.length && !await removeWitnessedContainers({ ids, project, stopWithNativeGrace: true, run })) {
                                return { kind: 'unknown' as const, reason: 'removal_unproved' };
                            }
                        }
                        // Revisit shared networks after every retained generation
                        // has been removed. The native owner also handles empty projects.
                        const networkFailure = await removeUnusedNativeComposeNetworks({ projects: [...projects], run });
                        if (networkFailure) return { kind: 'unknown' as const, reason: networkFailure };
                        const volumeFailure = await settleOwnServerTeardownVolumes({ resources: operation.resources, run });
                        if (volumeFailure) return volumeFailure;
                        return boundary.observe(operation);
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
                    for await (const _receipt of host.readBuildHistory!({ environmentId: input.environmentId, environment, context })) {
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
                        return { input: prepared, preview: normalizeStrictJsonValue({ environmentId: input.environmentId,
                            nothingDeployed: true, removeEnvironment: true }) };
                    }
                }
                if (!host.runtime.acquireTeardown) return unsupported('native_executor_unavailable',
                    'Update the target Machine daemon to a version that supports native teardown, then prepare a new review.');
                let sourceIntent: DeploymentOwnServerContentV1['sourceIntent'] | undefined =
                    environment.content.definition.kind === 'stored' ? environment.content.definition : undefined;
                if (!prior) {
                    for await (const receipt of host.readBuildHistory!({ environmentId: input.environmentId,
                        targetLinkId: link.id, environment, context })) { sourceIntent = receipt.content.sourceIntent; break; }
                }
                const volumes = prior ? prior.content.teardown?.resources.filter(resource => resource.kind === 'data') ?? []
                    : volumesInput?.length ? await readVolumes({ serverId: input.serverId, environmentId: input.environmentId,
                        targetLinkId: link.id, reason: input.reason, ...(machines ? { machines } : {}) }, context, environment) : [];
                if ('errorCode' in volumes) return volumes;
                const selected = new Map(volumesInput?.map(volume => [volume.name, volume.disposition]));
                if (volumesInput?.some(volume => !volumes.some(resource => resource.id === volume.name))) return failure('deployment_conflict');
                const resources = [...members.flatMap(member => inventory(input.environmentId, member.machineId)),
                    ...volumes.map(resource => ({ ...resource, disposition: selected.get(resource.id) === 'delete' ? 'remove' as const : 'retain' as const }))];
                if (prior && !isDeepStrictEqual(prior.content.teardown?.resources, resources)) return failure('deployment_conflict');
                const content = prior?.content ?? DeploymentOwnServerContentV1Schema.parse({ sourceIntent,
                    machines: link.machines, buildMachineId: environment.environment.buildMachineId,
                    onFailure: 'keepPartial', images: [], machineResults: [], steps: [], teardown: { reason: input.reason,
                        targetLinkRevision: link.revision, machines: members.map(({ machineId, installationId }) => ({ machineId, installationId })),
                        resources, proofs: [] } });
                const reference = prior ? { contentArtifactId: prior.deployment.contentArtifactId,
                    contentHeaderVersion: prior.deployment.contentHeaderVersion, contentBodyVersion: prior.deployment.contentBodyVersion }
                    : await host.createCandidate(environment, content, context);
                return { input: buildDeploymentTeardownInputV1(input, { requestKey: input.requestKey,
                    expectedRevision: input.expectedRevision, targetLinkId: link.id,
                    expectedTargetLinkRevision: input.expectedTargetLinkRevision, candidate: reference }),
                    preview: normalizeStrictJsonValue({ environmentId: input.environmentId, targetLinkId: input.targetLinkId,
                        summary: 'Stop and remove this Environment’s containers and owned networks. Only explicitly selected named data volumes are deleted; other volumes and images are kept.',
                        machines: members.map(member => member.machineId), resources: content.teardown?.resources ?? [] }) };
            } catch (error) { return {
                ...projectDeploymentException(error, { signal: context.signal, phase: 'deployment.teardown.prepare' }),
                effectAttempted: false }; }
        },
        executeNative,
        async execute(request: DeploymentReceiptDispatchV1) {
            if (request.actionId !== 'deployments.teardown') return failure('unsupported_action');
            const environment = await host.readEnvironment({ environmentId: request.input.environmentId,
                targetLinkId: request.input.targetLinkId, context: request.context });
            const link = select(environment, request.input.targetLinkId);
            if ('errorCode' in link) return link;
            if (link.members.length === 1 && link.members[0].machineId === host.machineId) {
                const native = await acquireBoundary(request, environment, link);
                try { return await createDeploymentTeardownExecutor({ ...host, boundary: native.boundary })(request); }
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
                    throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
                const result = operation.machineId === host.machineId ? await executeNative(job, request.context)
                    : await host.sendChild!(job, request.context);
                const refusal = ActionExecuteFailureSchema.safeParse(result);
                if (refusal.success) throw refusal.data;
                return DeploymentTeardownObservationSchema.parse(result);
            };
            return createDeploymentTeardownExecutor({ ...host, boundary: {
                observe: operation => dispatch('observe', operation), execute: operation => dispatch('execute', operation),
            } })(request);
        },
    };
}
