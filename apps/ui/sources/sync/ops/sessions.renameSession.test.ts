import { beforeEach, describe, expect, it, vi } from 'vitest';

// Typed generics for vi.fn differ across Vitest versions; keep this untyped here.
const patchSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock('../sync', () => ({
    sync: {
        patchSessionMetadataWithRetry: patchSessionMetadataWithRetryMock,
    },
}));

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: vi.fn(),
        sessionRPC: vi.fn(),
        emitWithAck: vi.fn(),
        request: vi.fn(),
    },
}));

const sessionsModulePromise = import('./sessions');

describe('sessionRename', () => {
    beforeEach(() => {
        patchSessionMetadataWithRetryMock.mockReset();
    });

    it('updates metadata summary via sync.patchSessionMetadataWithRetry', async () => {
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        const { sessionRename } = await sessionsModulePromise;

        const result = await sessionRename('sess-1', 'New title');

        expect(result).toEqual({ success: true });
        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);

        const [sessionId, updater] = patchSessionMetadataWithRetryMock.mock.calls[0] as [
            string,
            (metadata: Record<string, unknown>) => Record<string, unknown>,
        ];
        expect(sessionId).toBe('sess-1');

        const updated = updater({ existing: 'keep' });
        expect(updated).toEqual(expect.objectContaining({
            existing: 'keep',
            summary: {
                text: 'New title',
                updatedAt: expect.any(Number),
            },
        }));
    });

    it('passes serverId override through to patchSessionMetadataWithRetry', async () => {
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        const { sessionRename } = await sessionsModulePromise;

        const result = await sessionRename('sess-1', 'New title', { serverId: 'server-b' });

        expect(result).toEqual({ success: true });
        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledWith('sess-1', expect.any(Function), { serverId: 'server-b' });
    });

    it('returns an error message when patching fails', async () => {
        patchSessionMetadataWithRetryMock.mockRejectedValueOnce(new Error('boom'));
        const { sessionRename } = await sessionsModulePromise;

        const result = await sessionRename('sess-1', 'New title');

        expect(result).toEqual({ success: false, message: 'boom' });
    });
});
