import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { ApiSessionClient } from './sessionClient';
import { logger } from '@/ui/logger';
import { DeferredApiSessionClient, type DeferredApiSessionTarget } from '@/agent/runtime/startup/DeferredApiSessionClient';

let sessionSocket: ApiSessionSocketStub;
let userSocket: ApiSessionSocketStub;

// The socket transport is the system boundary; the connection supervisor,
// transcript writers, outbox, and turn lifecycle remain real.
vi.mock('./sockets', () => ({ createUserScopedSocket: () => userSocket }));
vi.mock('./connection/createSessionSocketTransport', () => ({
    createSessionSocketTransport: () => ({
        socket: sessionSocket,
        transport: {
            connect: async () => {},
            disconnect: async () => {},
            destroy: async () => {},
            isConnected: () => sessionSocket.connected,
            onConnected: () => () => {},
            onDisconnected: () => () => {},
            onError: () => () => {},
        },
    }),
}));

describe('ApiSessionClient turn silence observation', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('does not count transcript replay, consumed echoes, or synthetic output as provider events', async () => {
        vi.stubEnv('HAPPIER_TURN_STALL_WARN_MS', '900000');
        sessionSocket = createApiSessionSocketStub({ connected: true });
        userSocket = createApiSessionSocketStub({ connected: true });
        // File logging is an OS boundary. Inspect notices without changing
        // their production observer or the lifecycle under test.
        const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const notices = () => info.mock.calls.filter(([message]) => message === 'turn stall noticed');
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const client = new ApiSessionClient('token', createPlainSessionFixture({ id: 'silence-observation' }));
        try {
            await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
            vi.advanceTimersByTime(600000);
            client.recordClaudeJsonlMessageConsumed({
                type: 'user', uuid: 'old-echo', message: { content: 'historical prompt' },
            });
            await client.sendClaudeSessionMessageCommitted({
                type: 'assistant', uuid: 'old-assistant', message: { content: 'historical answer' },
            }, {
                createdAt: 1,
                provenance: { kind: 'non_dependent', source: 'history' },
            });
            client.sendAgentMessage('claude', { type: 'message', message: 'host-generated explanation' });
            client.sendAgentMessageEphemeral('claude', { type: 'message', message: 'projected text' }, {
                localId: 'projected-text', createdAt: Date.now(),
            });
            vi.advanceTimersByTime(300000);
            expect(notices()).toHaveLength(1);
            expect(notices()[0]?.[1]).toMatchObject({ sessionId: client.sessionId, lastEventAgeMs: 900000 });

            client.recordClaudeJsonlMessageConsumed({
                type: 'user', uuid: 'another-old-echo', message: { content: 'historical prompt' },
            });
            vi.advanceTimersByTime(900000);
            expect(notices()).toHaveLength(1);

            client.sessionTurnLifecycle.observeProviderTurnEvent();
            vi.advanceTimersByTime(900000);
            expect(notices()).toHaveLength(2);
            await client.sessionTurnLifecycle.completeTurn();
        } finally {
            await client.sessionTurnLifecycle.endSession();
            await client.close();
        }
    });

    it('stops local observation when the client closes without settling the active turn', async () => {
        vi.stubEnv('HAPPIER_TURN_STALL_WARN_MS', '900000');
        sessionSocket = createApiSessionSocketStub({ connected: true });
        userSocket = createApiSessionSocketStub({ connected: true });
        const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const client = new ApiSessionClient('token', createPlainSessionFixture({ id: 'closed-observation' }));
        await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
        await client.close();
        expect(client.sessionTurnLifecycle.hasActiveTurn()).toBe(true);
        client.sessionTurnLifecycle.observeProviderTurnEvent();
        vi.advanceTimersByTime(900000);
        expect(info.mock.calls.filter(([message]) => message === 'turn stall noticed')).toEqual([]);
    });

    it('observes live ingress through the retained fast-start client after attachment', async () => {
        vi.stubEnv('HAPPIER_TURN_STALL_WARN_MS', '900000');
        sessionSocket = createApiSessionSocketStub({ connected: true });
        userSocket = createApiSessionSocketStub({ connected: true });
        const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const client = new ApiSessionClient('token', createPlainSessionFixture({ id: 'attached-observation' }));
        const deferred = new DeferredApiSessionClient({
            placeholderSessionId: 'startup', limits: { maxEntries: 10, maxBytes: 10000 },
        });
        // Match the existing runner attachment boundary; the client and its
        // lifecycle are real, including the durable mutation writer beneath it.
        await deferred.attach(client as unknown as DeferredApiSessionTarget);
        try {
            await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
            vi.advanceTimersByTime(600000);
            deferred.sessionTurnLifecycle?.observeProviderTurnEvent();
            vi.advanceTimersByTime(300000);
            expect(info.mock.calls.filter(([message]) => message === 'turn stall noticed')).toEqual([]);
            vi.advanceTimersByTime(600000);
            expect(info.mock.calls.filter(([message]) => message === 'turn stall noticed')).toHaveLength(1);
        } finally {
            await client.sessionTurnLifecycle.endSession();
            await client.close();
        }
    });
});
