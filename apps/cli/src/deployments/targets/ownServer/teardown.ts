import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DeploymentChildRpcV1Schema, type DeploymentChildRpcV1, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildDeploymentTeardownInputV1, type DeploymentTeardownInputV1, type DeploymentTeardownRefusalDetailsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentOwnServerContentV1Schema, type DeploymentContentV1, type DeploymentEnvironmentDetailV1,
    type DeploymentReceiptDetailV1, type DeploymentOwnServerContentV1 } from '@happier-dev/deployment-protocol';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { configuration } from '@/configuration';
import { authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readNativeComposeEngine } from '@/daemon/local/services/launch/nativeComposeEngine';
import { removeWitnessedContainers, resolveNativeComposeCandidateProjectName } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { createDeploymentTeardownExecutor, DeploymentTeardownObservationSchema, selectDeploymentTeardownStepResources, type DeploymentTeardownBoundary } from '../../actions/teardown';
import type { DeploymentReceiptDispatchV1 } from '../../createCliDeploymentActionDeps';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { admitOwnServerDeploymentTargetLink } from './ownServerTargetAdmission';

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

/** Native workload removal uses the existing teardown receipt and signed proof owner.
 * Files, images and data volumes remain with their existing retention owners. */
export function createOwnServerTeardownForHost(host: Host) {
    const select = (environment: DeploymentEnvironmentDetailV1, targetLinkId: string) => {
        const row = environment.targetLinks.find(item => item.targetLink.id === targetLinkId);
        if (!host.runtime.acquireTeardown || !host.readBuildHistory) return unsupported('native_executor_unavailable',
            'Update the target Machine daemon to a version that supports native teardown, then prepare a new review.');
        if (!row) return unsupported('target_link_unavailable', 'Refresh the Environment and prepare teardown for its current target link.');
        if (row.content?.nativeOrigin) return unsupported('imported_workload',
            'Remove the imported workload through its native owner before detaching its target link.');
        try {
            admitOwnServerDeploymentTargetLink(row.targetLink, host.machineId, environment.environment.controllerMachineId);
            if (row.targetLink.members.length !== 1) throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
            return row.targetLink;
        }
        catch (error) { return unsupported('target_placement_unsupported',
            'Run teardown on the recorded controller Machine for an Environment with one native target Machine.', error,
            `controllerMachineId=${environment.environment.controllerMachineId}`); }
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
        const runtime = await host.runtime.acquireTeardown!({ request, ...link.members[0] }, async () => {});
        try {
            const run = async (args: readonly string[]) => {
                await runtime.assertCurrent();
                const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-teardown', cwd: runtime.deploymentRoot });
                const launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args, cwd: runtime.deploymentRoot }, { agentIsolation: null });
                try {
                    await launch.recheckInputs?.();
                    return await runtime.nativeIo.run({ command: launch.command, args: launch.args, cwd: runtime.deploymentRoot,
                        env: launch.env, ...(request.context.signal ? { signal: request.context.signal } : {}) });
                } finally { await launch.release(); }
            };
            const boundary: DeploymentTeardownBoundary = {
                async observe(operation) {
                    if (!operation.resources.length) return { kind: 'proved', resources: [] };
                    // Native launches require an admitted deployment receipt. The
                    // complete history of a sole, never-deployed link proves it empty;
                    // a missing Docker executable alone cannot prove absence.
                    if (!mayHaveWorkload) return { kind: 'proved', resources: operation.resources.map(resource => ({
                        resourceId: resource.id, disposition: 'absent',
                    })) };
                    for (const project of projects) {
                        const result = await run(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
                        if (result.exitCode !== 0) return { kind: 'unknown', reason: 'observation_unavailable' };
                        if (result.stdout.trim()) return { kind: 'needed' };
                        const networks = await run(['network', 'ls', '--no-trunc', '--filter',
                            `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
                        if (networks.exitCode !== 0) return { kind: 'unknown', reason: 'network_observation_unavailable' };
                        if (networks.stdout.trim()) return { kind: 'needed' };
                    }
                    return { kind: 'proved', resources: operation.resources.map(resource => ({ resourceId: resource.id, disposition: 'absent' })) };
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
                        // Retained generations can share a network: detach all
                        // owned workloads before removing any owned network.
                        for (const project of projects) {
                            const networks = await run(['network', 'ls', '--no-trunc', '--filter',
                                `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
                            if (networks.exitCode !== 0) return { kind: 'unknown' as const, reason: 'network_observation_unavailable' };
                            const networkIds = networks.stdout.trim() ? networks.stdout.trim().split('\n') : [];
                            if (networkIds.length && (await run(['network', 'rm', ...networkIds])).exitCode !== 0) {
                                return { kind: 'unknown' as const, reason: 'network_removal_unproved' };
                            }
                        }
                        return boundary.observe(operation);
                    });
                },
            };
            return { boundary, release: () => runtime.release() };
        } catch (error) { await runtime.release(); throw error; }
    };
    return {
        admit(environment: DeploymentEnvironmentDetailV1, targetLinkId: string, content: DeploymentContentV1) {
            const link = select(environment, targetLinkId);
            if ('errorCode' in link) return link;
            return isDeepStrictEqual(content.teardown?.resources, inventory(environment.environment.id, link.members[0].machineId)) ? null
                : unsupported('inventory_mismatch', 'Prepare a new teardown review for this Environment’s owned native workload.');
        },
        async prepare({ input: request, context }: Parameters<NonNullable<ActionExecutorDeps['prepareDeploymentTeardown']>>[0],
            preparedEnvironment?: DeploymentEnvironmentDetailV1) {
            try {
                if ('contentArtifactId' in request || 'dataCreation' in request) return failure('deployment_invalid');
                if (request.serverId !== host.serverId) return failure('server_scope_mismatch');
                const environment = preparedEnvironment ?? await host.readEnvironment({ environmentId: request.environmentId, context });
                const targetLinkId = request.targetLinkId ?? environment.environment.runtimeTargetLinkId;
                const link = targetLinkId ? select(environment, targetLinkId)
                    : unsupported('target_link_unavailable', 'Select the Environment’s current native target before preparing teardown.');
                if ('errorCode' in link) return link;
                const input = 'expectedRevision' in request ? request : { ...request,
                    requestKey: request.requestKey ?? randomUUID(), targetLinkId: link.id,
                    expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision };
                const prior = await host.findReceipt(input, context);
                if (prior && (prior.deployment.operation !== 'teardown' || prior.content.teardown?.reason !== input.reason
                    || prior.content.teardown.targetLinkRevision !== input.expectedTargetLinkRevision)) return failure('deployment_conflict');
                if (!prior && (environment.environment.revision !== input.expectedRevision
                    || link.revision !== input.expectedTargetLinkRevision)) return failure('deployment_conflict');
                let sourceIntent: DeploymentOwnServerContentV1['sourceIntent'] | undefined =
                    environment.content.definition.kind === 'stored' ? environment.content.definition : undefined;
                if (!prior) {
                    for await (const receipt of host.readBuildHistory!({ environmentId: input.environmentId,
                        targetLinkId: link.id, environment, context })) { sourceIntent = receipt.content.sourceIntent; break; }
                }
                const content = prior?.content ?? DeploymentOwnServerContentV1Schema.parse({ sourceIntent,
                    machines: link.machines, buildMachineId: environment.environment.buildMachineId,
                    onFailure: 'keepPartial', images: [], machineResults: [], steps: [], teardown: { reason: input.reason,
                        targetLinkRevision: link.revision, machines: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
                        resources: inventory(input.environmentId, link.members[0].machineId), proofs: [] } });
                const reference = prior ? { contentArtifactId: prior.deployment.contentArtifactId,
                    contentHeaderVersion: prior.deployment.contentHeaderVersion, contentBodyVersion: prior.deployment.contentBodyVersion }
                    : await host.createCandidate(environment, content, context);
                return { input: buildDeploymentTeardownInputV1(input, { requestKey: input.requestKey,
                    expectedRevision: input.expectedRevision, targetLinkId: link.id,
                    expectedTargetLinkRevision: input.expectedTargetLinkRevision, candidate: reference }),
                    preview: normalizeStrictJsonValue({ environmentId: input.environmentId, targetLinkId: input.targetLinkId,
                        summary: 'Stop and remove this Environment’s containers and owned networks. Named data volumes and images are kept.',
                        machines: link.machines, resources: content.teardown?.resources ?? [] }) };
            } catch (error) { return failure(context.signal?.aborted ? 'cancelled'
                : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_content_unavailable'); }
        },
        async executeNative(job: Extract<DeploymentChildRpcV1, { kind: 'teardown' }>, context: ActionExecutorContext) {
            try {
                const receipt = await host.readReceipt({ environmentId: job.input.environmentId,
                    deploymentId: job.deploymentId, context });
                const environment = await host.readEnvironment({ environmentId: job.input.environmentId, context });
                const link = select(environment, job.input.targetLinkId);
                if ('errorCode' in link) return link;
                const intent = receipt.content.teardown;
                if (job.machineId !== host.machineId || link.members[0].machineId !== job.machineId
                    || link.members[0].installationId !== job.installationId
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
                return { ok: false as const, ...normalizeActionExecutorThrownError(error, `deployment.teardown.${job.mode}`) };
            }
        },
        async execute(request: DeploymentReceiptDispatchV1) {
            if (request.actionId !== 'deployments.teardown') return failure('unsupported_action');
            const environment = await host.readEnvironment({ environmentId: request.input.environmentId, context: request.context });
            const link = select(environment, request.input.targetLinkId);
            if ('errorCode' in link) return link;
            if (link.members[0].machineId === host.machineId) {
                const native = await acquireBoundary(request, environment, link);
                try { return await createDeploymentTeardownExecutor({ ...host, boundary: native.boundary })(request); }
                finally { await native.release(); }
            }
            const dispatch = async (mode: 'observe' | 'execute', operation: Parameters<DeploymentTeardownBoundary['observe']>[0]) => {
                if (!operation.resources.length) return { kind: 'proved' as const, resources: [] };
                if (!host.sendChild) throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
                const result = await host.sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'teardown',
                    actionId: request.actionId, input: request.input, deploymentId: operation.deploymentId,
                    actionOperationId: operation.actionOperationId, machineId: operation.machineId,
                    installationId: operation.installationId, step: operation.step, mode }), request.context);
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
