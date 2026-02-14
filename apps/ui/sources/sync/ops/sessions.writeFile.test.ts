import { describe, expect, it, vi } from 'vitest';
import { createRpcCallError } from '../runtime/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const sessionRPCSpy = vi.fn(async () => ({ success: true, hash: 'h1' }));

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
    },
}));

describe('sessionWriteFile', () => {
    it('base64-encodes UTF-8 content before calling the writeFile RPC', async () => {
        const { sessionWriteFile } = await import('./sessions');

        sessionRPCSpy.mockClear();

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');

        expect(res.success).toBe(true);
        expect(sessionRPCSpy).toHaveBeenCalledTimes(1);
        expect(sessionRPCSpy).toHaveBeenCalledWith('s1', 'writeFile', {
            path: 'src/a.ts',
            content: 'aGVsbG8=',
            expectedHash: undefined,
        });
    });

    it('returns a stable errorCode when the RPC method is unavailable', async () => {
        const { sessionWriteFile } = await import('./sessions');

        sessionRPCSpy.mockRejectedValueOnce(
            createRpcCallError({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');
        expect(res.success).toBe(false);
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    });
});
