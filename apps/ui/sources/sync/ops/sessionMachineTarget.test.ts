import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const getStateSpy = vi.fn();

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => getStateSpy(),
    },
});
});

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

    it('resolves machine target from linked direct-session metadata when top-level machine id is absent', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        path: '/workspace/direct-repo',
                        externalSessionV1: {
                            v: 1,
                            providerId: 'codex',
                            machineId: 'm-direct',
                            remoteSessionId: 'remote-1',
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    },
                },
            },
            machines: {
                'm-other': {
                    id: 'm-other',
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'other.local' },
                },
                'm-direct': {
                    id: 'm-direct',
                    active: false,
                    activeAt: 0,
                    metadata: { host: 'direct.local' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-direct',
            basePath: '/workspace/direct-repo',
        });
    });

    it('uses canonical direct-session metadata when visible list metadata is stripped', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        path: '/workspace/direct-repo',
                        externalSessionV1: {
                            v: 1,
                            providerId: 'codex',
                            machineId: 'm-direct',
                            remoteSessionId: 'remote-1',
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    },
                },
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    updatedAt: 10,
                    metadata: {
                        path: '/workspace/direct-repo',
                        machineId: null,
                        externalSessionV1: {
                            v: 1,
                            providerId: 'codex',
                        },
                    },
                },
            },
            sessionListIndexByServerId: {
                'server-a': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'server-a',
                        serverName: 'Server A',
                    },
                ],
            },
            machines: {
                'm-other': {
                    id: 'm-other',
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'other.local' },
                },
                'm-direct': {
                    id: 'm-direct',
                    active: false,
                    activeAt: 0,
                    metadata: { host: 'direct.local' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-direct',
            basePath: '/workspace/direct-repo',
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
                            rootPath: '/workspace/repo',
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
                            rootPath: '/workspace/repo',
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
                            rootPath: '/workspace/repo',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-project',
            basePath: '/workspace/repo',
        });
    });

    it('uses visible lookup session metadata when the raw session is not hydrated', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {},
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    updatedAt: 42,
                    metadata: {
                        machineId: 'm-lookup',
                        path: '/workspace/rebound',
                        host: 'lookup.local',
                    },
                },
            },
            sessionListIndexByServerId: {
                'server-a': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'server-a',
                        serverName: 'Server A',
                    },
                ],
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-lookup',
            basePath: '/workspace/rebound',
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

    it('prefers an active sibling session over an inactive direct machine target', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
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
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 0,
                    metadata: { host: 'stale.local' },
                },
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

    it('prefers the reachable machine target for display when metadata machine id is stale', async () => {
        const { readDisplayMachineIdForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/workspace/repo',
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
                            rootPath: '/workspace/repo',
                        },
                    }
                    : null,
        });

        expect(readDisplayMachineIdForSession({
            sessionId: 's1',
            metadata: {
                machineId: 'm-stale',
                path: '/workspace/repo',
            },
        } as any)).toBe('m-project');
    });

    it('falls back to the linked direct-session machine id for display when no reachable target exists', async () => {
        const { readDisplayMachineIdForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {},
            machines: {},
        });

        expect(readDisplayMachineIdForSession({
            sessionId: 'missing',
            metadata: {
                externalSessionV1: {
                    v: 1,
                    providerId: 'claude',
                    machineId: 'm-direct',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                },
            },
        } as any)).toBe('m-direct');
    });

    it('prefers the reachable project path when the stored session path is stale after handoff', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/test/workspace/stale',
                        homeDir: '/Users/test',
                        host: 'stale.local',
                    },
                },
            },
            machines: {
                'm-project': {
                    id: 'm-project',
                    active: true,
                    activeAt: 10,
                    metadata: {
                        host: 'project.local',
                        homeDir: '/workspace',
                    },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm-project',
                            rootPath: '/Volumes/target/workspace/live',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-project',
            basePath: '/Volumes/target/workspace/live',
        });
    });

    it('treats inactive sessions as session-rpc unavailable', async () => {
        const { canUseSessionRpc } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                },
            },
        });

        expect(canUseSessionRpc('s1')).toBe(false);
    });
});
