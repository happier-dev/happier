import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketPairMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('@/persistence', () => ({
    readLastChangesCursor: vi.fn(async () => 0),
    writeLastChangesCursor: vi.fn(async () => {}),
}));

vi.mock('axios');

describe('ApiSessionClient long-offline reconnect fallback', () => {
    it('falls back to snapshot sync when /v2/changes hits the page cap (>=200) and still catches up messages on reconnect', async () => {
        const { ApiSessionClient } = await import('./session/sessionClient');
        const { writeLastChangesCursor } = await import('@/persistence');
        (writeLastChangesCursor as any).mockClear?.();

        const mockSocket = createApiSessionSocketStub();
        const mockUserSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket: mockSocket, userSocket: mockUserSocket });

        const encryptionKey = new Uint8Array(32).fill(7);
        const encryptionVariant = 'legacy' as const;
        const sessionId = 'test-session-id';

        const CHANGES_PAGE_LIMIT = 200;
        const changes = Array.from({ length: CHANGES_PAGE_LIMIT }, (_v, i) => ({
            cursor: i + 1,
            kind: 'session',
            entityId: `s-${i}`,
            changedAt: Date.now(),
            hint: null,
        }));

        const lastObservedMessageSeq = 10;

        (axios.get as any).mockImplementation(async (url: string, config?: any) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }

            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: { changes, nextCursor: CHANGES_PAGE_LIMIT },
                };
            }

            if (url.includes(`/v1/sessions/${sessionId}/messages`)) {
                expect(config?.params?.afterSeq).toBe(lastObservedMessageSeq);
                return {
                    status: 200,
                    data: { messages: [], nextAfterSeq: null },
                };
            }

            throw new Error(`Unexpected axios.get: ${url}`);
        });

        const client = new ApiSessionClient(
            'fake-token',
            createMockSession({
                id: sessionId,
                encryptionKey,
                encryptionVariant,
            }),
        );

        const snapshotSpy = vi.fn(async () => {});
        (client as any).syncSessionSnapshotFromServer = snapshotSpy;

        (client as any).hasConnectedOnce = true;
        (client as any).lastObservedMessageSeq = lastObservedMessageSeq;

        mockSocket.trigger('connect');
        await (client as any).changesSyncInFlight;

        expect(snapshotSpy).toHaveBeenCalledWith({ reason: 'connect' });
        expect(writeLastChangesCursor).toHaveBeenCalledWith('account-1', CHANGES_PAGE_LIMIT);

        await client.close();
    });

    it('falls back to snapshot sync when /v2/changes is missing (e.g. old server 404) and still catches up messages on reconnect', async () => {
        const { ApiSessionClient } = await import('./session/sessionClient');
        const { writeLastChangesCursor } = await import('@/persistence');
        (writeLastChangesCursor as any).mockClear?.();

        const mockSocket = createApiSessionSocketStub();
        const mockUserSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket: mockSocket, userSocket: mockUserSocket });

        const encryptionKey = new Uint8Array(32).fill(7);
        const encryptionVariant = 'legacy' as const;
        const sessionId = 'test-session-id';

        const lastObservedMessageSeq = 10;

        (axios.get as any).mockImplementation(async (url: string, config?: any) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }

            if (url.includes('/v2/changes')) {
                return {
                    status: 404,
                    data: { error: 'not-found' },
                };
            }

            if (url.includes(`/v1/sessions/${sessionId}/messages`)) {
                expect(config?.params?.afterSeq).toBe(lastObservedMessageSeq);
                return {
                    status: 200,
                    data: { messages: [], nextAfterSeq: null },
                };
            }

            throw new Error(`Unexpected axios.get: ${url}`);
        });

        const client = new ApiSessionClient(
            'fake-token',
            createMockSession({
                id: sessionId,
                encryptionKey,
                encryptionVariant,
            }),
        );

        const snapshotSpy = vi.fn(async () => {});
        (client as any).syncSessionSnapshotFromServer = snapshotSpy;

        (client as any).hasConnectedOnce = true;
        (client as any).lastObservedMessageSeq = lastObservedMessageSeq;

        mockSocket.trigger('connect');
        await (client as any).changesSyncInFlight;

        expect(snapshotSpy).toHaveBeenCalledWith({ reason: 'connect' });
        expect(writeLastChangesCursor).not.toHaveBeenCalled();

        await client.close();
    });
});
