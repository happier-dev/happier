import { describe, expect, it, vi, beforeEach } from 'vitest';

// Hoisted mocks so factories can reference stable fns.
const { mockIo, mockLoggerDebug } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockLoggerDebug: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: mockLoggerDebug,
    },
}));

describe('ApiSessionClient (Codex MCP) diagnostics', () => {
    beforeEach(() => {
        mockIo.mockReset();
        mockLoggerDebug.mockReset();

        const mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
        };
        const mockUserSocket = { ...mockSocket };
        mockIo
            .mockImplementationOnce(() => mockSocket)
            .mockImplementationOnce(() => mockUserSocket)
            .mockImplementation(() => mockSocket);
    });

    it('logs when a tool-call-result arrives without a prior tool-call mapping', async () => {
        vi.resetModules();
        const { ApiSessionClient } = await import('./apiSession');

        const client = new ApiSessionClient('fake-token', {
            id: 'test-session-id',
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
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const,
        } as any);

        client.sendCodexMessage({
            type: 'tool-call-result',
            callId: 'call-missing',
            output: { stdout: 'x' },
            id: 'msg-1',
        });

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            expect.stringContaining('tool-call-result without prior tool-call'),
            expect.objectContaining({ callId: 'call-missing' }),
        );
    });
});

