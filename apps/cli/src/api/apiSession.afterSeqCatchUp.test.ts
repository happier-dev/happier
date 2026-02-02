import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { encodeBase64, encrypt } from './encryption';
import { ApiSessionClient } from './apiSession';
import { writeLastChangesCursor } from '@/persistence';

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

function createMockSocket() {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    return {
        connected: false,
        connect: vi.fn(),
        on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
        }),
        off: vi.fn(),
        disconnect: vi.fn(),
        close: vi.fn(),
        emit: vi.fn(),
        __trigger: (event: string, ...args: any[]) => {
            for (const cb of handlers.get(event) ?? []) {
                cb(...args);
            }
        },
    };
}

describe('ApiSessionClient reconnect transcript catch-up (afterSeq)', () => {
    it('fetches /v1/sessions/:id/messages?afterSeq=... on reconnect when /v2/changes indicates a session change', async () => {
        const mockSocket = createMockSocket();
        const mockUserSocket = createMockSocket();
        mockIo.mockReset();
        mockIo
            .mockImplementationOnce(() => mockSocket as any)
            .mockImplementationOnce(() => mockUserSocket as any);

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

        const client = new ApiSessionClient('fake-token', {
            id: sessionId,
            seq: 0,
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools',
            },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            encryptionKey,
            encryptionVariant,
        } as any);

        // Avoid snapshot side effects in this unit test.
        (client as any).syncSessionSnapshotFromServer = vi.fn(async () => {});

        // Simulate a reconnect (the constructor wires the handler; we can bypass the first connect).
        (client as any).hasConnectedOnce = true;
        (client as any).lastObservedMessageSeq = lastObservedMessageSeq;

        const onUserMessage = vi.fn();
        client.on('user-message', onUserMessage);

        mockSocket.__trigger('connect');
        await (client as any).changesSyncInFlight;

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(expect.objectContaining({ localId: 'local-1' }));
        expect(writeLastChangesCursor).toHaveBeenCalledWith('account-1', 1);

        await client.close();
    });
});
