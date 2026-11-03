import type { ExternalActionExecutionAuthorizationBindingV1, ExternalActionMachineRpcExecutionV1,
    ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { isExternalActionAuthorizationBoundToEnvelope, readSessionSpawnNativeCredentialChildV1,
    verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { resolveManagedCredentialDeliveryMachineAdmissionInTx } from '@/app/machines/managed/credentialDeliveryAdmission';
import { readSessionTeamCredentialNativeSelectionInTx } from '@/app/teams/credentials/nativeDeliveryRead';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Tx } from '@/storage/inTx';

/** The installed host signs only after ordinary spawn approval and actual birth.
 * The saved root identity narrows that effect; a minted root/birth alone is not approval. */
export async function readExternalActionNativeCredentialSpawnChildInTx(tx: Tx, input: Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1;
    execution: ExternalActionMachineRpcExecutionV1;
    request: Readonly<{ method: string; requestId: string; params?: unknown; originalActionEnvelope?: ExternalActionRequestEnvelope }>;
    authentication: SessionAccessAuthentication;
}>) {
    const { binding, execution, request } = input;
    const separator = request.method.indexOf(':');
    const child = readSessionSpawnNativeCredentialChildV1({ rootActionId: binding.actionId,
        effectActionId: execution.effectActionId, method: request.method.slice(separator + 1),
        managedAdmission: execution.managedAdmission, params: request.params });
    if (!child || separator < 1 || !request.originalActionEnvelope
        || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId,
            machineId: binding.machineId, envelope: request.originalActionEnvelope })
        || execution.installationId !== binding.installationId
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId) return null;
    const selected = await readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: child.sessionId });
    if (!selected.ok || selected.binding.accountId !== binding.accountId
        || !sameStrictJsonValue(selected.binding.creationAuthorization, {
            serverIdentityId: binding.serverIdentityId, requestId: binding.requestId,
            requestEnvelopeDigest: binding.requestEnvelopeDigest, machineId: binding.machineId,
            installationId: binding.installationId,
        }) || selected.binding.providerModelSelection.executionMachineId !== binding.machineId) return null;
    if (request.originalActionEnvelope.v === 1) {
        const root = request.originalActionEnvelope.input;
        const intents = root !== null && typeof root === 'object' && !Array.isArray(root)
            ? SessionTeamCredentialBindingIntentsV1Schema.safeParse(Reflect.get(root, 'teamCredentialBindings')) : null;
        const intent = intents?.success ? intents.data.find(value => value.slot.kind === 'provider_model'
            && value.resourceId === selected.binding.resourceId && value.deliveryMode === 'vendor-native') : undefined;
        if (!intent || intent.resourceId === null || intent.expectedResourceRevision !== selected.binding.resourceRevision
            || !sameStrictJsonValue(intent.providerModelSelection, selected.binding.providerModelSelection)) return null;
    }
    // Encrypted original input is checked by the same installed source before
    // signing; Home verifies its signature and exact persisted birth association.
    const source = await tx.machine.findUnique({ where: { id: binding.machineId }, select: {
        accountId: true, installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true,
    } });
    if (!source?.installationPublicKey || source.accountId !== binding.custodianAccountId
        || source.installationId !== binding.installationId || classifyMachineAvailabilityState(source) !== 'available'
        || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: execution.reviewedChild, authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext, effectActionId: execution.effectActionId,
            target: execution.target, installationId: execution.installationId, event: SOCKET_RPC_EVENTS.CALL,
            method: request.method, requestId: request.requestId, ...(request.params === undefined ? {} : { params: request.params }),
            managedAdmission: execution.managedAdmission, publicKey: source.installationPublicKey,
            signature: execution.machineSignature })) return null;
    const admission = await resolveManagedCredentialDeliveryMachineAdmissionInTx(tx, {
        actorAccountId: binding.accountId, machineId: request.method.slice(0, separator), request: child,
        authentication: input.authentication,
        nativeCredentialSpawnPreparation: true,
    });
    return admission.kind === 'admitted' ? admission : null;
}
