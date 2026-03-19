import { afterEach, describe, expect, it, vi } from 'vitest';

const emitWithAckSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdSpy = vi.hoisted(() => vi.fn());
const resolveContextSpy = vi.hoisted(() => vi.fn());
const createSocketSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        emitWithAck: (...args: unknown[]) => emitWithAckSpy(...args),
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

vi.mock('./resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdSpy(sessionId),
}));

vi.mock('./resolveServerScopedSessionContext', () => ({
    resolveServerScopedSessionContext: (params: unknown) => resolveContextSpy(params),
}));

vi.mock('./createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (params: unknown) => createSocketSpy(params),
}));

describe('emitSessionMetadataUpdateWithServerScope', () => {
    afterEach(() => {
        emitWithAckSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        resolvePreferredServerIdForSessionIdSpy.mockReset();
        resolveContextSpy.mockReset();
        createSocketSpy.mockReset();
    });

    it('uses the active socket when the preferred owner server is active', async () => {
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-a');
        getActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a' });
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 4000 });
        emitWithAckSpy.mockResolvedValue({ result: 'success' });

        const { emitSessionMetadataUpdateWithServerScope } = await import('./emitSessionMetadataUpdateWithServerScope');

        const result = await emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
            timeoutMs: 4000,
        });

        expect(result).toEqual({ result: 'success' });
        expect(resolveContextSpy).toHaveBeenCalledWith({ serverId: 'server-a', timeoutMs: 4000 });
        expect(emitWithAckSpy).toHaveBeenCalledWith('update-metadata', {
            sid: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
        });
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it('uses an ephemeral scoped socket when the preferred owner server differs from active', async () => {
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-b');
        getActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a' });
        resolveContextSpy.mockResolvedValue({
            scope: 'scoped',
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 5000,
            encryption: null,
        });
        const emitWithAck = vi.fn(async () => ({ result: 'success', version: 4 }));
        const disconnect = vi.fn();
        createSocketSpy.mockResolvedValue({
            timeout: vi.fn(() => ({ emitWithAck })),
            disconnect,
        });

        const { emitSessionMetadataUpdateWithServerScope } = await import('./emitSessionMetadataUpdateWithServerScope');

        const result = await emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
            timeoutMs: 5000,
        });

        expect(result).toEqual({ result: 'success', version: 4 });
        expect(resolveContextSpy).toHaveBeenCalledWith({ serverId: 'server-b', timeoutMs: 5000 });
        expect(createSocketSpy).toHaveBeenCalledWith({
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 5000,
        });
        expect(emitWithAck).toHaveBeenCalledWith('update-metadata', {
            sid: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
        });
        expect(disconnect).toHaveBeenCalledTimes(1);
    });
});
