import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { SessionMachineTargetState } from './sessionMachineTarget';

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
    it.each(['replacement', 'locality'] as const)('does not recover an old workspace on a %s target', async (kind) => {
        const { resolveMachineControlTargetForSessionFromState } = await import('./sessionMachineTarget');
        const current = createMachineFixture({ id: 'machine-new' });
        const old = createMachineFixture({ id: 'machine-old', active: false, replacedByMachineId: 'machine-new' });
        const state: SessionMachineTargetState = {
            sessions: { direct: { active: false, metadata: {
                path: '', machineId: 'machine-old', host: current.metadata!.host, homeDir: current.metadata!.homeDir,
                sessionWorkspaceLocationV1: { v: 1, machineId: 'machine-old',
                    agentPath: '/agent/old', machinePath: '/host/old' },
            } } },
            machines: kind === 'replacement' ? { 'machine-old': old, 'machine-new': current } : { 'machine-new': current },
        };
        expect(resolveMachineControlTargetForSessionFromState(state, 'direct')).toBeNull();
        expect(resolveMachineControlTargetForSessionFromState({ ...state,
            getProjectForSession: () => ({ key: { machineId: 'machine-new', path: '/new/project' } }),
        }, 'direct')).toMatchObject({ machineId: 'machine-new', basePath: '/new/project' });
    });

    it('targets an existing Direct session with an empty path using its same-machine workspace mapping', async () => {
        const { resolveMachineControlTargetForSessionFromState } = await import('./sessionMachineTarget');
        const state = {
            sessions: { direct: { active: true, metadata: {
                path: '', machineId: 'machine-1',
                sessionWorkspaceLocationV1: { v: 1, machineId: 'machine-1',
                    agentPath: '/agent/project', machinePath: '/host/project' },
            } } },
            machines: {},
        };
        expect(resolveMachineControlTargetForSessionFromState(state, 'direct')).toEqual({
            machineId: 'machine-1', basePath: '/host/project', agentBasePath: '/agent/project',
            confidence: 'metadata_direct',
        });
        expect(resolveMachineControlTargetForSessionFromState({
            ...state, sessions: { direct: { active: true, metadata: {
                ...state.sessions.direct.metadata, machineId: 'other-machine',
            } } },
        }, 'direct')).toBeNull();
    });

    it('keeps a foreign Home display target separate from a colliding active Session and project', async () => {
        const { resolveDisplayMachineTargetForSessionFromState } = await import('./sessionMachineTarget');
        const state = {
            sessions: { same: { active: false, metadata: { machineId: 'active-machine', path: '/active-session' } } },
            machines: {},
            getProjectForSession: () => ({ key: { machineId: 'active-machine', path: '/active-project' } }),
        };
        const input = { state, sessionId: 'same', serverId: 'foreign-home', activeServerId: 'active-home' };
        expect(resolveDisplayMachineTargetForSessionFromState({ ...input,
            metadata: { machineId: 'foreign-machine', path: '/foreign-session' },
        })).toMatchObject({ machineId: 'foreign-machine', basePath: '/foreign-session' });
        expect(resolveDisplayMachineTargetForSessionFromState(input)).toBeNull();
    });

    it('uses active Session and project overlays only for the matching Home or an unscoped caller', async () => {
        const { resolveDisplayMachineTargetForSessionFromState } = await import('./sessionMachineTarget');
        const state = {
            sessions: { same: { active: false, metadata: { machineId: 'active-machine', path: '/active-session' } } },
            machines: {},
            getProjectForSession: () => ({ key: { machineId: 'active-machine', path: '/active-project' } }),
        };
        const input = { state, sessionId: 'same', metadata: { machineId: 'row-machine', path: '/row-session' } };
        for (const scope of [{}, { serverId: 'active-home', activeServerId: 'active-home' }]) {
            expect(resolveDisplayMachineTargetForSessionFromState({ ...input, ...scope }))
                .toMatchObject({ machineId: 'active-machine', basePath: '/active-project' });
        }
        expect(resolveDisplayMachineTargetForSessionFromState({ ...input, serverId: 'foreign-home' }))
            .toMatchObject({ machineId: 'row-machine', basePath: '/row-session' });
    });

    it('captures the current Home for an explicitly scoped display-target read', async () => {
        const { readDisplayMachineTargetForSession } = await import('./sessionMachineTarget');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const activeServerId = getActiveServerSnapshot().serverId;
        getStateSpy.mockReturnValue({
            sessions: { same: { metadata: { machineId: 'active-machine', path: '/active-session' } } },
            machines: {},
        });
        const input = { sessionId: 'same', metadata: { machineId: 'row-machine', path: '/row-session' } };
        expect(readDisplayMachineTargetForSession({ ...input, serverId: `foreign-${activeServerId}` }))
            .toMatchObject({ machineId: 'row-machine', basePath: '/row-session' });
        expect(readDisplayMachineTargetForSession({ ...input, serverId: activeServerId }))
            .toMatchObject({ machineId: 'active-machine', basePath: '/active-session' });
    });

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
                        directSessionV1: {
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
                'm-direct': {
                    id: 'm-direct',
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-direct',
            basePath: '/workspace/direct-repo',
        });
    });

    it('uses an active worktree session path instead of the linked project path', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: true,
                    metadata: {
                        machineId: 'm1',
                        path: '/workspace/repo/.dev/worktree/gentle-meadow',
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
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm1',
                            path: '/workspace/repo',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm1',
            basePath: '/workspace/repo/.dev/worktree/gentle-meadow',
        });
    });

    it('uses the mapped machine root for an active sandbox workspace while retaining its agent root', async () => {
        const { readDisplayPathForSession, readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: true,
                    metadata: {
                        machineId: 'm1',
                        path: '/home/coder/project',
                        sessionWorkspaceLocationV1: {
                            v: 1,
                            machineId: 'm1',
                            agentPath: '/home/coder/project',
                            machinePath: '/Users/alice/project',
                        },
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
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm1',
            basePath: '/Users/alice/project',
            agentBasePath: '/home/coder/project',
        });
        expect(readDisplayPathForSession({
            sessionId: 's1',
            metadata: getStateSpy().sessions.s1.metadata,
        })).toBe('/home/coder/project');
    });

    it('does not reuse a sandbox mapping after the session machine is replaced', async () => {
        const { readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-old',
                        path: '/home/coder/project',
                        sessionWorkspaceLocationV1: {
                            v: 1,
                            machineId: 'm-old',
                            agentPath: '/home/coder/project',
                            machinePath: '/Users/alice/project',
                        },
                    },
                },
            },
            machines: {
                'm-old': {
                    id: 'm-old',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'm-new',
                    metadata: { host: 'old-host' },
                },
                'm-new': {
                    id: 'm-new',
                    active: true,
                    activeAt: 2,
                    metadata: { host: 'new-host' },
                },
            },
            getProjectForSession: () => ({
                key: {
                    machineId: 'm-new',
                    path: '/Volumes/new/project',
                },
            }),
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-new',
            basePath: '/Volumes/new/project',
        });
    });

    it('rebases absolute agent paths as well as relative paths onto the mapped machine root', async () => {
        const { resolveMachinePathFromSessionBase } = await import('./sessionMachineTarget');
        const input = {
            basePath: 'C:\\Users\\alice\\project',
            agentBasePath: '/home/coder/project',
        };

        expect(resolveMachinePathFromSessionBase({
            ...input,
            requestPath: '/home/coder/project/docs/report.md',
        })).toBe('C:\\Users\\alice\\project\\docs\\report.md');
        expect(resolveMachinePathFromSessionBase({
            ...input,
            requestPath: 'docs/report.md',
        })).toBe('C:\\Users\\alice\\project\\docs/report.md');
        expect(resolveMachinePathFromSessionBase({
            ...input,
            requestPath: '/home/coder/project-sibling/report.md',
        })).toBe('/home/coder/project-sibling/report.md');
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

    it('resolves the unique active same-host machine when the project key only carries the synthetic unknown machine scope', async () => {
        const { readMachineTargetForSession, readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        // A session whose metadata never received a machineId (e.g. a fork shell that was
        // created server-side but whose runner never attached) gets a project key with the
        // synthetic "unknown" machine scope. That placeholder must not disable the
        // unique-active-host fallback, and must never leak out as a control-target machine id.
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
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
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'unknown',
                            path: '/workspace/repo',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-host',
            basePath: '/workspace/repo',
        });
        expect(readMachineControlTargetForSession('s1')).toEqual({
            machineId: 'm-host',
            basePath: '/workspace/repo',
            confidence: 'reachable',
        });
    });

    it('never emits the synthetic unknown machine scope as a control target when no host match exists', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        path: '/workspace/repo',
                        host: 'mbp-host',
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
                            machineId: 'unknown',
                            path: '/workspace/repo',
                        },
                    }
                    : null,
        });

        // Ambiguous host: no reachable target may resolve, and the placeholder must not be
        // handed back as a routable machine id (RPCs to machine "unknown" fail silently).
        expect(readMachineControlTargetForSession('s1')).toBeNull();
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
                            path: '/workspace/repo',
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
                            path: '/workspace/repo',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toBeNull();
    });

    it('uses direct session metadata as a control target when machine inventory has not loaded yet', async () => {
        const { readMachineControlTargetForSession, readMachineTargetForSession } = await import('./sessionMachineTarget');
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

        expect(readMachineTargetForSession('s1')).toBeNull();
        expect(readMachineControlTargetForSession('s1')).toEqual({
            machineId: 'm-session',
            originMachineId: 'm-session',
            replaced: false,
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
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineControlTargetForSession('s1')).toBeNull();
    });

    it('recovers a control target for an inactive session when its stale machine is replaced by a unique active same-host home', async () => {
        const { readMachineControlTargetForSession, readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/test/workspace/repo',
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 1,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            machineDisplayById: {
                'm-current': {
                    id: 'm-current',
                    active: true,
                    activeAt: 2,
                    updatedAt: 2,
                    metadataVersion: 1,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toBeNull();
        expect(readMachineControlTargetForSession('s1')).toEqual({
            machineId: 'm-current',
            basePath: '/Users/test/workspace/repo',
            confidence: 'reachable',
        });
    });

    it('recovers a stale control target from host and home when the old machine record is absent', async () => {
        const { readMachineControlTargetForSession, readMachineTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/test/workspace/repo',
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            machines: {},
            machineDisplayById: {
                'm-current': {
                    id: 'm-current',
                    active: true,
                    activeAt: 2,
                    updatedAt: 2,
                    metadataVersion: 1,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineTargetForSession('s1')).toBeNull();
        expect(readMachineControlTargetForSession('s1')).toEqual({
            machineId: 'm-current',
            basePath: '/Users/test/workspace/repo',
            confidence: 'reachable',
        });
    });

    it('recovers a stale control target when host and Windows home path formatting drift', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: 'C:\\Users\\Leeroy\\workspace\\repo',
                        host: 'LEEROY-MBP.local',
                        homeDir: 'C:\\Users\\Leeroy\\',
                    },
                },
            },
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 1,
                    metadata: {
                        host: 'leeroy-mbp',
                        homeDir: 'c:/users/leeroy',
                    },
                },
            },
            machineDisplayById: {
                'm-current': {
                    id: 'm-current',
                    active: true,
                    activeAt: 2,
                    updatedAt: 2,
                    metadataVersion: 1,
                    metadata: {
                        host: 'leeroy-mbp',
                        homeDir: 'c:/users/leeroy',
                    },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineControlTargetForSession('s1')).toEqual({
            machineId: 'm-current',
            basePath: 'C:\\Users\\Leeroy\\workspace\\repo',
            confidence: 'reachable',
        });
    });

    it('does not recover a stale control target when active same-host homes are ambiguous', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/test/workspace/repo',
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 1,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
                'm-current-a': {
                    id: 'm-current-a',
                    active: true,
                    activeAt: 2,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
                'm-current-b': {
                    id: 'm-current-b',
                    active: true,
                    activeAt: 3,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineControlTargetForSession('s1')).toBeNull();
    });

    it('does not recover a stale control target through revoked or replaced active candidates', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/test/workspace/repo',
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 1,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
                'm-revoked': {
                    id: 'm-revoked',
                    active: true,
                    activeAt: 2,
                    revokedAt: 3,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
                'm-replaced': {
                    id: 'm-replaced',
                    active: true,
                    activeAt: 4,
                    replacedByMachineId: 'm-current',
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineControlTargetForSession('s1')).toBeNull();
    });

    it('does not recover a stale control target when the recorded stale machine was revoked or replaced', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        const baseState = {
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/test/workspace/repo',
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            machineDisplayById: {
                'm-current': {
                    id: 'm-current',
                    active: true,
                    activeAt: 2,
                    updatedAt: 2,
                    metadataVersion: 1,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            getProjectForSession: () => null,
        };

        getStateSpy.mockReturnValue({
            ...baseState,
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 1,
                    revokedAt: 3,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
        });
        expect(readMachineControlTargetForSession('s1')).toBeNull();

        getStateSpy.mockReturnValue({
            ...baseState,
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'm-other',
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
        });
        expect(readMachineControlTargetForSession('s1')).toBeNull();
    });

    it('does not recover a stale control target without same-home proof', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/test/workspace/repo',
                        host: 'mbp-host',
                        homeDir: null,
                    },
                },
            },
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 1,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: null,
                    },
                },
                'm-current': {
                    id: 'm-current',
                    active: true,
                    activeAt: 2,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineControlTargetForSession('s1')).toBeNull();
    });

    it('does not recover a stale control target across different homes on the same host', async () => {
        const { readMachineControlTargetForSession } = await import('./sessionMachineTarget');
        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/Users/test/workspace/repo',
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
            },
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 1,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/test',
                    },
                },
                'm-other-home': {
                    id: 'm-other-home',
                    active: true,
                    activeAt: 2,
                    metadata: {
                        host: 'mbp-host',
                        homeDir: '/Users/other',
                    },
                },
            },
            getProjectForSession: () => null,
        });

        expect(readMachineControlTargetForSession('s1')).toBeNull();
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
                            path: '/workspace/repo',
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
                            path: '/workspace/project-machine',
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
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
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
                            path: '/Volumes/target/workspace/live',
                        },
                    }
                    : null,
        });

        expect(readMachineTargetForSession('s1')).toEqual({
            machineId: 'm-new',
            basePath: '/Volumes/target/workspace/live',
        });
    });

    it('recovers missing active Machine context without retrying a genuine decryption failure', async () => {
        const { shouldFallbackFromMachineRpc } = await import('./sessionMachineTarget');
        expect(shouldFallbackFromMachineRpc(createRpcCallError({
            error: 'Machine context unavailable', errorCode: 'machine_rpc_context_unavailable',
        }))).toBe(true);
        expect(shouldFallbackFromMachineRpc(createRpcCallError({
            error: 'Machine response could not be decrypted', errorCode: 'machine_rpc_decryption_failed',
        }))).toBe(false);
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
