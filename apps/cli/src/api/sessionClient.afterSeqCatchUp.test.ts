import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { encodeBase64, encrypt } from './encryption';
import { ApiSessionClient } from './session/sessionClient';
import { writeLastChangesCursor } from '@/persistence';
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

describe('ApiSessionClient reconnect transcript catch-up (afterSeq)', () => {
    it('fetches /v1/sessions/:id/messages?afterSeq=... on reconnect when /v2/changes indicates a session change', async () => {
        const mockSocket = createApiSessionSocketStub();
        const mockUserSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket: mockSocket, userSocket: mockUserSocket });

        const encryptionKey = new Uint8Array(32).fill(7);
        const encryptionVariant = 'legacy' as const;
        const sessionId = 'test-session-id';

        const lastObservedMessageSeq = 10;
        const nextMessageSeq = lastObservedMessageSeq + 1;
        const userMessage = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'hello from catch-up' },
            localId: 'local-1',
        };
        const encrypted = encodeBase64(encrypt(encryptionKey, encryptionVariant, userMessage));

        (axios.get as any).mockImplementation(async (url: string, config?: any) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }

            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            {
                                cursor: 1,
                                kind: 'session',
                                entityId: sessionId,
                                changedAt: Date.now(),
                                hint: null,
                            },
                        ],
                        nextCursor: 1,
                    },
                };
            }

            if (url.includes(`/v1/sessions/${sessionId}/messages`)) {
                expect(config?.params?.afterSeq).toBe(lastObservedMessageSeq);
                return {
                    status: 200,
                    data: {
                        messages: [
                            {
                                id: 'm-11',
                                seq: nextMessageSeq,
                                localId: userMessage.localId,
                                createdAt: Date.now(),
                                content: { t: 'encrypted', c: encrypted },
                            },
                        ],
                        nextAfterSeq: null,
                    },
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

        // Avoid snapshot side effects in this unit test.
        (client as any).syncSessionSnapshotFromServer = vi.fn(async () => {});

        // Simulate a reconnect (the constructor wires the handler; we can bypass the first connect).
        (client as any).hasConnectedOnce = true;
        (client as any).lastObservedMessageSeq = lastObservedMessageSeq;

        const onUserMessage = vi.fn();
        client.on('user-message', onUserMessage);

        mockSocket.trigger('connect');
        await (client as any).changesSyncInFlight;

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(expect.objectContaining({ localId: 'local-1' }));
        expect(writeLastChangesCursor).toHaveBeenCalledWith('account-1', 1);

        await client.close();
    });
});
