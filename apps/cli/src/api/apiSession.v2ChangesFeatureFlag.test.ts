import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionClient } from './apiSession';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo, fetchChanges } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    fetchChanges: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('./changes', () => ({
    fetchChanges,
}));

describe('ApiSessionClient /v2/changes feature flag', () => {
    beforeEach(() => {
        fetchChanges.mockReset();
        mockIo.mockReset();
        delete process.env.HAPPY_ENABLE_V2_CHANGES;
    });

    it('skips /v2/changes sync when HAPPY_ENABLE_V2_CHANGES is false', async () => {
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';

        const sessionSocket: any = {
            connected: true,
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
        };

        const userSocket: any = {
            connected: true,
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
        };

        mockIo
            .mockImplementationOnce(() => sessionSocket)
            .mockImplementationOnce(() => userSocket);

        const client = new ApiSessionClient('fake-token', {
            id: 'test-session-id',
            seq: 0,
            metadata: { path: '/tmp' },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const,
        } as any);

        const connectHandler = (sessionSocket.on.mock.calls.find((call: any[]) => call[0] === 'connect') ?? [])[1];
        expect(typeof connectHandler).toBe('function');
        connectHandler();

        await new Promise((r) => setTimeout(r, 0));

        expect(fetchChanges).not.toHaveBeenCalled();

        await client.close();
    });
});
