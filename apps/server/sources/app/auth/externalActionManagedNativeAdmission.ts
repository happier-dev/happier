import type { ExternalActionExecutionAuthorizationBindingV1, ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionManagedRecoveryAdmissionV1Schema, projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineAdmission } from '@happier-dev/protocol/machines/machineAccessV1';
import { ManagedMachineError, sameManagedInput } from '@/app/machines/managed/managedRows';
import { resolveManagedCredentialDeliveryMachineAdmissionInTx, type ManagedCredentialConsumerCurrentness } from '@/app/machines/managed/credentialDeliveryAdmission';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import type { Tx } from '@/storage/inTx';

export interface ExternalActionManagedAdmissionContext {
    envelope?: ExternalActionRequestEnvelope;
    /** Verified or freshly minted Home binding, never an unverified caller claim. */
    executionBinding?: ExternalActionExecutionAuthorizationBindingV1;
    authentication?: TeamOperationAuthenticationContext;
    sessionActionOrigin?: ExternalActionExecutionAuthorizationBindingV1['sessionActionOrigin'];
    sessionActionSource?: ExternalActionExecutionAuthorizationBindingV1['sessionActionSource'];
    managedCredentialConsumer?: ManagedCredentialConsumerCurrentness;
}

export function isExternalActionManagedResourceAction(actionId: string): boolean {
    return actionId === 'machines.managed.credentials.install'
        || actionId === 'machines.managed.inspect' || actionId === 'machines.managed.bootstrap.retry'
        || actionId === 'action.operations.list' || actionId === 'action.operations.get';
}

export function readExternalActionManagedRecoveryAdmission(actionId: string, envelope: ExternalActionRequestEnvelope) {
    if (!isExternalActionManagedResourceAction(actionId)) return undefined;
    const projection = envelope.v === 1 ? projectExternalActionManagedAdmissionV1(actionId, envelope.input) : envelope.managedAdmission;
    // Ordinary Machine-authorized operation reads retain their existing route;
    // only an explicit resource scope asks for creator admission.
    if (projection === undefined && (actionId === 'action.operations.list' || actionId === 'action.operations.get')) return undefined;
    const parsed = ExternalActionManagedRecoveryAdmissionV1Schema.safeParse(projection);
    if (!parsed.success || parsed.data.actionId !== actionId || envelope.managedAdmission !== undefined
        && !sameManagedInput(parsed.data, envelope.managedAdmission)) throw new ManagedMachineError('invalid_request');
    return parsed.data;
}

/** The exact signed native delivery effect has one admission owner for every caller. */
export async function resolveManagedNativeCredentialActionMachineAdmissionInTx(reader: Tx,
    input: ExternalActionManagedAdmissionContext & Readonly<{
        actorAccountId: string; machineId: string; actionId: 'machines.managed.credentials.install'; requireOnline?: boolean;
    }>): Promise<MachineAdmission> {
    const denied = { kind: 'denied', code: 'access_denied' } as const;
    try {
        const projection = input.envelope ? readExternalActionManagedRecoveryAdmission(input.actionId, input.envelope)
            : input.executionBinding?.managedAdmission;
        const root = input.executionBinding;
        if (projection?.actionId !== input.actionId || root && (root.actionId !== input.actionId
            || root.accountId !== input.actorAccountId || root.machineId !== input.machineId
            || root.target.kind !== 'machine' || root.target.machineId !== input.machineId
            || root.serverIdentityId !== projection.input.homeId
            || !sameManagedInput(root.managedAdmission, projection))) return denied;
        return await resolveManagedCredentialDeliveryMachineAdmissionInTx(reader, {
            actorAccountId: input.actorAccountId, machineId: input.machineId, request: projection.input,
            authentication: { env: input.authentication?.env ?? process.env,
                authority: input.authentication?.authenticationAuthority ?? 'account_automation',
                authenticationEvidence: input.authentication?.authenticationEvidence },
            sessionActionOrigin: input.sessionActionOrigin ?? root?.sessionActionOrigin,
            sessionActionSource: input.sessionActionSource ?? root?.sessionActionSource,
            managedCredentialConsumer: input.managedCredentialConsumer,
            ...(root ? { continuingRequestId: root.requestId } : {}),
            ...(input.requireOnline === undefined ? {} : { requireOnline: input.requireOnline }),
        });
    } catch (error) {
        if (error instanceof ManagedMachineError) return denied;
        throw error;
    }
}
