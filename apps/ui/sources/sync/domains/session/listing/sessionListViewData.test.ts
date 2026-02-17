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
        active,
        activeAt,
        metadata: partial.metadata ?? null,
        metadataVersion: partial.metadataVersion ?? 0,
        agentState: partial.agentState ?? null,
        agentStateVersion: partial.agentStateVersion ?? 0,
        thinking: partial.thinking ?? false,
        thinkingAt: partial.thinkingAt ?? 0,
        presence: active ? 'online' : activeAt,
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

    it('propagates server scope metadata to all list rows when provided', () => {
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
                serverScope: { serverId: 'server-a', serverName: 'Server A' },
            }
        );

        for (const item of data) {
            expect((item as any).serverId).toBe('server-a');
            expect((item as any).serverName).toBe('Server A');
        }
    });

    it('can group active sessions by project while grouping inactive sessions by date', () => {
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
});
