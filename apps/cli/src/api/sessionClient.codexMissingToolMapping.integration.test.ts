import { describe, expect, it, vi, beforeEach } from 'vitest';
import { bindApiSessionSocketPairMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createMockSession } from '@/testkit/backends/sessionFixtures';

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

        const sessionSocket = createApiSessionSocketStub();
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, {
            sessionSocket,
            userSocket,
            fallbackSocket: sessionSocket,
        });
    });

    it('logs when a tool-call-result arrives without a prior tool-call mapping', async () => {
        vi.resetModules();
        const { ApiSessionClient } = await import('./session/sessionClient');

        const client = new ApiSessionClient('fake-token', createMockSession({
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools',
            },
        }));
        try {
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
        } finally {
            await client.close();
        }
    });
});
