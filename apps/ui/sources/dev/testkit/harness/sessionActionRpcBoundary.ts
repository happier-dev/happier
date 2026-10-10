import { vi } from 'vitest';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { storage } from '@/sync/domains/state/storage';
import type { HomeGovernanceHarness } from './homeGovernanceHarness';
import { createSessionFixture } from '../fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';

/** Real Session Action clients behind the Socket.IO serialization/response boundary. */
export function installSessionActionRpcBoundary(respond: (request: SocketRpcRequestPayload) => unknown) {
    const requests: SocketRpcRequestPayload[] = [];
    installDisconnectedServerSocketBoundary(socket => {
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            const wire: unknown = JSON.parse(JSON.stringify(payload));
            if (!wire || typeof wire !== 'object' || !('method' in wire) || typeof wire.method !== 'string' || !('params' in wire)) {
                throw new Error('Malformed socket RPC request');
            }
            const request: SocketRpcRequestPayload = { method: wire.method, params: wire.params };
            requests.push(request);
            return { ok: true, result: await respond(request) };
        });
    });
    return requests;
}

/** Hydrates the same plain Account Session from local state and its genuine HTTP projection. */
export function installSessionActionFixture(params: Readonly<{
    homes: HomeGovernanceHarness;
    storage: typeof storage;
    serverId: string;
    session: Partial<Session> & Pick<Session, 'id'>;
}>) {
    const { homes, storage, serverId } = params;
    const session = createSessionFixture({ serverId, active: true,
        metadata: { path: '/repo', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine_1',
            flavor: 'codex', codexBackendMode: 'appServer', codexSessionId: 'thread_1' },
        ...params.session });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session },
        sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId,
            [serverId]: { ...storage.getState().sessionListRowsByServerId[serverId], [session.id]: session } } });
    const wire = SessionCurrentProjectionRecordV1Schema.parse({ ...session,
        metadata: JSON.stringify(session.metadata), metadataLayoutVersion: 0,
        effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
        responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
        agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0 });
    homes.answer(serverId, `/v2/sessions/${session.id}`, { body: { session: wire } });
    homes.answer(serverId, `/v2/sessions/${session.id}?accessProjectionVersion=1`, { body: { session: wire } });
    return session;
}
