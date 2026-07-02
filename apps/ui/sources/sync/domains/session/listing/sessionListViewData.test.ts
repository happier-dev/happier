import { describe, expect, it, vi } from 'vitest';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { buildSessionListViewData } from './sessionListViewData';

function makeSession(partial: Partial<Session> & Pick<Session, 'id'>): Session {
    const active = partial.active ?? false;
    const createdAt = partial.createdAt ?? 0;
    const activeAt = partial.activeAt ?? createdAt;
    const updatedAt = partial.updatedAt ?? createdAt;
    return {
        id: partial.id,
        seq: partial.seq ?? 0,
        createdAt,
        updatedAt,
        meaningfulActivityAt: (partial as Partial<Session> & { meaningfulActivityAt?: number | null }).meaningfulActivityAt ?? null,
        active,
        activeAt,
        metadata: partial.metadata ?? null,
        metadataVersion: partial.metadataVersion ?? 0,
        agentState: partial.agentState ?? null,
        agentStateVersion: partial.agentStateVersion ?? 0,
        thinking: partial.thinking ?? false,
        thinkingAt: partial.thinkingAt ?? 0,
        presence: active ? 'online' : activeAt,
        owner: partial.owner,
        ownerProfile: partial.ownerProfile,
        accessLevel: partial.accessLevel,
        canApprovePermissions: partial.canApprovePermissions,
        todos: partial.todos,
        draft: partial.draft,
        permissionMode: partial.permissionMode ?? null,
        permissionModeUpdatedAt: partial.permissionModeUpdatedAt ?? null,
        modelMode: partial.modelMode ?? null,
        latestUsage: partial.latestUsage ?? null,
    };
}

function makeMachine(partial: Partial<Machine> & Pick<Machine, 'id'>): Machine {
    const createdAt = partial.createdAt ?? 0;
    const active = partial.active ?? false;
    const activeAt = partial.activeAt ?? createdAt;
    return {
        id: partial.id,
        seq: partial.seq ?? 0,
        createdAt,
        updatedAt: partial.updatedAt ?? createdAt,
        active,
        activeAt,
        metadata: partial.metadata ?? null,
        metadataVersion: partial.metadataVersion ?? 0,
        daemonState: partial.daemonState ?? null,
        daemonStateVersion: partial.daemonStateVersion ?? 0,
    };
}

