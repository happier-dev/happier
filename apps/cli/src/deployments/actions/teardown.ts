import { isDeepStrictEqual } from 'node:util';
import type { ActionExecutorContext, DeploymentReceiptResultV1 } from '@happier-dev/protocol';
import { DEPLOYMENT_TEARDOWN_STEPS_V1, type DeploymentTeardownResourceV1, type DeploymentTeardownStepProofV1, type DeploymentTeardownStepV1 } from '@happier-dev/deployment-protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentReceiptDispatchV1 } from '../createCliDeploymentActionDeps';
import type { OwnServerDeploymentTargetHostInput, OwnServerDeploymentTransition } from '../targets/ownServer/ownServerDeploymentTarget';

type Result = DeploymentReceiptResultV1 | ActionExecuteFailure;
export type DeploymentTeardownBoundaryRequest = Readonly<{
    environmentId: string;
    targetLinkId: string;
    deploymentId: string;
    actionOperationId: string;
    machineId: string;
    installationId: string;
    step: DeploymentTeardownStepV1;
    resources: readonly DeploymentTeardownResourceV1[];
    context: ActionExecutorContext;
}>;
export type DeploymentTeardownObservation =
    | Readonly<{ kind: 'proved'; resources: DeploymentTeardownStepProofV1['resources'] }>
    | Readonly<{ kind: 'needed' }>
    | Readonly<{ kind: 'unknown' | 'failed'; reason: string }>;

/** Each implementation delegates to its real resource owner. Absence is unsupported,
 * never an assumption that an unimplemented removal already happened. */
export type DeploymentTeardownBoundary = Readonly<{
    observe(request: DeploymentTeardownBoundaryRequest): Promise<DeploymentTeardownObservation>;
    execute(request: DeploymentTeardownBoundaryRequest): Promise<DeploymentTeardownObservation>;
}>;

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const kinds: Record<DeploymentTeardownStepV1, readonly DeploymentTeardownResourceV1['kind'][]> = {
    admit: [], settleDeploy: [], removeTarget: ['workload', 'network', 'data', 'providerResource'], removeDomain: ['domain'],
    removeRelease: ['release'], withdrawBindings: ['binding'], verify: ['workload', 'network', 'data', 'domain', 'release', 'binding', 'providerResource'],
};

/** One finite continuation, invoked by the deployment Action carrier. No loop,
 * queue or alternate progress store survives the request. */
