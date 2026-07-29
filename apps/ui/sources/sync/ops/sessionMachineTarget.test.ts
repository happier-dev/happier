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
            machines: {
                m1: {
                    id: 'm1',
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'mbp-host' },
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
                            agentId: 'codex',
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
                    active: true,
                    activeAt: 2,
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
                            agentId: 'codex',
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
                            agentId: 'codex',
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
                    active: true,
                    activeAt: 2,
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
            machines: {
                'm-project': {
                    id: 'm-project',
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'project.local' },
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

    it('uses a unique active machine with matching host for inactive legacy sessions without machine ids', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: '',
                        path: '/workspace/repo',
                        host: 'mbp-host',
                    },
                },
            },
            machines: {
                'm-host': {
                    id: 'm-host',
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-host',
            basePath: '/workspace/repo',
        });
    });

    it('does not map host-scoped project keys to a latest-active machine id', async () => {
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

        expect(readMachineTargetForSession('s1')).toBeNull();
    });

    it('keeps a stale session machine id unavailable when there is no explicit replacement', async () => {
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

        expect(readMachineTargetForSession('s1')).toBeNull();
    });

    it('routes a stale session machine id to the unique same-host and same-home active replacement', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/alice/work/repo',
                        host: 'Alice-MBP.local',
                        homeDir: '/Users/alice/',
                    },
                },
            },
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'm-replacement',
                    metadata: { host: 'Alice-MBP', homeDir: '/Users/alice' },
                },
                'm-replacement': {
                    id: 'm-replacement',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'alice-mbp', homeDir: '/Users/alice' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-replacement',
            basePath: '/Users/alice/work/repo',
        });
    });

    it('routes a missing stale session machine id to the unique same-host and same-home active machine', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/alice/work/repo',
                        host: 'Alice-MBP.local',
                        homeDir: '/Users/alice/',
                    },
                },
            },
            machines: {
                'm-replacement': {
                    id: 'm-replacement',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'alice-mbp', homeDir: '/Users/alice' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-replacement',
            basePath: '/Users/alice/work/repo',
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
            machines: {
                'm-lookup': {
                    id: 'm-lookup',
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'lookup.local' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-lookup',
            basePath: '/workspace/rebound',
        });
    });

    it('does not resolve machine target from sibling sessions that share the same path', async () => {
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

        expect(readMachineTargetForSession('s1')).toBeNull();
    });

    it('keeps an inactive direct machine target unavailable instead of borrowing an active sibling', async () => {
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

        expect(readMachineTargetForSession('s1')).toBeNull();
    });

    it('keeps display attribution on stale metadata when there is no explicit replacement', async () => {
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
        } as any)).toBe('m-stale');
    });

    it('uses explicit replacement for display attribution', async () => {
        const { readDisplayMachineIdForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-old',
                        path: '/workspace/repo',
                    },
                },
            },
            machines: {
                'm-old': {
                    id: 'm-old',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'm-new',
                    replacedAt: 100,
                    replacementReason: 'manual_repair',
                    replacementSource: 'manual',
                    metadata: { host: 'mbp-host' },
                },
                'm-new': {
                    id: 'm-new',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readDisplayMachineIdForSession({
            sessionId: 's1',
            metadata: {
                machineId: 'm-old',
                path: '/workspace/repo',
            },
        } as any)).toBe('m-new');
    });

    it('does not borrow a linked project path from an unrelated machine for display', async () => {
        const { readDisplayPathForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-session',
                        path: '',
                    },
                },
            },
            machines: {
                'm-session': {
                    id: 'm-session',
                    active: false,
                    activeAt: 1,
                    metadata: { host: 'session-host' },
                },
                'm-project': {
                    id: 'm-project',
                    active: true,
                    activeAt: 2,
                    metadata: { host: 'project-host' },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm-project',
                            rootPath: '/workspace/project-machine',
                        },
                    }
                    : null,
        });

        expect(readDisplayPathForSession({
            sessionId: 's1',
            metadata: {
                machineId: 'm-session',
                path: '',
            },
        } as any)).toBe('');
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
                    agentId: 'claude',
                    machineId: 'm-direct',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                },
            },
        } as any)).toBe('m-direct');
    });

    it('uses the replacement target path when an old machine was explicitly replaced', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-old',
                        path: '/Users/test/workspace/stale',
                        homeDir: '/Users/test',
                        host: 'stale.local',
                    },
                },
            },
            machines: {
                'm-old': {
                    id: 'm-old',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'm-new',
                    replacedAt: 100,
                    replacementReason: 'manual_repair',
                    replacementSource: 'manual',
                    metadata: {
                        host: 'stale.local',
                        homeDir: '/Users/test',
                    },
                },
                'm-new': {
                    id: 'm-new',
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
                            machineId: 'm-new',
                            rootPath: '/Volumes/target/workspace/live',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-new',
            basePath: '/Volumes/target/workspace/live',
        });
    });

    it('prefers a hydrated raw session replacement target over stale visible list metadata', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-old',
                        path: '/Users/test/workspace/stale',
                        homeDir: '/Users/test',
                        host: 'stale.local',
                    },
                },
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    updatedAt: 1,
                    metadata: {
                        machineId: 'm-cached',
                        path: '/Users/test/workspace/cached',
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
                'm-old': {
                    id: 'm-old',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'm-new',
                    replacedAt: 100,
                    replacementReason: 'manual_repair',
                    replacementSource: 'manual',
                    metadata: {
                        host: 'stale.local',
                        homeDir: '/Users/test',
                    },
                },
                'm-new': {
                    id: 'm-new',
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
                            machineId: 'm-new',
                            rootPath: '/Volumes/target/workspace/live',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-new',
            basePath: '/Volumes/target/workspace/live',
        });
    });

    it('uses direct session metadata as a control target when machine inventory has not loaded yet', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-session',
                        path: '/workspace/repo',
                    },
                },
            },
            machines: {},
            getProjectForSession: () => null,
        });

        expect(readMachineControlTargetForSession('s1')).toEqual({
            machineId: 'm-session',
            basePath: '/workspace/repo',
            confidence: 'metadata_direct',
        });
    });

    it('does not use direct metadata as a control target when local machine state proves it is offline', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-session',
                        path: '/workspace/repo',
                    },
                },
            },
            machines: {
                'm-session': {
                    id: 'm-session',
                    active: false,
                    activeAt: 1,
                    metadata: { host: 'offline.local' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineControlTargetForSession('s1')).toBeNull();
    });

    it('does not use a project display target for control when direct session metadata points at another machine', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-session',
                        path: '/workspace/session',
                    },
                },
            },
            machines: {
                'm-project': {
                    id: 'm-project',
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'project.local' },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm-project',
                            rootPath: '/workspace/project',
                        },
                    }
                    : null,
        });

        expect(readMachineControlTargetForSession('s1')).toBeNull();
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
