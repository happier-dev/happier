import { describe, expect, it, vi } from 'vitest';
import { createRpcCallError } from '../runtime/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

type SessionListDirectoryRpcResponse =
    | Readonly<{ success: boolean; entries: ReadonlyArray<{ name: string; type: 'file' | 'directory' | 'other' }> }>
    | null;

const sessionRPCSpy = vi.fn(
    async (_sessionId: string, _method: string, _payload: unknown): Promise<SessionListDirectoryRpcResponse> => ({
        success: true,
        entries: [{ name: 'a.ts', type: 'file' }],
    }),
);
const machineRPCSpy = vi.fn(
    async (_machineId: string, _method: string, _payload: unknown): Promise<SessionListDirectoryRpcResponse> => ({
        success: true,
        entries: [{ name: 'a.ts', type: 'file' }],
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

describe('sessionListDirectory', () => {
    it('prefers machine RPC and resolves relative paths against session cwd', async () => {
        const { sessionListDirectory } = await import('./sessions');

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

        const res = await sessionListDirectory('s1', 'src');
        expect(res.success).toBe(true);
        expect(machineRPCSpy).toHaveBeenCalledWith('m1', 'listDirectory', { path: '~/repo/src' });
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });

    it('does not fall back to session RPC for inactive sessions', async () => {
        const { sessionListDirectory } = await import('./sessions');

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
        sessionRPCSpy.mockResolvedValueOnce({
            success: true,
            entries: [{ name: 'a.ts', type: 'file' }],
        });

        const res = await sessionListDirectory('s1', 'src');
        expect(res.success).toBe(false);
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });

    it('resolves machine target from project fallback for inactive sessions', async () => {
        const { sessionListDirectory } = await import('./sessions');

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
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm1',
                            path: '~/repo',
                        },
                    }
                    : null,
        });

        sessionRPCSpy.mockClear();
        machineRPCSpy.mockClear();

        const res = await sessionListDirectory('s1', 'src');
        expect(res.success).toBe(true);
        expect(machineRPCSpy).toHaveBeenCalledWith('m1', 'listDirectory', { path: '~/repo/src' });
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });

    it('fails closed for inactive sessions when no machine target is available', async () => {
        const { sessionListDirectory } = await import('./sessions');

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

        sessionRPCSpy.mockResolvedValueOnce({
            success: true,
            entries: [{ name: 'a.ts', type: 'file' }],
        });
        machineRPCSpy.mockClear();

        const res = await sessionListDirectory('s1', 'src');
        expect(res.success).toBe(false);
        expect(machineRPCSpy).not.toHaveBeenCalled();
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });
});
