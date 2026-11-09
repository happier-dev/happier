import { afterEach, describe, expect, it, vi } from 'vitest';

import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol/transfers/relay/v2/socketEvents';
import type { Encryption } from '@/sync/encryption/encryption';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';

function createSocketStub() {
    const boundary = createSocketIoBoundaryStub();
    return { ...boundary, emitEvent: boundary.trigger };
}

afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('apiSocket transfer relay listeners', () => {
    it('fans out relay-v2 envelopes to multiple listeners on the active socket', async () => {
        const socketStub = createSocketStub();

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    listener({
                        phase: 'online',
                        reason: 'initial_connect',
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: Date.now(),
                        lastDisconnectedAt: null,
                        lastErrorMessage: null,
                    });
                    return () => {};
                },
                startServerReachabilitySupervisor: vi.fn(async () => {}),
            };
        });

        vi.doMock('socket.io-client', () => ({ io: () => socketStub.socket }));

        const { apiSocket } = await import('./apiSocket');
        apiSocket.initialize(
            { endpoint: 'https://api.example.test', token: 'token-a' },
            { getSessionEncryption: () => null, getMachineEncryption: () => null } as unknown as Encryption,
        );

        const firstListener = vi.fn();
        const secondListener = vi.fn();
        apiSocket.onTransferRelayV2Envelope(firstListener);
        apiSocket.onTransferRelayV2Envelope(secondListener);

        await vi.waitFor(() => {
            expect(socketStub.socket.onAny).toHaveBeenCalled();
        });

        const payload = {
            scopeUserId: 'user-1',
            sender: {
                kind: 'machine',
                machineId: 'machine-1',
            },
            recipient: {
                kind: 'user',
            },
            envelope: {
                transferId: 'transfer-1',
                kind: 'abort',
                reason: 'disabled',
            },
        } as const;

        socketStub.emitEvent(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);

        expect(firstListener).toHaveBeenCalledWith(payload, { serverId: null });
        expect(secondListener).toHaveBeenCalledWith(payload, { serverId: null });
    });
});
