import { callSocketRpc } from '@happier-dev/sync-client';
import { respondToManagedInstallation } from '@happier-dev/protocol/machines/managed/installationResponse';
import { unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { ActionOperationGetV1ResponseSchema, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { parseCapabilitiesInvokeResponse } from '@happier-dev/protocol/capabilities/invokeResponse';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { hasStoredSessionCredentialProvenance, type StoredCredentials } from '@/persistence';
import { readManagedMachineRead, openManagedMachineRead } from '@/machines/managed/readManagedMachine';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { withUserScopedRpcSocket } from '@/session/transport/rpc/withUserScopedRpcSocket';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { observeServerProfileHomeConnection } from '@/server/profileObservation';

/** A command-line invocation is itself an answering client; no App or daemon acquires its credential custody. */
export function createCliManagedInstallationRespond(params: Readonly<{
    credentials: StoredCredentials; serverId: string; serverIdentityId?: string; serverUrl: string;
}>): NonNullable<ActionExecutorDeps['machineManagedInstallationRespond']> {
    return async (input, context) => {
        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        const scope = (id: string) => id === params.serverId || id === params.serverIdentityId ? params.serverId : null;
        if (!areServerProfileIdentifiersEquivalent(input.serverId, params.serverId, scope)
            || context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, params.serverId, scope)) return fail('server_target_mismatch');
        const accountId = readAccountIdFromToken(params.credentials.token);
        if (!accountId) return fail('action_account_scope_changed');
        const invoke = async (machineId: string, method: string, request: unknown, signal?: AbortSignal) =>
            callExactMachineRpc({ credentials: params.credentials, serverUrl: params.serverUrl,
                machineId, method, request, timeoutMs: null, ...(signal ? { signal } : {}) });
        const parseResponse = (raw: unknown) => parseCapabilitiesInvokeResponse(raw)
            ?? { ok: false as const, error: { code: 'managed_response_invalid', message: 'Invalid managed installation response' } };
        const provenance = readAuthTokenProvenance(decodeJwtPayload(params.credentials.token), { allowLegacyHome: true })?.provenance;
        const terminalPairingAuthority = provenance?.kind === 'terminal'
            && hasStoredSessionCredentialProvenance(params.credentials) && isPresentUserHostInvocation(context)
            && input.purpose === 'approve' && input.prompt.kind === 'auth.approveRemoteProvisioning';
        return respondToManagedInstallation(input, context, {
            accountId, homeId: params.serverIdentityId,
            accountAuthority: provenance?.kind === 'account' || terminalPairingAuthority,
            assertCurrent: () => context.signal?.throwIfAborted(),
            readMachine: async (request, signal) => {
                const read = await readManagedMachineRead({ credentials: params.credentials, serverHttpBaseUrl: params.serverUrl,
                    homeId: request.homeId, managedId: request.managedId, ...(signal ? { signal } : {}) });
                const machine = await openManagedMachineRead({ credentials: params.credentials, serverHttpBaseUrl: params.serverUrl,
                    read, ...(signal ? { signal } : {}) });
                return { originalMachine: unwrapManagedMachineReadV1(read), machine };
            },
            readOperation: async (machineId, operationId, signal) => ActionOperationGetV1ResponseSchema.parse(
                await invoke(machineId, ACTION_OPERATION_RPC_METHODS_V2.get, { operationId }, signal)),
            invokeTask: async (machineId, response, signal) => parseResponse(await invoke(machineId,
                RPC_METHODS.CAPABILITIES_INVOKE, { id: 'tool.systemTasks', method: 'respond', params: response }, signal)),
            // This is the same finite Home-authorized purpose as the UI. It carries no controller key or Machine grant.
            invokeInstallation: async (response, signal) => withUserScopedRpcSocket({
                token: params.credentials.token, serverUrl: params.serverUrl,
                connectTimeoutMs: resolveSessionControlSocketConnectTimeoutMs(), signal,
            }, async (socket, connect, requestSignal) => {
                await connect();
                return parseResponse(await callSocketRpc({ socket, target: { kind: 'machine', id: response.controller!.machineId },
                    method: RPC_METHODS.CAPABILITIES_INVOKE,
                    params: { id: 'tool.systemTasks', method: 'respond', params: response },
                    content: { mode: 'plain' }, timeoutMs: null, signal: requestSignal }));
            }),
            approvePairing: async (pairing, signal) => {
                // The admitted Action connection can observe a new approval ingress
                // even when the saved descriptor still names a retired one.
                const { profile } = await observeServerProfileHomeConnection({ profileId: params.serverId,
                    serverUrl: params.serverUrl, token: params.credentials.token, signal });
                const descriptor = profile.homeConnectionDescriptor;
                if (descriptor?.homeServerIdentityId !== input.homeId) return 'server_target_mismatch';
                const target = resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile', profile });
                await approveTerminalAuthRequest({ publicKey: pairing.publicKey, pairing: pairing.pairing,
                    supportsTokenOnly: pairing.supportsTokenOnly, target, accountCredentials: params.credentials, signal });
                return undefined;
            },
        });
    };
}
