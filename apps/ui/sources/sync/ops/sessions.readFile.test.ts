import { describe, expect, it, vi } from 'vitest';
import { createRpcCallError } from '../runtime/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

type SessionReadFileRpcResponse = Readonly<{ success: boolean; content: string }> | null;
const sessionRPCSpy = vi.fn(
    async (_sessionId: string, _method: string, _payload: unknown): Promise<SessionReadFileRpcResponse> => ({
        success: true,
        content: 'aGVsbG8=',
    }),
);
const machineRPCSpy = vi.fn(
    async (_machineId: string, _method: string, _payload: unknown): Promise<SessionReadFileRpcResponse> => ({
        success: true,
        content: 'aGVsbG8=',
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

describe('sessionReadFile', () => {
    it('prefers machine RPC and resolves relative paths against the session cwd', async () => {
        const { sessionReadFile } = await import('./sessions');

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

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(true);
        expect(machineRPCSpy).toHaveBeenCalledWith('m1', 'readFile', { path: '~/repo/src/a.ts' });
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });

    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionReadFile } = await import('./sessions');

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

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res).toMatchObject({ success: false });
        expect(typeof res.error).toBe('string');
    });

    it('does not fall back to session RPC for inactive sessions', async () => {
        const { sessionReadFile } = await import('./sessions');

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
        sessionRPCSpy.mockResolvedValueOnce({
            success: true,
            content: 'aGVsbG8=',
        });

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });

    it('fails closed when inactive session has no machine target', async () => {
        const { sessionReadFile } = await import('./sessions');

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
            content: 'aGVsbG8=',
        });
        machineRPCSpy.mockClear();

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        expect(machineRPCSpy).not.toHaveBeenCalled();
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });
});
