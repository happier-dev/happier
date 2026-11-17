import { vi } from 'vitest';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { SOCKET_RPC_EVENTS, SocketRpcCancellationPayloadSchema, SocketRpcRequestIdSchema, parseSocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { ScmWorkEvidenceAuthorizationSelectorSchema } from '@happier-dev/protocol/scm';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { storage as sessionStorage } from '@/sync/domains/state/storage';
import type { HomeGovernanceHarness } from './homeGovernanceHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '../fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';

/** Real Session Action clients behind the Socket.IO serialization/response boundary. */
export function installSessionActionRpcBoundary(respond: (
    request: SocketRpcRequestPayload,
    context: Readonly<{ signal: AbortSignal; serverUrl?: string }>,
) => unknown, options?: Readonly<{
    /** Replace only the daemon/relay's external acknowledgement, after real request serialization. */
    transformAcknowledgement?: (acknowledgement: Readonly<{ ok: true; result: unknown }>, request: SocketRpcRequestPayload) => unknown;
}>): SocketRpcRequestPayload[] {
    const requests: SocketRpcRequestPayload[] = [];
    installDisconnectedServerSocketBoundary((socket, serverUrl) => {
        const pending = new Map<string, AbortController>();
        const emit = socket.emit;
        socket.emit = vi.fn<typeof socket.emit>((event, ...args) => {
            if (event === SOCKET_RPC_EVENTS.CANCEL) {
                const cancellation = SocketRpcCancellationPayloadSchema.parse(args[0]);
                pending.get(cancellation.requestId)?.abort();
                return socket;
            }
            return emit.call(socket, event, ...args);
        });
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        // Scoped sockets can outlive one test's spies. Keep this cold external
        // transport installed for the socket lifetime, like connect/emit/disconnect.
        socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            const wire: unknown = JSON.parse(JSON.stringify(payload));
            if (!wire || typeof wire !== 'object' || !('method' in wire) || typeof wire.method !== 'string') {
                throw new Error('Malformed socket RPC request');
            }
            // This leaf receives client-to-relay selectors as well as Session authorization.
            // The generic Session parser intentionally refuses SCM's separate closed wire shape.
            const scmAuthorization = 'authorization' in wire
                ? ScmWorkEvidenceAuthorizationSelectorSchema.safeParse(wire.authorization) : null;
            const authorization = 'authorization' in wire ? parseSocketRpcAuthorizationContext(wire.authorization)
                ?? (scmAuthorization?.success ? scmAuthorization.data : null) : null;
            if ('authorization' in wire && !authorization) throw new Error('Malformed socket RPC authorization');
            // Plain zero-argument calls lose an undefined params key on the wire;
            // the real relay and daemon decode that absence as undefined.
            const request: SocketRpcRequestPayload = { method: wire.method, params: Reflect.get(wire, 'params'),
                ...(authorization ? { authorization } : {}) };
            requests.push(request);
            const requestId = 'requestId' in wire ? SocketRpcRequestIdSchema.parse(wire.requestId) : null;
            const controller = new AbortController();
            if (requestId) pending.set(requestId, controller);
            try {
                const acknowledgement = { ok: true as const, result: await respond(request, { signal: controller.signal, serverUrl }) };
                return options?.transformAcknowledgement ? options.transformAcknowledgement(acknowledgement, request) : acknowledgement;
            } finally {
                if (requestId) pending.delete(requestId);
            }
        });
    });
    return requests;
}

/** Hydrates the same plain Account Session from local state and its genuine HTTP projection. */
export function installSessionActionFixture(params: Readonly<{
    homes: HomeGovernanceHarness;
    storage: typeof sessionStorage;
    serverId: string;
    session: Partial<Session> & Pick<Session, 'id'>;
}>): Session {
    const { homes, storage, serverId } = params;
    const session = createSessionFixture({ serverId, active: true,
        metadata: { path: '/repo', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine_1',
            flavor: 'codex', codexBackendMode: 'appServer', codexSessionId: 'thread_1' },
        ...params.session });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session },
        sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId,
            [serverId]: { ...storage.getState().sessionListRowsByServerId[serverId], [session.id]: session } } });
    // An encrypted Session has no plaintext Home projection to serve; only its local hydrated state is seeded.
    if (session.encryptionMode !== 'plain') return session;
    const wire = createPlainSessionByIdResponseFixture(session).session;
    homes.answer(serverId, `/v2/sessions/${session.id}`, { body: { session: wire } });
    homes.answer(serverId, `/v2/sessions/${session.id}?accessProjectionVersion=1`, { body: { session: wire } });
    // The Home answers the turn projection of every Session it serves; this fixture declares none.
    homes.answer(serverId, `/v1/sessions/${session.id}/turns`, { body: session.sessionTurns
        ?? { v: 1, sessionId: session.id, updatedAt: session.updatedAt, turns: [] } });
    return session;
}
