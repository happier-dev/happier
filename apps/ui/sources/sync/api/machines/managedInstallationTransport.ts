import { callSocketRpc } from '@happier-dev/sync-client';
import { ManagedInstallationResponseV1Schema, type ManagedInstallationResponseV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { createScopedSocketConnectParams } from '@/sync/runtime/orchestration/serverScopedRpc/createScopedSocketConnectParams';
import { resolveServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { parseCapabilitiesInvokeResponse, type CapabilitiesInvokeResponse } from '@/sync/api/capabilities/capabilitiesProtocol';

/** Transient exact installer purpose over the captured Account socket. No controller key or Machine grant is acquired. */
export async function invokeManagedInstallationResponse(params: Readonly<{
    account: LazyActionAccountContext; input: ManagedInstallationResponseV1; signal?: AbortSignal;
}>): Promise<CapabilitiesInvokeResponse> {
    const { account } = params;
    const input = ManagedInstallationResponseV1Schema.parse(params.input);
    const controller = input.controller;
    account.assertCurrent();
    if (!controller || account.credentialAuthorityKind !== 'account' || !account.credentials || account.serverIdentityId !== input.homeId) {
        return { ok: false, error: { code: 'permission_denied', message: 'Managed installation purpose is unavailable' } };
    }
    return withActionAccountRequestSignal(account, params.signal, async signal => {
        const home = await account.resolveHomeTarget();
        account.assertCurrent();
        const transport = await resolveServerScopedTransport({ credentials: account.credentials,
            profile: { serverUrl: home.canonicalAuthUrl, ...(home.descriptor ? { homeConnectionDescriptor: home.descriptor } : {}) } });
        let transferred = false;
        try {
            const socket = await createEphemeralServerSocketClient({ ...createScopedSocketConnectParams({
                targetServerId: input.homeId, targetServerUrl: transport.canonicalServerUrl,
                runtimeOrigin: transport.runtimeOrigin, carrier: transport.carrier, homeCarrier: transport.homeCarrier,
                token: account.credentials.token, timeoutMs: DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
            }, () => { transferred = true; return transport.release; }), signal });
            try {
                account.assertCurrent();
                const raw = await callSocketRpc<unknown>({ randomBytes: getRandomBytes, socket,
                    target: { kind: 'machine', id: controller.machineId }, method: RPC_METHODS.CAPABILITIES_INVOKE,
                    params: { id: 'tool.systemTasks', method: 'respond', params: input }, content: { mode: 'plain' },
                    timeoutMs: null, signal, onIssued: () => account.assertCurrent() });
                account.assertCurrent();
                return parseCapabilitiesInvokeResponse(raw) ?? { ok: false,
                    error: { code: 'managed_response_invalid', message: 'Managed installation response is unavailable' } };
            } finally { socket.disconnect(); }
        } finally { if (!transferred) await transport.release(); }
    });
}
