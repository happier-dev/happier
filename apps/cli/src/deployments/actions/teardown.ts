import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/mini';
import type { ActionExecutorContext, DeploymentReceiptResultV1 } from '@happier-dev/protocol';
import {
    DEPLOYMENT_TEARDOWN_STEPS_V1,
    DeploymentTeardownStepProofV1Schema,
    type DeploymentReceiptDetailV1,
    type DeploymentTeardownResourceV1,
    type DeploymentTeardownStepProofV1,
    type DeploymentTeardownStepV1,
} from '@happier-dev/deployment-protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { DeploymentTeardownEnvironmentPartialDetailsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { projectDeploymentTransitionOutcomeUnknownForHost } from '../deploymentTransitionResult';
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
export const DeploymentTeardownObservationSchema = z.union([
    z.strictObject({ kind: z.literal('proved'), resources: DeploymentTeardownStepProofV1Schema.shape.resources }),
    z.strictObject({ kind: z.literal('needed') }),
    z.strictObject({ kind: z.enum(['unknown', 'failed']), reason: z.string().check(z.minLength(1)) }),
]);
export type DeploymentTeardownObservation = z.infer<typeof DeploymentTeardownObservationSchema>;

/** Each implementation delegates to its real resource owner. Absence is unsupported,
 * never an assumption that an unimplemented removal already happened. */
export type DeploymentTeardownBoundary = Readonly<{
    observe(request: DeploymentTeardownBoundaryRequest): Promise<DeploymentTeardownObservation>;
    execute(request: DeploymentTeardownBoundaryRequest): Promise<DeploymentTeardownObservation>;
}>;

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** Resume the admitted receipt before any Domain, provider or native child spends
 * its active-job custody. Step proofs and original teardown choices stay intact. */
export async function resumeDeploymentTeardownReceiptForHost(input: Readonly<{
    request: Extract<DeploymentReceiptDispatchV1, { actionId: 'deployments.teardown' }>;
    receipt: DeploymentReceiptDetailV1;
    writeTransition: OwnServerDeploymentTargetHostInput['writeTransition'];
}>): Promise<Result | null> {
    const { request, receipt } = input;
    if (receipt.deployment.state === 'succeeded' || receipt.deployment.state === 'cancelled') return null;
    if (request.context.operationAcceptance?.operationId !== receipt.deployment.actionOperationId) return failure('deployment_conflict');
    if (receipt.deployment.cancelRequestedAtMs !== undefined || request.context.signal?.aborted) return failure('cancelled');
    if (receipt.deployment.state !== 'failed' && receipt.deployment.state !== 'outcome_unknown') return null;
    return input.writeTransition({ environmentId: request.input.environmentId, deploymentId: receipt.deployment.id,
        receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision,
        state: 'running', content: receipt.content, context: request.context });
}
const kinds: Record<DeploymentTeardownStepV1, readonly DeploymentTeardownResourceV1['kind'][]> = {
    admit: [], settleDeploy: [], removeTarget: ['workload', 'network', 'data', 'providerResource'], removeDomain: ['domain'],
    removeRelease: ['release'], withdrawBindings: ['binding'], verify: ['workload', 'network', 'data', 'domain', 'release', 'binding', 'providerResource'],
};

