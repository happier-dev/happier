import type { Socket } from 'socket.io';

import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PluginUiMachineServiceReadReferenceV1Schema } from '@happier-dev/protocol/daemon/machineServiceLogsResource';
import { resolvePluginUiHostReadActionIdV1 } from '@happier-dev/protocol/plugins/ui/subscriptions';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { auth } from '@/app/auth/auth';
import { projectExternalActionBoundPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { readActiveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { inTx } from '@/storage/inTx';
import { readCurrentSocketCredential } from './socketCredentialCurrentness';
import type { ExternalActionDaemonDispatcher } from './externalActionDispatcher';

type Continuation = NonNullable<NonNullable<Parameters<ExternalActionDaemonDispatcher>[1]>['continuation']>;
const refused = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });

const nativeResourceActionIds = new Set(PluginUiMachineServiceReadReferenceV1Schema.def.options
    .map(schema => schema.shape.hostRead.def.values[0]!)
    .map(resolvePluginUiHostReadActionIdV1));

/** The mint admitted the Action. Bind that proof to this Account's live socket and exact watch receiver. */
export async function forwardHostResourceWatch(input: Readonly<{
    actorAccountId: string;
    socket: Socket;
    machineId: string;
    request: unknown;
    forward: ExternalActionDaemonDispatcher;
    continuation: Continuation;
}>) {
    const parsed = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(input.request);
    if (!parsed.success || input.socket.data.clientType !== 'user-scoped') return refused(RPC_ERROR_CODES.FORBIDDEN);
    const { executionAuthorization, envelope, machineId } = parsed.data;
    if (!executionAuthorization || machineId !== input.machineId) return refused(RPC_ERROR_CODES.FORBIDDEN);
    const credential = await readCurrentSocketCredential(input.actorAccountId, input.socket);
    if (credential?.authTokenKind !== 'account') return refused(RPC_ERROR_CODES.FORBIDDEN);
    const root = await auth.verifyExternalActionExecutionAuthorization(executionAuthorization.token);
    if (!root || !('authentication' in root) || root.authentication.kind !== 'account'
        || root.authentication.tokenEpoch !== credential.tokenEpoch || root.accountId !== input.actorAccountId
        || root.serverIdentityId !== await getOrCreateServerIdentityId() || root.sessionActionOrigin || root.workflowActionOrigin
        || !sameStrictJsonValue(root, executionAuthorization.binding) || !nativeResourceActionIds.has(root.actionId)
        || !isExternalActionAuthorizationBoundToEnvelope(root, { actionId: root.actionId, machineId, envelope })
        || (envelope.v === 1 && envelope.resourceContinuation?.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)) {
        return refused(RPC_ERROR_CODES.FORBIDDEN);
    }
    const principal = projectExternalActionBoundPrincipal(root, {
        accountId: input.actorAccountId, authority: credential.authority, authentication: root.authentication,
    }, credential.authority);
    if (!principal) return refused(RPC_ERROR_CODES.FORBIDDEN);
    const admittedMachine = await inTx(async tx => {
        if (!await auth.isSignedCredentialCurrent(tx, root.accountId, credential.tokenEpoch)) return null;
        return readActiveMachineAdmissionInTx(tx, { actorAccountId: root.accountId, machineId });
    });
    if (!admittedMachine || admittedMachine.installationId !== root.installationId
        || admittedMachine.custodianAccountId !== root.custodianAccountId) return refused(RPC_ERROR_CODES.FORBIDDEN);
    if (input.continuation.cancellation.signal.aborted) return refused(RPC_ERROR_CODES.FORBIDDEN);
    // Current Machine access can be broader than the signed Resource admission.
    const role = root.admittedMachineRole === 'use' ? 'use' : admittedMachine.role;
    const result = await input.forward({ actionId: root.actionId, envelope, executionAuthorization, principal,
        admittedMachine: { ...admittedMachine, role }, admittedAuthenticationEvidence: credential.authenticationEvidence }, {
        signal: input.continuation.cancellation.signal, continuation: input.continuation,
    });
    if (result.kind === 'response') return { ok: true as const, result: result.prepared.response };
    if (result.kind === 'placement_error') return { ...refused(result.code),
        ...(result.failureCause ? { failureCause: result.failureCause } : {}) };
    return refused(result.kind === 'invalid_request' ? result.errorCode : RPC_ERROR_CODES.OUTCOME_UNKNOWN);
}
