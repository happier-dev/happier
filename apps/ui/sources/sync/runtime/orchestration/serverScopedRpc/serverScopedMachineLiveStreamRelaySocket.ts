import { MACHINE_LIVE_STREAM_SOCKET_EVENT, type MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { MachineLiveStreamPayloadErrorV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';

import { apiSocket } from '@/sync/api/session/apiSocket';
import { createMachineLiveStreamSocketTransport, type ResolvedMachineLiveStreamContent } from '@/sync/domains/machines/peer/mediation/stream/socketTransport';
import { resolveMachineLiveStreamContent } from './resolveMachineLiveStreamContent';

import { createServerScopedRelaySocket, type ServerScopedRelaySocket } from './serverScopedRelaySocket';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

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
     * relay-open time. Mounted readers subscribe through `onSocketIdChange`.
     */
    socketId: string;
    /** Notify mounted readers when Socket.IO retires or replaces this connection. */
    onSocketIdChange: (listener: () => void) => () => void;
    sendEnvelope: (payload: MachineLiveStreamRelayEnvelopeV1) => void;
    onEnvelope: (listener: (payload: MachineLiveStreamRelayEnvelopeV1) => void) => () => void;
    disconnect: () => Promise<void>;
}>;

export async function resolveServerScopedMachineLiveStreamRelaySocket(params: Readonly<{
    machineId: string;
    sessionId?: string;
    serverId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    timeoutMs?: number;
}>): Promise<ServerScopedMachineLiveStreamRelaySocket> {
    const socket = await createServerScopedRelaySocket<MachineLiveStreamRelayEnvelopeV1>({
        machineId: params.machineId,
        serverId: params.serverId,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        accountLifetime: params.accountLifetime,
        timeoutMs: params.timeoutMs,
        missingScopeUserProfileErrorMessage: 'Active account profile id is unavailable for machine live-stream relay',
        getActiveSocketId: () => apiSocket.getSocketId(),
        onActiveSocketIdChange: listener => apiSocket.onStatusChange(listener),
        createActiveTransport: {
            send: (payload) => {
                apiSocket.sendMachineLiveStreamRelayEnvelope(payload);
            },
            on: (listener) => apiSocket.onMachineLiveStreamRelayEnvelope(listener),
        },
        createScopedTransport: (scopedSocket, context) => {
            const listeners = new Set<(envelope: MachineLiveStreamRelayEnvelopeV1) => void>();
            let current = true;
            let contentRead: Promise<ResolvedMachineLiveStreamContent> | null = null;
            const transport = createMachineLiveStreamSocketTransport({
                emit: (wire) => scopedSocket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, wire),
                deliver: (decoded) => { for (const listener of listeners) listener(decoded); },
                isCurrent: () => current,
                // Failure is delivered as a typed terminal stop by the shared framing owner.
                onError: (error) => console.warn('[Live stream] Scoped payload rejected', { code: error.code }),
                resolveContent: async (machineId) => {
                    if (machineId !== context.machineId) throw new MachineLiveStreamPayloadErrorV1('stream_payload_binding_mismatch');
                    contentRead ??= resolveMachineLiveStreamContent(context, params.sessionId);
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

    // Capture admission can finish after a viewer disappears. Keep this logical carrier until
    // its ingestion subscriber has sent the final Stop and released its interest.
    const readers = new Set<() => void>();
    const connectionReaders = new Set<() => void>();
    let closing = false;
    let disconnectStarted = false;
    let completion: Promise<void> | null = null;
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: unknown) => void) | undefined;
    const finishDisconnect = () => {
        if (!closing || disconnectStarted || (readers.size > 0 && params.accountLifetime?.isCurrent() !== false)) return;
        disconnectStarted = true;
        void socket.disconnect().then(resolveCompletion, rejectCompletion);
    };
    return {
        scopeUserId: socket.scopeUserId,
        machineId: socket.machineId,
        viewerId: socket.scopeUserId,
        get socketId() { return socket.socketId ?? ''; },
        onSocketIdChange: listener => {
            if (closing) return () => {};
            const unsubscribe = socket.onSocketIdChange(listener);
            const release = () => {
                if (!connectionReaders.delete(release)) return;
                unsubscribe();
            };
            connectionReaders.add(release);
            return release;
        },
        sendEnvelope: envelope => {
            if (!disconnectStarted && (!closing || (envelope.message.kind === 'control' && envelope.message.control.kind === 'stop'))) {
                socket.sendEnvelope(envelope);
            }
        },
        onEnvelope: listener => {
            if (closing) return () => {};
            const unsubscribe = socket.onEnvelope(envelope => { if (!closing) listener(envelope); });
            const release = () => {
                if (!readers.delete(release)) return;
                unsubscribe();
                finishDisconnect();
            };
            readers.add(release);
            return release;
        },
        disconnect: () => {
            if (!completion) {
                closing = true;
                for (const release of connectionReaders) release();
                completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
                finishDisconnect();
            }
            return completion;
        },
    };
}
