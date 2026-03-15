import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const getStateSpy = vi.fn();

vi.mock('../domains/state/storage', () => ({
    storage: {
        getState: () => getStateSpy(),
    },
}));

describe('sessionMachineTarget', () => {
    it('reads machine target from session metadata when available', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    metadata: {
                        machineId: 'm1',
                        path: '~/repo',
                    },
                },
            },
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm1',
            basePath: '~/repo',
        });
    });

    it('falls back to project key metadata for inactive sessions', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: '',
                        path: '',
                    },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm-project',
                            path: '/workspace/repo',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-project',
            basePath: '/workspace/repo',
        });
    });

    it('maps host-scoped project keys to a concrete machine id', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: '',
                        path: '',
                        host: 'mbp-host',
                    },
                },
            },
            machines: {
                m1: {
                    id: 'm1',
                    active: false,
                    activeAt: 1,
                    metadata: { host: 'mbp-host' },
                },
                m2: {
                    id: 'm2',
                    active: true,
                    activeAt: 2,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'host:mbp-host',
                            path: '/workspace/repo',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm2',
            basePath: '/workspace/repo',
        });
    });

    it('prefers project machine id when session machine id is stale', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/workspace/repo',
                        host: null,
                    },
                },
            },
            machines: {
                'm-project': {
                    id: 'm-project',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm-project',
                            path: '/workspace/repo',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-project',
            basePath: '/workspace/repo',
        });
    });

    it('resolves machine target from sibling sessions that share the same path', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: '',
                        path: '/workspace/repo',
                        host: '',
                    },
                },
                s2: {
                    active: true,
                    updatedAt: 100,
                    metadata: {
                        machineId: 'm-peer',
                        path: '/workspace/repo',
                        host: 'mbp.local',
                    },
                },
            },
            machines: {
                'm-peer': {
                    id: 'm-peer',
                    active: true,
                    activeAt: 42,
                    metadata: { host: 'mbp.local' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-peer',
            basePath: '/workspace/repo',
        });
    });

    it('disallows session-rpc fallback when session is inactive', async () => {
        const { canUseSessionRpc, shouldFallbackToSessionRpc } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                },
            },
        });

        const error = {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            message: 'Method not available',
        };
        expect(canUseSessionRpc('s1')).toBe(false);
        expect(shouldFallbackToSessionRpc('s1', error)).toBe(false);
    });
});
