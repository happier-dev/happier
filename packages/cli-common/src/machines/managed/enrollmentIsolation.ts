import { MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationSetResultV1Schema, agentIsolationMetadataFieldV1, projectMachineAgentIsolationUnavailableStatusV1, type MachineAgentIsolationPreviewInputV1, type MachineAgentIsolationSetInputV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import type { resolveManagedMachineEnrollmentAgentIsolationV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineControllerError } from './controllerErrors.js';

export type ManagedEnrollmentIsolationRequest = Readonly<
    { actionId: 'machines.agentIsolation.preview'; input: MachineAgentIsolationPreviewInputV1 }
    | { actionId: 'machines.agentIsolation.set'; input: MachineAgentIsolationSetInputV1 }>;

/** Both hosts derive the set operand from the same guest policy preview. */
export async function applyManagedMachineEnrollmentIsolation(params: Readonly<{
    target: Pick<MachineAgentIsolationPreviewInputV1, 'serverId' | 'machineId'>;
    policy: NonNullable<ReturnType<typeof resolveManagedMachineEnrollmentAgentIsolationV1>>;
    dispatch: (request: ManagedEnrollmentIsolationRequest) => Promise<unknown>;
}>): Promise<void> {
    const { target, policy, dispatch } = params;
    const preview = MachineAgentIsolationPreviewResultV1Schema.safeParse(await dispatch({ actionId: 'machines.agentIsolation.preview',
        input: { ...target, ...policy } }));
    if (!preview.success) throw new ManagedMachineControllerError('action_outcome_unknown');
    if (preview.data.kind === 'unavailable') throw new ManagedMachineControllerError(preview.data.status.code, undefined, {
        kind: 'managedAgentIsolation', phase: 'machines.agentIsolation.preview',
        status: projectMachineAgentIsolationUnavailableStatusV1(preview.data),
    });
    // A settled matching guest needs no mutation or new approval on Retry.
    if (agentIsolationMetadataFieldV1.equal(preview.data.policy, policy)
        && preview.data.status.kind === (policy.enabled ? 'effective' : 'disabled')
        && !preview.data.plan.requiresAdmin && preview.data.plan.sessionsToReplace === 0) return;
    const result = MachineAgentIsolationSetResultV1Schema.safeParse(await dispatch({ actionId: 'machines.agentIsolation.set', input: {
        ...target, ...policy, expectedMetadataVersion: preview.data.metadataVersion,
        expectedPolicy: preview.data.policy, expectedPlanDigest: preview.data.plan.planDigest,
    } }));
    if (!result.success) throw new ManagedMachineControllerError('action_outcome_unknown');
    if (result.data.kind === 'failed') throw new ManagedMachineControllerError(result.data.code);
    if (result.data.kind === 'plan_changed' || result.data.kind === 'conflict') throw new ManagedMachineControllerError(result.data.kind);
    // Applying is not effective. The runtime owner still refuses first Agent
    // admission until its own native readiness and replacement have settled.
}
