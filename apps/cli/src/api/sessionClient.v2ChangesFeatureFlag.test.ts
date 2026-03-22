import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionClient } from './session/sessionClient';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketPairMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

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
    const previousEnableV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;

    beforeEach(() => {
        fetchChanges.mockReset();
        mockIo.mockReset();
        delete process.env.HAPPY_ENABLE_V2_CHANGES;
    });

    afterEach(() => {
        if (previousEnableV2Changes === undefined) {
            delete process.env.HAPPY_ENABLE_V2_CHANGES;
        } else {
            process.env.HAPPY_ENABLE_V2_CHANGES = previousEnableV2Changes;
        }
    });

    it('skips /v2/changes sync when HAPPY_ENABLE_V2_CHANGES is false', async () => {
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';

        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub({ connected: true });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', createMockSession({ metadata: { path: '/tmp' } as any }));

        const connectHandler = sessionSocket.getHandler('connect');
        expect(typeof connectHandler).toBe('function');
        connectHandler?.();

        await new Promise((r) => setTimeout(r, 0));

        expect(fetchChanges).not.toHaveBeenCalled();

        await client.close();
    });
});