export function selectDeploymentTeardownStepResources(input: Readonly<{
    resources: readonly DeploymentTeardownResourceV1[]; step: DeploymentTeardownStepV1; machineId: string;
    allMachines: boolean;
}>): DeploymentTeardownResourceV1[] {
    return input.resources.filter(resource => kinds[input.step].includes(resource.kind)
        && (resource.machineId === input.machineId || resource.machineId === undefined && input.allMachines));
}

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
        const environment = await host.readEnvironment({ environmentId: request.input.environmentId,
            targetLinkId: request.input.targetLinkId, context: request.context });
        const link = environment.targetLinks.find(item => item.targetLink.id === request.input.targetLinkId)?.targetLink;
        const selected = environment.targetLinks.find(item => item.targetLink.id === environment.environment.runtimeTargetLinkId)?.targetLink;
        const intent = receipt.content.teardown;
        if (receipt.deployment.state === 'queued' && receipt.deployment.revision === 1 && intent?.proofs.length) {
            return failure('deployment_invalid');
        }
        if (request.input.serverId !== host.serverId || !link || !intent || receipt.deployment.operation !== 'teardown'
            || receipt.deployment.environmentId !== request.input.environmentId || receipt.deployment.targetLinkId !== link.id
            || intent.targetLinkRevision + (receipt.deployment.state === 'succeeded'
                && intent.machines.length === link.machines.length ? 1 : 0) !== link.revision
            || intent.reason !== request.input.reason
            || !isDeepStrictEqual(intent.machines.map(member => member.machineId), request.input.machines ?? link.machines)
            || intent.machines.some(member => !link.members.some(current => current.machineId === member.machineId
                && current.installationId === member.installationId))
            || (selected && selected.id !== link.id && intent.machines.some(member => selected.machines.includes(member.machineId)))) return failure('deployment_conflict');
        const result = (): DeploymentReceiptResultV1 => ({ ok: true, environmentId: receipt.deployment.environmentId,
            revision: environment.environment.revision, deploymentId: receipt.deployment.id,
            deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state });
        if (receipt.deployment.state === 'succeeded' || receipt.deployment.state === 'cancelled') return result();
        const resumed = await resumeDeploymentTeardownReceiptForHost({ request, receipt, writeTransition: host.writeTransition });
        if (resumed) {
            if (!resumed.ok) return resumed;
            receipt = await read();
        }

        const write = async (state: OwnServerDeploymentTransition['state'], proof?: DeploymentTeardownStepProofV1) => {
            const current = receipt.content.teardown!;
            const proofs = proof ? [...current.proofs.filter(item => item.step !== proof.step || item.machineId !== proof.machineId), proof] : current.proofs;
            const { failure: _failure, ...withoutFailure } = receipt.content;
            const currentContent = state === 'succeeded' ? withoutFailure : receipt.content;
            const content = proof ? { ...currentContent, teardown: { ...current, proofs } } : currentContent;
            if (state === receipt.deployment.state && isDeepStrictEqual(content, receipt.content)) return null;
            const teardownProof: OwnServerDeploymentTransition['teardownProof'] = state === 'succeeded'
                ? { targetLinkRevision: intent.targetLinkRevision, machines: intent.machines, workloadAbsent: true,
                    steps: [...DEPLOYMENT_TEARDOWN_STEPS_V1],
                    retainedProviderResource: intent.resources.some(resource => resource.disposition === 'retain' && resource.kind === 'providerResource') }
                : undefined;
            const finalRemoval = state === 'succeeded' && request.input.removeEnvironment === true;
            const response = await host.writeTransition({ environmentId: receipt.deployment.environmentId,
                deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision,
                state, content, context: request.context,
                ...(teardownProof ? { teardownProof } : {}),
            }).catch(error => {
                if (finalRemoval) return projectDeploymentTransitionOutcomeUnknownForHost(error);
                throw error;
            });
            if (!response.ok) {
                if (!finalRemoval) return response;
                const details: DeploymentTeardownEnvironmentPartialDetailsV1 = {
                    environmentId: request.input.environmentId, step: 'removeEnvironment', partial: true,
                    requiredFact: 'environmentRemoval',
                    remedy: 'Check whether the Environment still exists. If it remains, resolve the Home removal failure and retry Stop and remove.',
                };
                return { ...response, details };
            }
            // Committed removal makes the Environment unreadable. The signed
            // transition response is the final outcome, including its removal fact.
            if (state === 'succeeded') return response;
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
                const resources = selectDeploymentTeardownStepResources({ resources: intent.resources, step,
                    machineId: member.machineId, allMachines: intent.machines.length === link.machines.length });
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
                let failureCause: ActionExecuteFailure['failureCause'];
                try { observed = await boundary.observe(operation); }
                catch (error) {
                    failureCause = normalizeActionExecutorThrownError(error, 'deployment.teardown.observe').failureCause;
                    observed = { kind: 'unknown', reason: failureCause?.errorCode ?? 'observation_unavailable' };
                }
                if (observed.kind === 'needed') {
                    const started = await write('running', { step, ...member, state: 'running', resources: [] });
                    if (started) return started;
                    const current = await read();
                    if (current.deployment.cancelRequestedAtMs !== undefined || current.deployment.state === 'cancelled'
                        || request.context.signal?.aborted) return failure('cancelled');
                    try { observed = await boundary.execute(operation); }
                    catch (error) {
                        failureCause = normalizeActionExecutorThrownError(error, 'deployment.teardown.execute').failureCause;
                        observed = { kind: 'unknown', reason: failureCause?.errorCode ?? 'removal_unproved' };
                    }
                }
                if (observed.kind === 'proved') {
                    if (!complete(observed.resources)) observed = { kind: 'unknown', reason: 'resource_proof_incomplete' };
                }
                if (observed.kind === 'proved') {
                    const saved = await write('running', { step, ...member, state: 'succeeded', resources: observed.resources });
                    if (saved) return saved;
                } else {
                    const state = observed.kind === 'failed' ? 'failed' : 'outcome_unknown';
                    const reason = observed.kind === 'needed' ? 'removal_unproved' : observed.reason;
                    const saved = await write(state, { step, ...member, state, resources: [],
                        reason });
                    const { ok: _ok, ...receiptDetails } = result();
                    return saved ?? { ok: false, errorCode: state === 'failed' ? 'deployment_failed' : 'outcome_unknown',
                        error: `${step}: ${state}`, details: { ...receiptDetails, step, reason },
                        ...(failureCause ? { failureCause } : {}) };
                }
            }
        }
        return await write('succeeded') ?? result();
    };
}
