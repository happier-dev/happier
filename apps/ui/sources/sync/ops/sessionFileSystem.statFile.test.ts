import { describe, expect, it, vi } from 'vitest';
import { createRpcCallError } from '../runtime/rpcErrors';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

type StatFileRpcResponse =
    | Readonly<{ success: true; exists: boolean; kind?: string; sizeBytes?: number; modifiedMs?: number }>
    | Readonly<{ success: false; error: string }>
    | null;

const sessionRPCSpy = vi.fn(
    async (_sessionId: string, _method: string, _payload: unknown): Promise<StatFileRpcResponse> => ({
        success: true,
        exists: false,
    }),
);

const machineRPCSpy = vi.fn(
    async (_machineId: string, _method: string, _payload: unknown): Promise<StatFileRpcResponse> => ({
        success: true,
        exists: false,
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

describe('sessionStatFile', () => {
    it('prefers machine RPC and resolves relative paths against the session cwd', async () => {
        const { sessionStatFile } = await import('./sessionFileSystem');

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

        const res = await sessionStatFile('s1', 'src/a.ts');
        expect(res).toMatchObject({ success: true, exists: false });
        expect(machineRPCSpy).toHaveBeenCalledWith('m1', RPC_METHODS.STAT_FILE, { path: '~/repo/src/a.ts' });
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });

    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionStatFile } = await import('./sessionFileSystem');

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

        const res = await sessionStatFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionStatFile to fail');
        }
        expect(typeof res.error).toBe('string');
    });

    it('does not fall back to session RPC for inactive sessions', async () => {
        const { sessionStatFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
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
        sessionRPCSpy.mockClear();
        sessionRPCSpy.mockResolvedValueOnce({ success: true, exists: true, kind: 'file', sizeBytes: 1, modifiedMs: 0 });

        const res = await sessionStatFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });
});