export function createDeploymentTeardownExecutor(host: Pick<OwnServerDeploymentTargetHostInput,
    'serverId' | 'machineId' | 'readEnvironment' | 'readReceipt' | 'writeTransition'> & Readonly<{
        boundary?: DeploymentTeardownBoundary;
    }>) {
    return async (request: DeploymentReceiptDispatchV1): Promise<Result> => {
        if (request.actionId !== 'deployments.teardown') return failure('unsupported_action');
        // The installed target must advertise actual owned-removal producers.
        // A missing producer cannot mark a receipt running or remove anything.
        if (!host.boundary) return failure('unsupported_action');
        const boundary = host.boundary;
        const read = () => host.readReceipt({ environmentId: request.input.environmentId,
            deploymentId: request.receipt.deploymentId, context: request.context });
        let receipt = await read();
        const environment = await host.readEnvironment({ environmentId: request.input.environmentId, context: request.context });
        const link = environment.targetLinks.find(item => item.targetLink.id === request.input.targetLinkId)?.targetLink;
        const selected = environment.targetLinks.find(item => item.targetLink.id === environment.environment.runtimeTargetLinkId)?.targetLink;
        const intent = receipt.content.teardown;
        if (receipt.deployment.state === 'queued' && receipt.deployment.revision === 1 && intent?.proofs.length) {
            return failure('deployment_invalid');
        }
        if (request.input.serverId !== host.serverId || !link || !intent || receipt.deployment.operation !== 'teardown'
            || receipt.deployment.environmentId !== request.input.environmentId || receipt.deployment.targetLinkId !== link.id
            || intent.targetLinkRevision !== link.revision || intent.reason !== request.input.reason
            || !isDeepStrictEqual(intent.machines.map(member => member.machineId), request.input.machines ?? link.machines)
            || intent.machines.some(member => !link.members.some(current => current.machineId === member.machineId
                && current.installationId === member.installationId))
            || (selected && selected.id !== link.id && intent.machines.some(member => selected.machines.includes(member.machineId)))) return failure('deployment_conflict');
        const result = (): DeploymentReceiptResultV1 => ({ ok: true, environmentId: receipt.deployment.environmentId,
            revision: environment.environment.revision, deploymentId: receipt.deployment.id,
            deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state });
        if (receipt.deployment.state === 'succeeded' || receipt.deployment.state === 'cancelled') return result();
        if (receipt.deployment.cancelRequestedAtMs !== undefined || request.context.signal?.aborted) return failure('cancelled');

        const write = async (state: OwnServerDeploymentTransition['state'], proof?: DeploymentTeardownStepProofV1) => {
            const current = receipt.content.teardown!;
            const proofs = proof ? [...current.proofs.filter(item => item.step !== proof.step || item.machineId !== proof.machineId), proof] : current.proofs;
            const content = proof ? { ...receipt.content, teardown: { ...current, proofs } } : receipt.content;
            if (state === receipt.deployment.state && isDeepStrictEqual(content, receipt.content)) return null;
            const teardownProof: OwnServerDeploymentTransition['teardownProof'] = state === 'succeeded'
                ? { targetLinkRevision: intent.targetLinkRevision, machines: intent.machines, workloadAbsent: true,
                    steps: [...DEPLOYMENT_TEARDOWN_STEPS_V1],
                    retainedProviderResource: intent.resources.some(resource => resource.disposition === 'retain' && resource.kind === 'providerResource') }
                : undefined;
            const response = await host.writeTransition({ environmentId: receipt.deployment.environmentId,
                deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision,
                state, content, context: request.context,
                ...(teardownProof ? { teardownProof } : {}),
            });
            if (!response.ok) return response;
            receipt = await read();
            return null;
        };
        for (const member of intent.machines) {
            for (const step of DEPLOYMENT_TEARDOWN_STEPS_V1) {
                const fresh = await read();
                if (fresh.deployment.cancelRequestedAtMs !== undefined || fresh.deployment.state === 'cancelled'
                    || request.context.signal?.aborted) return failure('cancelled');
                if (!fresh.content.teardown || !isDeepStrictEqual({ ...fresh.content.teardown, proofs: [] }, { ...intent, proofs: [] })) {
                    return failure('deployment_conflict');
                }
                receipt = fresh;
                const prior = receipt.content.teardown!.proofs.find(proof => proof.machineId === member.machineId && proof.step === step);
                const resources = intent.resources.filter(resource => kinds[step].includes(resource.kind)
                    && (resource.machineId === member.machineId || (resource.machineId === undefined && intent.machines.length === link.machines.length)));
                const expected = resources.map(resource => ({ resourceId: resource.id,
                    disposition: resource.disposition === 'retain' ? 'retained' as const : 'absent' as const }));
                const complete = (proof: DeploymentTeardownStepProofV1['resources']) => proof.length === expected.length
                    && new Set(proof.map(resource => resource.resourceId)).size === proof.length
                    && expected.every(resource => proof.some(observed => observed.resourceId === resource.resourceId
                        && observed.disposition === resource.disposition));
                if (prior?.state === 'succeeded' && complete(prior.resources)) continue;
                const operation = { environmentId: receipt.deployment.environmentId, targetLinkId: link.id,
                    deploymentId: receipt.deployment.id, actionOperationId: receipt.deployment.actionOperationId,
                    ...member, step, resources, context: request.context };
                let observed: DeploymentTeardownObservation;
                try { observed = await boundary.observe(operation); }
                catch { observed = { kind: 'unknown', reason: 'observation_unavailable' }; }
                if (observed.kind === 'needed' && prior && prior.state !== 'failed') {
                    observed = { kind: 'unknown', reason: 'removal_unproved' };
                } else if (observed.kind === 'needed') {
                    const started = await write('running', { step, ...member, state: 'running', resources: [] });
                    if (started) return started;
                    const current = await read();
                    if (current.deployment.cancelRequestedAtMs !== undefined || current.deployment.state === 'cancelled'
                        || request.context.signal?.aborted) return failure('cancelled');
                    try { observed = await boundary.execute(operation); }
                    catch { observed = { kind: 'unknown', reason: 'removal_unproved' }; }
                }
                if (observed.kind === 'proved') {
                    if (!complete(observed.resources)) observed = { kind: 'unknown', reason: 'resource_proof_incomplete' };
                }
                if (observed.kind === 'proved') {
                    const saved = await write('running', { step, ...member, state: 'succeeded', resources: observed.resources });
                    if (saved) return saved;
                } else {
                    const state = observed.kind === 'failed' ? 'failed' : 'outcome_unknown';
                    const saved = await write(state, { step, ...member, state, resources: [],
                        reason: observed.kind === 'needed' ? 'removal_unproved' : observed.reason });
                    return saved ?? result();
                }
            }
        }
        return await write('succeeded') ?? result();
    };
}