describe('buildSessionListViewData', () => {
    it('reuses a shared empty array when there are no visible sessions', () => {
        const valuesSpy = vi.spyOn(Object, 'values');
        const first = buildSessionListViewData({}, {}, { groupInactiveSessionsByProject: false });
        const second = buildSessionListViewData({}, {}, { groupInactiveSessionsByProject: true });

        expect(first).toBe(second);
        expect(first).toEqual([]);
        expect(valuesSpy).not.toHaveBeenCalled();
        valuesSpy.mockRestore();
    });

    it('does not sort singleton session buckets', () => {
        const sortSpy = vi.spyOn(Array.prototype, 'sort');
        try {
            const singleSessionData = buildSessionListViewData({
                s1: makeSession({
                    id: 's1',
                    active: true,
                    createdAt: 1,
                    updatedAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
            }, {
                m1: makeMachine({
                    id: 'm1',
                    metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
                }),
            }, { groupInactiveSessionsByProject: false });
            const sortCallsWithSingletonBucket = sortSpy.mock.calls.length;

            const twoSessionData = buildSessionListViewData({
                s1: makeSession({
                    id: 's1',
                    active: true,
                    createdAt: 1,
                    updatedAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
                s2: makeSession({
                    id: 's2',
                    active: true,
                    createdAt: 2,
                    updatedAt: 2,
                    metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
            }, {
                m1: makeMachine({
                    id: 'm1',
                    metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
                }),
            }, { groupInactiveSessionsByProject: false });

            expect(singleSessionData.some((item) => item.type === 'session')).toBe(true);
            expect(twoSessionData.some((item) => item.type === 'session')).toBe(true);
            expect(sortSpy.mock.calls.length - sortCallsWithSingletonBucket).toBe(1);
        } finally {
            sortSpy.mockRestore();
        }
    });

    it('does not sort already ordered session buckets', () => {
        const sortSpy = vi.spyOn(Array.prototype, 'sort');
        try {
            const data = buildSessionListViewData({
                s1: makeSession({
                    id: 's1',
                    active: true,
                    createdAt: 2,
                    updatedAt: 2,
                    metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
                s2: makeSession({
                    id: 's2',
                    active: true,
                    createdAt: 1,
                    updatedAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
            }, {
                m1: makeMachine({
                    id: 'm1',
                    metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
                }),
            }, { groupInactiveSessionsByProject: false });

            expect(data.some((item) => item.type === 'session')).toBe(true);
            expect(sortSpy).not.toHaveBeenCalled();
        } finally {
            sortSpy.mockRestore();
        }
    });

    it('groups inactive date rows by meaningful activity instead of technical updates', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 4, 17, 18, 0));
        const technicalUpdateToday = new Date(2026, 4, 17, 14, 0).getTime();
        const meaningfulYesterday = new Date(2026, 4, 16, 9, 0).getTime();
        const olderMeaningfulToday = new Date(2026, 4, 17, 8, 0).getTime();
        try {
            const data = buildSessionListViewData({
                staleMetadataRefresh: makeSession({
                    id: 'staleMetadataRefresh',
                    active: false,
                    createdAt: meaningfulYesterday,
                    updatedAt: technicalUpdateToday,
                    meaningfulActivityAt: meaningfulYesterday,
                    metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                } as Partial<Session> & Pick<Session, 'id'> & { meaningfulActivityAt: number }),
                actualToday: makeSession({
                    id: 'actualToday',
                    active: false,
                    createdAt: olderMeaningfulToday,
                    updatedAt: olderMeaningfulToday,
                    meaningfulActivityAt: olderMeaningfulToday,
                    metadata: { machineId: 'm1', path: '/home/u/repoB', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                } as Partial<Session> & Pick<Session, 'id'> & { meaningfulActivityAt: number }),
            }, {
                m1: makeMachine({
                    id: 'm1',
                    metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
                }),
            }, {
                groupInactiveSessionsByProject: false,
                inactiveGroupingV1: 'date',
            });

            const summary = data.map((item) => {
                if (item.type === 'header') return `header:${item.title}`;
                return `session:${item.session.id}`;
            });

            expect(summary).toEqual([
                'header:Inactive',
                'header:Today',
                'session:actualToday',
                'header:Yesterday',
                'session:staleMetadataRefresh',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('excludes hidden system sessions from the list view data', () => {
        const machine = makeMachine({
            id: 'm1',
            metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });

        const sessions: Record<string, Session> = {
            sys: makeSession({
                id: 'sys',
                createdAt: 1,
                updatedAt: 200,
                metadata: {
                    machineId: 'm1',
                    path: '/home/u/repoSys',
                    homeDir: '/home/u',
                    host: 'm1',
                    version: '0.0.0',
                    flavor: 'claude',
                    systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
                } as any,
            }),
            user: makeSession({
                id: 'user',
                createdAt: 2,
                updatedAt: 100,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const data = buildSessionListViewData(sessions, { [machine.id]: machine }, { groupInactiveSessionsByProject: false });
        const sessionIds = data.filter((i) => i.type === 'session').map((i: any) => i.session.id);
        expect(sessionIds).toEqual(['user']);
    });

    it('can render active and inactive sessions in one workspace-grouped section', () => {
        const machine = makeMachine({ id: 'm1', metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' } });

        const sessions: Record<string, Session> = {
            active: makeSession({
                id: 'active',
                active: true,
                createdAt: 3,
                updatedAt: 300,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            inactive: makeSession({
                id: 'inactive',
                active: false,
                createdAt: 2,
                updatedAt: 200,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            other: makeSession({
                id: 'other',
                active: false,
                createdAt: 1,
                updatedAt: 100,
                metadata: { machineId: 'm1', path: '/home/u/repoB', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const data = buildSessionListViewData(sessions, { [machine.id]: machine }, {
            groupInactiveSessionsByProject: false,
            activeGroupingV1: 'project',
            inactiveGroupingV1: 'date',
            sectionModeV1: 'single',
        });

        const summary = data.map((item) => {
            switch (item.type) {
                case 'header':
                    return `header:${item.headerKind ?? 'unknown'}:${item.title}`;
                case 'session':
                    return `session:${item.session.id}:${item.section ?? 'unknown'}:${item.groupKind ?? 'unknown'}:${item.variant ?? 'default'}`;
            }
        });

        expect(summary).toEqual([
            'header:sessions:Sessions',
            'header:project:~/repoA',
            'session:active:active:project:no-path',
            'session:inactive:inactive:project:no-path',
            'header:project:~/repoB',
            'session:other:inactive:project:no-path',
        ]);
    });

    it('reuses the shared empty array when every session is hidden system data', () => {
        const valuesSpy = vi.spyOn(Object, 'values');
        try {
            const machine = makeMachine({
                id: 'm1',
                metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
            });

            const sessions: Record<string, Session> = {
                sys1: makeSession({
                    id: 'sys1',
                    createdAt: 1,
                    updatedAt: 1,
                    metadata: {
                        machineId: 'm1',
                        path: '/home/u/repoSys1',
                        homeDir: '/home/u',
                        host: 'm1',
                        version: '0.0.0',
                        flavor: 'claude',
                        systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
                    } as any,
                }),
                sys2: makeSession({
                    id: 'sys2',
                    createdAt: 2,
                    updatedAt: 2,
                    metadata: {
                        machineId: 'm1',
                        path: '/home/u/repoSys2',
                        homeDir: '/home/u',
                        host: 'm1',
                        version: '0.0.0',
                        flavor: 'claude',
                        systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
                    } as any,
                }),
            };

            const first = buildSessionListViewData(sessions, { [machine.id]: machine }, { groupInactiveSessionsByProject: false });
            const second = buildSessionListViewData(sessions, { [machine.id]: machine }, { groupInactiveSessionsByProject: true });

            expect(first).toBe(second);
            expect(first).toEqual([]);
            expect(valuesSpy).not.toHaveBeenCalled();
        } finally {
            valuesSpy.mockRestore();
        }
    });

    it('groups inactive sessions by machine+path when enabled', () => {
        const machineA = makeMachine({ id: 'm1', metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' } });
        const machineB = makeMachine({ id: 'm2', metadata: { host: 'm2', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' } });

        const sessions: Record<string, Session> = {
            active: makeSession({
                id: 'active',
                active: true,
                createdAt: 1,
                updatedAt: 50,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            a1: makeSession({
                id: 'a1',
                createdAt: 2,
                updatedAt: 100,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            a2: makeSession({
                id: 'a2',
                createdAt: 3,
                updatedAt: 200,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            b1: makeSession({
                id: 'b1',
                createdAt: 4,
                updatedAt: 150,
                metadata: { machineId: 'm2', path: '/home/u/repoB', homeDir: '/home/u', host: 'm2', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const machines: Record<string, Machine> = {
            [machineA.id]: machineA,
            [machineB.id]: machineB,
        };

        const data = buildSessionListViewData(sessions, machines, { groupInactiveSessionsByProject: true });

        const summary = data.map((item) => {
            switch (item.type) {
                case 'header':
                    return `header:${item.headerKind ?? 'unknown'}:${item.title}`;
                case 'session':
                    return `session:${item.session.id}:${item.section ?? 'unknown'}:${item.variant ?? 'default'}`;
            }
        });

        expect(summary).toEqual([
            'header:active:Active',
            'header:project:~/repoA',
            'session:active:active:no-path',
            'header:inactive:Inactive',
            'header:project:~/repoB',
            'session:b1:inactive:no-path',
            'header:project:~/repoA',
            'session:a2:inactive:no-path',
            'session:a1:inactive:no-path',
        ]);
    });

    it('uses the canonical expanded grouping path for workspace scope while keeping home-relative display text', () => {
        const machine = makeMachine({
            id: 'm1',
            metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });
        const data = buildSessionListViewData({
            s1: makeSession({
                id: 's1',
                active: true,
                createdAt: 1,
                updatedAt: 1,
                metadata: { machineId: 'm1', path: '~/repo', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        }, {
            [machine.id]: machine,
        }, {
            groupInactiveSessionsByProject: true,
            serverScope: { serverId: 'server-1' },
        });

        const projectHeader = data.find((item) => item.type === 'header' && item.headerKind === 'project');
        expect(projectHeader).toMatchObject({
            title: '~/repo',
            workspaceScopeHint: {
                serverId: 'server-1',
                machineId: 'm1',
                rootPath: '/home/u/repo',
            },
        });
    });

    it('stores the newest project session id on project headers for session creation seeds', () => {
        const machine = makeMachine({
            id: 'm1',
            metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });
        const data = buildSessionListViewData({
            older: makeSession({
                id: 'older',
                active: true,
                createdAt: 10,
                updatedAt: 10,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            newest: makeSession({
                id: 'newest',
                active: true,
                createdAt: 20,
                updatedAt: 20,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'codex' },
            }),
        }, {
            [machine.id]: machine,
        }, {
            groupInactiveSessionsByProject: true,
            serverScope: { serverId: 'server-1' },
        });

        const projectHeader = data.find((item) => item.type === 'header' && item.headerKind === 'project');
        expect(projectHeader).toMatchObject({
            seedSessionId: 'newest',
        });
    });

    it('groups sessions by the canonical reachable machine target when metadata machine ids are stale', () => {
        const machineTarget = makeMachine({
            id: 'm-target',
            metadata: { host: 'target.local', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });

        const sessions: Record<string, Session> = {
            stale: makeSession({
                id: 'stale',
                createdAt: 4,
                updatedAt: 100,
                metadata: {
                    machineId: 'm-stale',
                    path: '/home/u/repoA',
                    homeDir: '/home/u',
                    host: 'stale.local',
                    version: '0.0.0',
                    flavor: 'claude',
                },
            }),
            peer: makeSession({
                id: 'peer',
                createdAt: 3,
                updatedAt: 200,
                metadata: {
                    machineId: 'm-target',
                    path: '/home/u/repoA',
                    homeDir: '/home/u',
                    host: 'target.local',
                    version: '0.0.0',
                    flavor: 'claude',
                },
            }),
        };

        const data = buildSessionListViewData(
            sessions,
            { [machineTarget.id]: machineTarget },
            {
                groupInactiveSessionsByProject: true,
                sessionTargetState: {
                    sessions,
                    machines: { [machineTarget.id]: machineTarget },
                    getProjectForSession: () => null,
                },
                serverScope: { serverId: 'server-1' },
            } as any,
        );

        const projectHeaders = data.filter((item): item is Extract<typeof item, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'project',
        );

        expect(projectHeaders).toHaveLength(1);
        expect(projectHeaders[0]?.subtitle).toBe('target.local');
        expect(projectHeaders[0]?.workspaceScopeHint).toMatchObject({
            serverId: 'server-1',
            machineId: 'm-target',
            rootPath: '/home/u/repoA',
        });
    });

    it('omits workspace scope hints when provided canonical state cannot resolve a workspace target', () => {
        const machine = makeMachine({
            id: 'm1',
            metadata: { host: 'host-a', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });
        const sessions: Record<string, Session> = {
            s1: makeSession({
                id: 's1',
                active: true,
                createdAt: 1,
                updatedAt: 1,
                metadata: {
                    machineId: 'host:stale',
                    path: '/home/u/repoA',
                    homeDir: '/home/u',
                    host: 'stale.local',
                    version: '0.0.0',
                    flavor: 'claude',
                },
            }),
        };

        const data = buildSessionListViewData(
            sessions,
            { [machine.id]: machine },
            {
                groupInactiveSessionsByProject: true,
                activeGroupingV1: 'project',
                serverScope: { serverId: 'server-1' },
                sessionTargetState: {
                    sessions,
                    sessionListRenderables: sessions,
                    machines: {},
                    getProjectForSession: () => null,
                },
            } as any,
        );

        const projectHeader = data.find((item): item is Extract<typeof item, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'project',
        );

        expect(projectHeader?.workspaceScopeHint).toBeNull();
    });

    it('does not treat /home/userfoo as inside /home/user', () => {
        const machine = makeMachine({ id: 'm1', metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/user' } });

        const sessions: Record<string, Session> = {
            s1: makeSession({
                id: 's1',
                createdAt: 1,
                updatedAt: 2,
                metadata: { machineId: 'm1', path: '/home/userfoo/repo', homeDir: '/home/user', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const data = buildSessionListViewData(sessions, { [machine.id]: machine }, { groupInactiveSessionsByProject: true });
        const header = data.find((i) => i.type === 'header' && i.headerKind === 'project') as any;
        expect(header?.title).toBe('/home/userfoo/repo');
    });

    it('propagates normalized server scope metadata to all list rows when provided', () => {
        const machine = makeMachine({
            id: 'm1',
            metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });

        const sessions: Record<string, Session> = {
            active: makeSession({
                id: 'active',
                active: true,
                createdAt: 1,
                updatedAt: 100,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            inactive: makeSession({
                id: 'inactive',
                createdAt: 2,
                updatedAt: 50,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const data = buildSessionListViewData(
            sessions,
            { [machine.id]: machine },
            {
                groupInactiveSessionsByProject: true,
                serverScope: { serverId: ' server-a ', serverName: ' Server A ' },
            }
        );

        for (const item of data) {
            expect((item as any).serverId).toBe('server-a');
            expect((item as any).serverName).toBe('Server A');
        }
    });

    it('groups inactive sessions by meaningful activity date while grouping active sessions by project', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 1, 17, 12, 0, 0));

        try {
            const machine = makeMachine({
                id: 'm1',
                metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
            });

            const sessions: Record<string, Session> = {
                act1: makeSession({
                    id: 'act1',
                    active: true,
                    createdAt: new Date(2026, 1, 17, 8, 0, 0).getTime(),
                    updatedAt: new Date(2026, 1, 17, 8, 0, 0).getTime(),
                    metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
                act2: makeSession({
                    id: 'act2',
                    active: true,
                    createdAt: new Date(2026, 1, 17, 9, 0, 0).getTime(),
                    updatedAt: new Date(2026, 1, 17, 9, 0, 0).getTime(),
                    metadata: { machineId: 'm1', path: '/home/u/repoB', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
                in1: makeSession({
                    id: 'in1',
                    createdAt: new Date(2026, 1, 16, 7, 0, 0).getTime(),
                    updatedAt: new Date(2026, 1, 17, 7, 0, 0).getTime(),
                    metadata: { machineId: 'm1', path: '/home/u/repoC', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
            };

            const data = buildSessionListViewData(sessions, { [machine.id]: machine }, {
                groupInactiveSessionsByProject: false,
                activeGroupingV1: 'project',
                inactiveGroupingV1: 'date',
            });

            const summary = data.map((item) => {
                switch (item.type) {
                    case 'header':
                        return `header:${item.headerKind ?? 'unknown'}:${item.title}`;
                    case 'session':
                        return `session:${item.session.id}:${item.section ?? 'unknown'}:${item.variant ?? 'default'}`;
                }
            });

            expect(summary).toEqual([
                'header:active:Active',
                'header:project:~/repoB',
                'session:act2:active:no-path',
                'header:project:~/repoA',
                'session:act1:active:no-path',
                'header:inactive:Inactive',
                'header:date:Yesterday',
                'session:in1:inactive:default',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses the same project group key across active and inactive sections for the same workspace', () => {
        const machine = makeMachine({
            id: 'm1',
            metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });
        const data = buildSessionListViewData({
            active: makeSession({
                id: 'active',
                active: true,
                createdAt: 2,
                updatedAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            inactive: makeSession({
                id: 'inactive',
                active: false,
                createdAt: 1,
                updatedAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        }, { [machine.id]: machine }, { groupInactiveSessionsByProject: true });

        const projectGroupKeys = data.flatMap((item) => (
            item.type === 'header' && item.headerKind === 'project' && item.groupKey
                ? [item.groupKey]
                : []
        ));

        expect(projectGroupKeys).toHaveLength(2);
        expect(new Set(projectGroupKeys).size).toBe(1);
        expect(projectGroupKeys[0]).toMatch(/^server:[^:]+:project:/);
    });

    it('places shared sessions into a dedicated subgroup inside active and inactive sections', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 1, 17, 12, 0, 0));

        try {
            const machine = makeMachine({
                id: 'm1',
                metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
            });

            const sessions: Record<string, Session> = {
                ownActive: makeSession({
                    id: 'ownActive',
                    active: true,
                    createdAt: new Date(2026, 1, 17, 8, 0, 0).getTime(),
                    updatedAt: new Date(2026, 1, 17, 8, 0, 0).getTime(),
                    metadata: { machineId: 'm1', path: '/home/u/own-active', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
                sharedActive: makeSession({
                    id: 'sharedActive',
                    active: true,
                    createdAt: new Date(2026, 1, 17, 9, 0, 0).getTime(),
                    updatedAt: new Date(2026, 1, 17, 9, 0, 0).getTime(),
                    metadata: { machineId: 'm1', path: '/home/u/shared-active', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                    owner: 'friend-1',
                } as any),
                ownInactive: makeSession({
                    id: 'ownInactive',
                    createdAt: new Date(2026, 1, 16, 7, 0, 0).getTime(),
                    updatedAt: new Date(2026, 1, 16, 7, 0, 0).getTime(),
                    metadata: { machineId: 'm1', path: '/home/u/own-inactive', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                }),
                sharedInactive: makeSession({
                    id: 'sharedInactive',
                    createdAt: new Date(2026, 1, 16, 9, 0, 0).getTime(),
                    updatedAt: new Date(2026, 1, 16, 9, 0, 0).getTime(),
                    metadata: { machineId: 'm1', path: '/home/u/shared-inactive', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
                    owner: 'friend-2',
                } as any),
            };

            const data = buildSessionListViewData(sessions, { [machine.id]: machine }, { groupInactiveSessionsByProject: false });

            const summary = data.map((item) => {
                switch (item.type) {
                    case 'header':
                        return `header:${item.headerKind ?? 'unknown'}:${item.title}`;
                    case 'session':
                        return `session:${item.session.id}:${item.section ?? 'unknown'}:${item.groupKind ?? 'default'}`;
                }
            });

            expect(summary).toEqual([
                'header:active:Active',
                'header:shared:Shared sessions',
                'session:sharedActive:active:shared',
                'header:project:~/own-active',
                'session:ownActive:active:project',
                'header:inactive:Inactive',
                'header:shared:Shared sessions',
                'session:sharedInactive:inactive:shared',
                'header:date:Yesterday',
                'session:ownInactive:inactive:date',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });
});
