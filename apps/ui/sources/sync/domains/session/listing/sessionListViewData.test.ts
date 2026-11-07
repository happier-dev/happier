import { describe, expect, it, vi } from 'vitest';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { applySessionFoldersToSessionListViewData, buildSessionListViewData, type SessionListViewItem } from './sessionListViewData';
import { buildSessionListRenderableFromSession, didSessionListRenderableProjectGroupingFieldsChange, preserveSessionListRenderableStaleFields } from './sessionListRenderable';

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
        permissionMode: partial.permissionMode ?? null,
        permissionModeUpdatedAt: partial.permissionModeUpdatedAt ?? null,
        modelMode: partial.modelMode ?? null,
        latestUsage: partial.latestUsage ?? null,
        owner: partial.owner,
        accessLevel: partial.accessLevel,
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
    function repositorySession(id: string, path: string, rootPath = '/repo', active = true, worktreePath = path): Session {
        const metadata = {
            machineId: 'm1', path, host: 'host', version: '0.0.0',
            sessionRepositoryV1: { v: 1 as const, machineId: 'm1', rootPath, worktreePath },
        };
        return makeSession({ id, active, createdAt: 1, metadata });
    }

    it('groups linked worktrees by repository in each activity section without merging independent clones', () => {
        const sessions = [
            repositorySession('main', '/repo'),
            repositorySession('topic', '/worktrees/topic'),
            repositorySession('nested-topic', '/worktrees/topic/packages/app', '/repo', true, '/worktrees/topic'),
            repositorySession('clone', '/clone', '/clone'),
            repositorySession('old-main', '/repo', '/repo', false),
            repositorySession('old-topic', '/worktrees/old-topic', '/repo', false),
        ];
        const data = buildSessionListViewData(
            Object.fromEntries(sessions.map((session) => [session.id, buildSessionListRenderableFromSession(session)])),
            { m1: makeMachine({ id: 'm1' }) },
            { groupInactiveSessionsByProject: true, serverScope: { serverId: 'server-a' } },
        );
        const headers = data.filter((item) => item.type === 'header').filter((item) => item.headerKind === 'project');
        expect(headers.map((header) => header.title).sort()).toEqual(['clone', 'repo', 'repo']);
        const rows = data.filter((item) => item.type === 'session');
        for (const session of sessions) {
            expect(rows.find((row) => row.session.id === session.id)?.workspace).toEqual({
                t: 'workspaceScope', serverId: 'server-a', machineId: 'm1', rootPath: session.metadata?.path,
            });
        }
        expect(rows.find((row) => row.session.id === 'topic')?.variant).toBe('default');
        expect(sessions[1]?.metadata?.path).toBe('/worktrees/topic');
    });

    it('can retain directory headings for linked worktrees', () => {
        const sessions = [repositorySession('main', '/repo'), repositorySession('topic', '/worktrees/topic')];
        const options = { groupInactiveSessionsByProject: true, groupGitWorktreesByRepository: false };
        const data = buildSessionListViewData(Object.fromEntries(sessions.map((session) => [session.id, session])), {}, options);
        expect(data.filter((item) => item.type === 'header').filter((item) => item.headerKind === 'project').map((item) => item.title).sort())
            .toEqual(['repo', 'topic']);
    });

    it('updates grouping when repository evidence arrives and preserves unchanged renderable identity', () => {
        const session = repositorySession('topic', '/worktrees/topic');
        const known = buildSessionListRenderableFromSession(session);
        const withoutRepository = buildSessionListRenderableFromSession({
            ...session,
            metadata: { machineId: 'm1', host: 'host', path: '/worktrees/topic', version: '0.0.0' },
        });
        expect(didSessionListRenderableProjectGroupingFieldsChange(withoutRepository, known)).toBe(true);
        expect(preserveSessionListRenderableStaleFields(withoutRepository, known)).not.toBe(withoutRepository);
        expect(preserveSessionListRenderableStaleFields(known, buildSessionListRenderableFromSession(session))).toBe(known);
    });

    it('ignores stale repository evidence outside its recorded checkout', () => {
        const session = repositorySession('topic', '/worktrees/topic');
        const moved = makeSession({ ...session, metadata: { ...session.metadata!, path: '/worktrees/topic-other' } });
        const data = buildSessionListViewData({ moved }, {}, { groupInactiveSessionsByProject: true });
        expect(data.filter((item) => item.type === 'header').find((item) => item.headerKind === 'project')?.title).toBe('topic-other');
    });

    it.each([
        { path: '/src', worktreePath: '/', rootPath: '/', homeDir: undefined, title: '/' },
        { path: '~\\topic\\src', worktreePath: 'C:\\worktrees\\topic', rootPath: 'C:\\main-repo', homeDir: 'C:\\worktrees\\', title: 'main-repo' },
        { path: '\\\\server\\share\\topic\\src', worktreePath: '//server/share/topic', rootPath: '//server/share/main-repo', homeDir: undefined, title: 'main-repo' },
    ])('normalizes repository evidence using the existing path rules ($path)', ({ path, worktreePath, rootPath, homeDir, title }) => {
        const original = repositorySession('topic', path, rootPath, true, worktreePath);
        const session = makeSession({ ...original, metadata: { ...original.metadata!, homeDir } });
        const data = buildSessionListViewData({ topic: session }, {}, { groupInactiveSessionsByProject: true });
        expect(data.filter((item) => item.type === 'header').find((item) => item.headerKind === 'project')?.title).toBe(title);
        expect(session.metadata?.path).toBe(path);
    });

    it('retains checkout-scoped folders under a shared repository heading, including after placement projection', () => {
        const sessions = [repositorySession('main', '/repo'), repositorySession('topic', '/worktrees/topic')];
        const sessionMap = Object.fromEntries(sessions.map((session) => [session.id, session]));
        const machines = { m1: makeMachine({ id: 'm1' }) };
        const sessionFolders = {
            enabled: true,
            folders: { v: 1 as const, folders: sessions.map((session) => ({
                id: `folder-${session.id}`, name: 'Planning', parentId: null, createdAt: 1, updatedAt: 1,
                workspace: { t: 'workspaceScope' as const, serverId: 'server-a', machineId: 'm1', rootPath: session.metadata!.path },
            })) },
            assignmentsBySessionKey: { 'server-a:main': 'folder-main', 'server-a:topic': 'folder-topic' },
        };
        const options = { groupInactiveSessionsByProject: true, serverScope: { serverId: 'server-a' } };
        const direct = buildSessionListViewData(sessionMap, machines, { ...options, sessionFolders });
        const projected = applySessionFoldersToSessionListViewData(buildSessionListViewData(sessionMap, machines, options), sessionFolders);
        expect(projected).toEqual(direct);
        expect(direct.filter((item) => item.type === 'header' && item.headerKind === 'project')).toHaveLength(1);
        expect(direct.filter((item) => item.type === 'session').map((item) => [item.session.id, item.folderId, item.workspace?.t === 'workspaceScope' && item.workspace.rootPath]).sort())
            .toEqual([['main', 'folder-main', '/repo'], ['topic', 'folder-topic', '/worktrees/topic']]);
    });

    it('shows repository-scope folders when only a linked checkout has visible sessions', () => {
        const topic = repositorySession('topic', '/worktrees/topic');
        const data = buildSessionListViewData({ topic }, {}, {
            groupInactiveSessionsByProject: true,
            serverScope: { serverId: 'server-a' },
            sessionFolders: {
                enabled: true,
                folders: { v: 1, folders: [{
                    id: 'main-planning', name: 'Planning', parentId: null, createdAt: 1, updatedAt: 1,
                    workspace: { t: 'workspaceScope', serverId: 'server-a', machineId: 'm1', rootPath: '/repo' },
                }] },
                assignmentsBySessionKey: {},
            },
        });
        expect(data.filter((item) => item.type === 'header' && item.headerKind === 'folder').map((item) => item.folderId))
            .toEqual(['main-planning']);
        expect(data.find((item) => item.type === 'session')?.workspace)
            .toEqual({ t: 'workspaceScope', serverId: 'server-a', machineId: 'm1', rootPath: '/worktrees/topic' });
    });

    it.each(['date', 'project'] as const)('projects producer-scoped workspaces for %s rows with folder view off', (grouping) => {
        const rows = ['server-a', 'server-b'].flatMap((serverId) => {
            const machineId = `${serverId}-machine`;
            const rootPath = `/home/${serverId}/repo`;
            const metadata = { machineId, path: rootPath, host: serverId, version: '0.0.0' };
            const session = makeSession({ id: 'same-session-id', metadata });
            const shared = makeSession({ id: 'shared', metadata, owner: 'friend' });
            return buildSessionListViewData({ [session.id]: session, [shared.id]: shared }, {
                [machineId]: makeMachine({ id: machineId }),
            }, {
                groupInactiveSessionsByProject: false,
                inactiveGroupingV1: grouping,
                serverScope: { serverId },
                sessionTargetState: { sessions: { [session.id]: session, [shared.id]: shared } },
                sessionFolders: { enabled: false, folders: { v: 1, folders: [] }, assignmentsBySessionKey: {} },
            }).filter((item) => item.type === 'session');
        });
        expect(rows.map((row) => row.workspace)).toEqual([
            { t: 'workspaceScope', serverId: 'server-a', machineId: 'server-a-machine', rootPath: '/home/server-a/repo' },
            { t: 'workspaceScope', serverId: 'server-a', machineId: 'server-a-machine', rootPath: '/home/server-a/repo' },
            { t: 'workspaceScope', serverId: 'server-b', machineId: 'server-b-machine', rootPath: '/home/server-b/repo' },
            { t: 'workspaceScope', serverId: 'server-b', machineId: 'server-b-machine', rootPath: '/home/server-b/repo' },
        ]);
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
            'header:project:repoA',
            'session:active:active:no-path',
            'header:inactive:Inactive',
            'header:project:repoB',
            'session:b1:inactive:no-path',
            'header:project:repoA',
            'session:a2:inactive:no-path',
            'session:a1:inactive:no-path',
        ]);
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
            'header:project:repoA',
            'session:active:active:project:no-path',
            'session:inactive:inactive:project:no-path',
            'header:project:repoB',
            'session:other:inactive:project:no-path',
        ]);
    });

    it('uses section-agnostic project group keys for split activity sections', () => {
        const machine = makeMachine({ id: 'm1', metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' } });

        const sessions: Record<string, Session> = {
            active: makeSession({
                id: 'active',
                active: true,
                createdAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            inactive: makeSession({
                id: 'inactive',
                active: false,
                createdAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const data = buildSessionListViewData(sessions, { [machine.id]: machine }, {
            groupInactiveSessionsByProject: true,
            serverScope: { serverId: 'server-a', serverName: 'Server A' },
        });

        const projectGroupKeys = data
            .filter((item): item is Extract<typeof item, { type: 'header' }> =>
                item.type === 'header' && item.headerKind === 'project'
            )
            .map((item) => item.groupKey);

        expect(projectGroupKeys).toHaveLength(2);
        expect(projectGroupKeys[0]).toBe(projectGroupKeys[1]);
        expect(projectGroupKeys[0]).toMatch(/^server:server-a:project:/);
        expect(projectGroupKeys[0]).not.toContain(':active:');
        expect(projectGroupKeys[0]).not.toContain(':inactive:');
    });

    it('builds folder headers and assigned session rows from durable workspace refs', () => {
        const machine = makeMachine({
            id: 'm1',
            metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });

        const sessions: Record<string, Session> = {
            assigned: makeSession({
                id: 'assigned',
                active: true,
                createdAt: 2,
                updatedAt: 100,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            unassigned: makeSession({
                id: 'unassigned',
                active: true,
                createdAt: 1,
                updatedAt: 50,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const options = {
            groupInactiveSessionsByProject: true,
            serverScope: { serverId: 'server-a', serverName: 'Server A' },
            sessionFolders: {
                enabled: true,
                folders: {
                    v: 1 as const,
                    folders: [{
                        id: 'folder-a',
                        workspace: {
                            t: 'workspaceScope' as const,
                            serverId: 'server-a',
                            machineId: 'm1',
                            rootPath: '/home/u/repoA',
                        },
                        renderWorkspaceKey: 'old-render-key',
                        parentId: null,
                        name: 'Planning',
                        createdAt: 1,
                        updatedAt: 1,
                    }],
                },
                assignmentsBySessionKey: {
                    'server-a:assigned': 'folder-a',
                },
            },
        };

        const data = buildSessionListViewData(sessions, { [machine.id]: machine }, options);
        const summary = data.map((item) => {
            if (item.type === 'header') {
                return `header:${item.headerKind ?? 'unknown'}:${item.title}:${item.folderId ?? 'root'}:${item.depth ?? 0}`;
            }
            return `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.folderId ?? 'root'}:${item.folderDepth ?? 0}`;
        });

        expect(summary).toEqual([
            'header:active:Active:root:0',
            'header:project:repoA:root:0',
            'header:folder:Planning:folder-a:0',
            'session:assigned:folder:folder-a:1',
            'session:unassigned:project:root:0',
        ]);
        expect(data.find((item) => item.type === 'header' && item.headerKind === 'folder')).toMatchObject({
            workspace: {
                t: 'workspaceScope',
                serverId: 'server-a',
                machineId: 'm1',
                rootPath: '/home/u/repoA',
            },
            renderWorkspaceKey: expect.any(String),
        });
    });

    it('renders child folders before direct sessions inside a folder', () => {
        const machine = makeMachine({
            id: 'm1',
            metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });
        const workspace = {
            t: 'workspaceScope' as const,
            serverId: 'server-a',
            machineId: 'm1',
            rootPath: '/home/u/repoA',
        };
        const sessions: Record<string, Session> = {
            parentSession: makeSession({
                id: 'parent-session',
                active: true,
                createdAt: 2,
                updatedAt: 100,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            childSession: makeSession({
                id: 'child-session',
                active: true,
                createdAt: 1,
                updatedAt: 50,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const data = buildSessionListViewData(sessions, { [machine.id]: machine }, {
            groupInactiveSessionsByProject: true,
            serverScope: { serverId: 'server-a', serverName: 'Server A' },
            sessionFolders: {
                enabled: true,
                folders: {
                    v: 1 as const,
                    folders: [
                        {
                            id: 'parent-folder',
                            workspace,
                            parentId: null,
                            name: 'Parent',
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            id: 'child-folder',
                            workspace,
                            parentId: 'parent-folder',
                            name: 'Child',
                            createdAt: 2,
                            updatedAt: 2,
                        },
                    ],
                },
                assignmentsBySessionKey: {
                    'server-a:parent-session': 'parent-folder',
                    'server-a:child-session': 'child-folder',
                },
            },
        });

        expect(data.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}:${item.title}:${item.folderId ?? 'root'}:${item.depth ?? 0}`
            : `session:${item.session.id}:${item.folderId ?? 'root'}:${item.folderDepth ?? 0}`
        )).toEqual([
            'header:active:Active:root:0',
            'header:project:repoA:root:0',
            'header:folder:Parent:parent-folder:0',
            'header:folder:Child:child-folder:1',
            'session:child-session:child-folder:2',
            'session:parent-session:parent-folder:1',
        ]);
    });

    it('keeps workspace folder headers visible when the workspace has no visible sessions', () => {
        const workspace = {
            t: 'workspaceScope' as const,
            serverId: 'server-a',
            machineId: 'm1',
            rootPath: '/home/u/repoA',
        };

        const data = applySessionFoldersToSessionListViewData([
            { type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active' },
            {
                type: 'header',
                title: 'repoA',
                headerKind: 'project',
                groupKey: 'server:server-a:project:repoA',
                workspaceKey: 'repoA',
                workspaceScopeHint: workspace,
                serverId: 'server-a',
            },
            { type: 'header', title: 'Inactive', headerKind: 'inactive', groupKey: 'inactive' },
        ] as any, {
            enabled: true,
            folders: {
                v: 1,
                folders: [{
                    id: 'folder-a',
                    workspace,
                    renderWorkspaceKey: 'repoA',
                    parentId: null,
                    name: 'Planning',
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
            assignmentsBySessionKey: {},
        });

        expect(data.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}:${item.title}:${item.folderId ?? 'root'}:${item.depth ?? 0}`
            : `session:${item.session.id}`
        )).toEqual([
            'header:active:Active:root:0',
            'header:project:repoA:root:0',
            'header:folder:Planning:folder-a:0',
            'header:inactive:Inactive:root:0',
        ]);
    });

    it('derives folderized row section from collected session state instead of project group key', () => {
        const workspace = {
            t: 'workspaceScope' as const,
            serverId: 'server-a',
            machineId: 'm1',
            rootPath: '/home/u/repoA',
        };
        const staleGroupKey = 'server:server-a:active:project:repoA';
        const inactiveSession = buildSessionListRenderableFromSession(makeSession({
            id: 'inactive',
            active: false,
            createdAt: 1,
            metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
        }));

        const data = applySessionFoldersToSessionListViewData([
            {
                type: 'header',
                title: 'repoA',
                headerKind: 'project',
                groupKey: staleGroupKey,
                workspaceKey: 'repoA',
                workspaceScopeHint: workspace,
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: inactiveSession,
                groupKey: staleGroupKey,
                groupKind: 'project',
            },
        ] satisfies SessionListViewItem[], {
            enabled: true,
            folders: {
                v: 1,
                folders: [{
                    id: 'folder-a',
                    workspace,
                    renderWorkspaceKey: 'repoA',
                    parentId: null,
                    name: 'Planning',
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
            assignmentsBySessionKey: {
                'server-a:inactive': 'folder-a',
            },
        });

        const folderizedSession = data.find((item): item is Extract<SessionListViewItem, { type: 'session' }> =>
            item.type === 'session' && item.session.id === 'inactive'
        );
        expect(folderizedSession?.section).toBe('inactive');
    });

    it('stores the newest session id on project headers for contextual new-session seeding', () => {
        const machine = makeMachine({
            id: 'm1',
            metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });
        const sessions: Record<string, Session> = {
            older: makeSession({
                id: 'older',
                createdAt: 10,
                updatedAt: 100,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            newest: makeSession({
                id: 'newest',
                createdAt: 20,
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
            },
        );

        const projectHeader = data.find((item): item is Extract<typeof item, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'project',
        );
        expect(projectHeader?.seedSessionId).toBe('newest');
    });

    it('groups sessions by the canonical reachable machine target when metadata machine ids are stale', () => {
        const machineTarget = makeMachine({
            id: 'm-target',
            metadata: { host: 'target.local', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' },
        });

        const sessions: Record<string, Session> = {
            stale: makeSession({
                id: 'stale',
                createdAt: 2,
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
            } as any,
        );

        const projectHeaders = data.filter((item): item is Extract<typeof item, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'project',
        );

        expect(projectHeaders).toHaveLength(1);
        expect(projectHeaders[0]?.subtitle).toBe('target.local');
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
        expect(header?.title).toBe('repo');
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
                    meaningfulActivityAt: new Date(2026, 1, 16, 7, 0, 0).getTime(),
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
                'header:project:repoB',
                'session:act2:active:no-path',
                'header:project:repoA',
                'session:act1:active:no-path',
                'header:inactive:Inactive',
                'header:date:Yesterday',
                'session:in1:inactive:default',
            ]);
        } finally {
            vi.useRealTimers();
        }
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
                'header:project:own-active',
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
