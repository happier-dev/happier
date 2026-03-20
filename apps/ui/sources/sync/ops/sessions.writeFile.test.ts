import { describe, expect, it, vi } from 'vitest';
import { createRpcCallError } from '../runtime/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

type SessionWriteFileRpcResponse = Readonly<{ success: boolean; hash: string }> | null;
const sessionRPCSpy = vi.fn(
    async (_sessionId: string, _method: string, _payload: unknown): Promise<SessionWriteFileRpcResponse> => ({
        success: true,
        hash: 'h1',
    }),
);
const machineRPCSpy = vi.fn(
    async (_machineId: string, _method: string, _payload: unknown): Promise<SessionWriteFileRpcResponse> => ({
        success: true,
        hash: 'h1',
    }),
);
const getStateSpy = vi.fn();

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
        machineRPC: (machineId: string, method: string, payload: any) => machineRPCSpy(machineId, method, payload),
    },
}));

vi.mock('../domains/state/storage', () => ({
    storage: {
        getState: () => getStateSpy(),
    },
}));

describe('sessionWriteFile', () => {
    it('base64-encodes UTF-8 content before calling the writeFile RPC', async () => {
        const { sessionWriteFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });

        sessionRPCSpy.mockClear();
        machineRPCSpy.mockClear();

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');

        expect(res.success).toBe(true);
        expect(machineRPCSpy).toHaveBeenCalledTimes(1);
        const payload = machineRPCSpy.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
        expect(payload).toBeDefined();
        if (!payload) {
            throw new Error('Expected machineRPC to be called with a payload');
        }
        expect(payload).toMatchObject({
            path: '~/repo/src/a.ts',
            content: 'aGVsbG8=',
        });
        expect(Object.prototype.hasOwnProperty.call(payload, 'expectedHash')).toBe(false);
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });

    it('returns a stable errorCode when the RPC method is unavailable', async () => {
        const { sessionWriteFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });

        machineRPCSpy.mockRejectedValueOnce(
            createRpcCallError({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        sessionRPCSpy.mockRejectedValueOnce(
            createRpcCallError({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionWriteFile to fail');
        }
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    });

    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionWriteFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });

        machineRPCSpy.mockResolvedValueOnce(null);
        sessionRPCSpy.mockResolvedValueOnce(null);

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionWriteFile to fail');
        }
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(typeof res.error).toBe('string');
    });

    it('fails closed when inactive session has no machine target', async () => {
        const { sessionWriteFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        path: '',
                        machineId: '',
                    },
                },
            },
            getProjectForSession: () => null,
        });

        sessionRPCSpy.mockClear();
        sessionRPCSpy.mockResolvedValueOnce({
            success: true,
            hash: 'h1',
        });
        machineRPCSpy.mockClear();

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionWriteFile to fail');
        }
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(machineRPCSpy).not.toHaveBeenCalled();
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });
});
