import { MACHINE_LIVE_STREAM_SOCKET_EVENT, type MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { type MachineLiveStreamContentV1, MachineLiveStreamPayloadErrorV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';

import { apiSocket } from '@/sync/api/session/apiSocket';
import { createMachineLiveStreamSocketTransport } from '@/sync/domains/machines/peer/mediation/stream/socketTransport';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { createServerRequestForExplicitServerScope } from './createServerRequestWithServerScope';
import { resolveScopedMachineTransport } from './serverScopedRpcPool';
import { resolveRunnerMachineContentKeyTrustV1 } from '@/sync/domains/machines/runnerMachineContentKeyTrust';

import { createServerScopedRelaySocket, type ServerScopedRelaySocket } from './serverScopedRelaySocket';

/**
 * Production live-stream relay transport. The shared server-scoped relay helper chooses
 * the active authenticated `apiSocket` or an ephemeral target-server socket; this binding
 * only supplies the live-stream envelope event and viewer metadata.
 */
export type ServerScopedMachineLiveStreamRelaySocket = Readonly<{
    scopeUserId: string;
    machineId: string;
    /**
     * The viewer's account/profile id. This is the watcher identity — NOT a machine id. The
     * previous relay surface mis-used `scopeUserId` as `targetMachineId`; callers must thread
     * this as the viewer id and never as a machine id (C4).
     */
    viewerId: string;
    /**
     * The per-tab socket id of THIS viewer connection. When present the server relay delivers
     * frames to exactly this tab via `io.to(socketId)`. If unavailable, the simulator product
     * path fails closed before opening the relay. May change across reconnects — read at
     * relay-open time.
     */
    socketId: string;
    sendEnvelope: (payload: MachineLiveStreamRelayEnvelopeV1) => void;
    onEnvelope: (listener: (payload: MachineLiveStreamRelayEnvelopeV1) => void) => () => void;
    disconnect: () => Promise<void>;
}>;

export async function resolveServerScopedMachineLiveStreamRelaySocket(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number;
}>): Promise<ServerScopedMachineLiveStreamRelaySocket> {
    const socket = await createServerScopedRelaySocket<MachineLiveStreamRelayEnvelopeV1>({
        machineId: params.machineId,
        serverId: params.serverId,
        timeoutMs: params.timeoutMs,
        missingScopeUserProfileErrorMessage: 'Active account profile id is unavailable for machine live-stream relay',
        getActiveSocketId: () => apiSocket.getSocketId(),
        createActiveTransport: {
            send: (payload) => {
                apiSocket.sendMachineLiveStreamRelayEnvelope(payload);
            },
            on: (listener) => apiSocket.onMachineLiveStreamRelayEnvelope(listener),
        },
        createScopedTransport: (scopedSocket, context) => {
            const listeners = new Set<(envelope: MachineLiveStreamRelayEnvelopeV1) => void>();
            let current = true;
            let contentRead: Promise<MachineLiveStreamContentV1> | null = null;
            const transport = createMachineLiveStreamSocketTransport({
                emit: (wire) => scopedSocket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, wire),
                deliver: (decoded) => { for (const listener of listeners) listener(decoded); },
                isCurrent: () => current,
                // Failure is delivered as a typed terminal stop by the shared framing owner.
                onError: (error) => console.warn('[Live stream] Scoped payload rejected', { code: error.code }),
                resolveContent: async (machineId) => {
                    if (machineId !== context.machineId) throw new MachineLiveStreamPayloadErrorV1('stream_payload_binding_mismatch');
                    contentRead ??= (async (): Promise<MachineLiveStreamContentV1> => {
                        const credentials = context.credentials ?? { token: context.token };
                        const request = createServerRequestForExplicitServerScope({
                            serverUrl: context.targetServerUrl, token: context.token,
                            runtimeOrigin: context.runtimeOrigin, homeCarrier: context.homeCarrier,
                            timeoutMs: context.timeoutMs,
                        });
                        const { mode } = await fetchAccountEncryptionCurrentness(credentials, { request });
                        const trust = mode === 'e2ee' ? await resolveRunnerMachineContentKeyTrustV1({
                            credentials, homeServerIdentityId: context.targetServerId, machineId,
                        }) : null;
                        if (mode === 'e2ee' && !trust) throw new MachineLiveStreamPayloadErrorV1('stream_encryption_material_unavailable');
                        const machine = await resolveScopedMachineTransport({
                            serverId: context.targetServerId, serverUrl: context.targetServerUrl,
                            runtimeOrigin: context.runtimeOrigin, homeCarrier: context.homeCarrier,
                            token: context.token, machineId, accountId: context.targetAccountId,
                            expectedAccountMode: mode, expectedRunnerBinding: trust?.expectedRunnerBinding,
                            trustedMachineKind: trust?.trustedMachineKind, timeoutMs: context.timeoutMs,
                            ...(context.encryption ? { decryptEncryptionKey: (value: string) => context.encryption!.decryptEncryptionKey(value) } : {}),
                        });
                        if (!machine || machine.mode !== mode) throw new MachineLiveStreamPayloadErrorV1('stream_payload_mode_mismatch');
                        if (machine.mode === 'plain') return { mode: 'plain' };
                        if (!context.encryption) throw new MachineLiveStreamPayloadErrorV1('stream_encryption_material_unavailable');
                        await context.encryption.initializeMachines(new Map([[machineId, machine.dataKey]]));
                        const cipher = context.encryption.getMachineEncryption(machineId);
                        if (!cipher) throw new MachineLiveStreamPayloadErrorV1('stream_encryption_material_unavailable');
                        return { mode: 'e2ee', cipher };
                    })();
                    return await contentRead;
                },
            });
            scopedSocket.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, transport.receive);
            return {
                send: transport.send,
                on: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
                dispose: () => {
                    current = false; listeners.clear();
                    scopedSocket.off(MACHINE_LIVE_STREAM_SOCKET_EVENT, transport.receive);
                },
            };
        },
    }) as ServerScopedRelaySocket<MachineLiveStreamRelayEnvelopeV1>;

    return {
        scopeUserId: socket.scopeUserId,
        machineId: socket.machineId,
        viewerId: socket.scopeUserId,
        socketId: socket.socketId ?? '',
        sendEnvelope: socket.sendEnvelope,
        onEnvelope: socket.onEnvelope,
        disconnect: socket.disconnect,
    };
}
