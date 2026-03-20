import { describe, expect, it, vi } from 'vitest';
import { createRpcCallError } from '../runtime/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

type SessionCreateDirectoryRpcResponse = Readonly<{ success: boolean }> | null;
const sessionRPCSpy = vi.fn(
    async (_sessionId: string, _method: string, _payload: unknown): Promise<SessionCreateDirectoryRpcResponse> => ({
        success: true,
    }),
);

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
    },
}));

describe('sessionCreateDirectory', () => {
    it('calls the createDirectory RPC with the provided path', async () => {
        const { sessionCreateDirectory } = await import('./sessionFileSystem');
        sessionRPCSpy.mockClear();

        const res = await sessionCreateDirectory('s1', 'tmp/new-folder');
        expect(res.success).toBe(true);
        expect(sessionRPCSpy).toHaveBeenCalledWith('s1', 'createDirectory', { path: 'tmp/new-folder' });
    }, 60_000);

    it('returns a stable errorCode when the RPC method is not found', async () => {
        const { sessionCreateDirectory } = await import('./sessionFileSystem');
        sessionRPCSpy.mockRejectedValueOnce(
            createRpcCallError({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        const res = await sessionCreateDirectory('s1', 'tmp/new-folder');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionCreateDirectory to fail');
        }
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    });

    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionCreateDirectory } = await import('./sessionFileSystem');
        sessionRPCSpy.mockResolvedValueOnce(null);

        const res = await sessionCreateDirectory('s1', 'tmp/new-folder');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionCreateDirectory to fail');
        }
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(typeof res.error).toBe('string');
    });
});
