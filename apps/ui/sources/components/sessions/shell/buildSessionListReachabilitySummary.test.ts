import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildSessionListReachabilitySummary,
    createSessionListReachabilitySummaryCache,
} from './buildSessionListReachabilitySummary';

const getStateSpy = vi.fn();

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => getStateSpy(),
        },
    });
});

describe('buildSessionListReachabilitySummary', () => {
    beforeEach(() => {
        getStateSpy.mockReset();
        getStateSpy.mockReturnValue({});
    });

    it('reuses a shared empty summary when there are no session rows', () => {
        const first = buildSessionListReachabilitySummary({
            listItems: [],
            machinesById: new Map(),
            workspaceRefs: [],
            resolveSessionRenderable: () => null,
        });
        const second = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'header',
                    title: 'Today',
                    headerKind: 'date',
                    groupKey: 'server:server-a:day:2026-02-19',
                },
            ] as any,
            machinesById: new Map(),
            workspaceRefs: [],
            resolveSessionRenderable: () => null,
        });

        expect(first).toBe(second);
        expect(first.displayById).toBe(second.displayById);
        expect(first.displayById.size).toBe(0);
        expect(first.hasMultipleMachines).toBe(false);
    });

    it('reuses the same non-empty summary for identical inputs', () => {
        const sessionRenderablesById = {
            'sess-a': {
                metadata: {
                    machineId: 'machine-a',
                    host: 'machine-a.local',
                    path: '/repo-a',
                    homeDir: '/home/user',
                },
            },
            'sess-b': {
                metadata: {
                    machineId: 'machine-b',
                    host: 'machine-b.local',
                    path: '/repo-b',
                    homeDir: '/home/user',
                },
            },
        } as any;
        const input = {
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess-a',
                },
                {
                    type: 'session',
                    sessionId: 'sess-b',
                },
            ] as any,
            machinesById: new Map([
                ['machine-a', { id: 'machine-a', metadata: { host: 'machine-a.local' } }],
                ['machine-b', { id: 'machine-b', metadata: { host: 'machine-b.local' } }],
            ]),
            workspaceRefs: [],
            resolveSessionRenderable: (item: any) => sessionRenderablesById[item.sessionId] ?? null,
        } as const;

        const first = buildSessionListReachabilitySummary(input);
        const second = buildSessionListReachabilitySummary(input);

        expect(first).toBe(second);
        expect(first.hasMultipleMachines).toBe(true);
        expect(first.displayById.get('sess-a')).toEqual({
            machineId: 'machine-a',
            machineLabel: 'machine-a.local',
            workspaceSubtitle: 'repo-a',
            workspaceSubtitleEllipsizeMode: 'tail',
        });
    });

    it('reuses cached display rows when unrelated session rows refresh', () => {
        const renderablesById = {
            'sess-unchanged': {
                metadata: {
                    machineId: 'machine-a',
                    host: 'machine-a.local',
                    path: '/repo-unchanged',
                    homeDir: '/home/user',
                },
            },
            'sess-refreshed': {
                metadata: {
                    machineId: 'machine-a',
                    host: 'machine-a.local',
                    path: '/repo-refreshed',
                    homeDir: '/home/user',
                },
            },
        } as any;
        const machinesById = new Map([
            ['machine-a', { id: 'machine-a', metadata: { host: 'machine-a.local' } }],
        ]);
        const listItems = [
            {
                type: 'session',
                sessionId: 'sess-unchanged',
                serverId: 'server-a',
            },
            {
                type: 'session',
                sessionId: 'sess-refreshed',
                serverId: 'server-a',
            },
        ] as any;
        const workspaceRefs: ReadonlyArray<never> = [];
        const cache = createSessionListReachabilitySummaryCache();
        const first = buildSessionListReachabilitySummary({
            cache,
            listItems,
            machinesById,
            workspaceRefs,
            resolveSessionRenderable: (item: any) => renderablesById[item.sessionId] ?? null,
        });
        const unchangedDisplay = first.displayByKey.get('server-a:sess-unchanged');
        const second = buildSessionListReachabilitySummary({
            cache,
            listItems,
            machinesById,
            workspaceRefs,
            resolveSessionRenderable: (item: any) => item.sessionId === 'sess-refreshed'
                ? { ...renderablesById['sess-refreshed'], presence: 1 }
                : renderablesById[item.sessionId] ?? null,
        });

        expect(second).not.toBe(first);
        expect(second.displayByKey.get('server-a:sess-unchanged')).toBe(unchangedDisplay);
        expect(second.displayByKey.get('server-a:sess-refreshed')).toMatchObject({
            machineId: 'machine-a',
            workspaceSubtitle: 'repo-refreshed',
        });
    });

    it('preserves path subtitles even when no machine metadata is available', () => {
        const sessionRenderablesById = {
            'sess-path-only': {
                metadata: {
                    path: '/repo-only',
                    homeDir: '/home/user',
                },
            },
        } as any;
        const summary = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess-path-only',
                },
            ] as any,
            machinesById: new Map(),
            workspaceRefs: [],
            resolveSessionRenderable: (item: any) => sessionRenderablesById[item.sessionId] ?? null,
        });

        expect(summary.displayById.get('sess-path-only')).toEqual({
            machineId: null,
            machineLabel: '',
            workspaceSubtitle: 'repo-only',
            workspaceSubtitleEllipsizeMode: 'tail',
        });
        expect(summary.hasMultipleMachines).toBe(false);
    });

    it('uses renamed workspace refs for date-grouped row subtitles', () => {
        const sessionRenderablesById = {
            'sess-renamed': {
                metadata: {
                    machineId: 'machine-stale',
                    host: 'stale.local',
                    path: '/home/user/stale-repo',
                    homeDir: '/home/user',
                },
            },
        } as any;
        const summary = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess-renamed',
                    serverId: 'server-a',
                    groupKind: 'date',
                },
            ] as any,
            machinesById: new Map(),
            workspaceRefs: [
                {
                    id: 'workspace-ref-renamed',
                    serverId: 'server-a',
                    machineId: 'machine-stale',
                    rootPath: '/home/user/stale-repo',
                    label: 'Renamed Workspace',
                    createdAtMs: 1,
                    lastOpenedAtMs: null,
                },
            ],
            resolveSessionRenderable: (item: any) => sessionRenderablesById[item.sessionId] ?? null,
        });

        expect(summary.displayById.get('sess-renamed')).toEqual({
            machineId: 'machine-stale',
            machineLabel: 'stale.local',
            workspaceSubtitle: 'Renamed Workspace',
            workspaceSubtitleEllipsizeMode: 'tail',
        });
    });

    it('uses stable display attribution instead of live RPC reachability for row summaries', () => {
        getStateSpy.mockReturnValue({
            sessions: {
                'sess-replaced': {
                    active: false,
                    metadata: {
                        machineId: 'machine-old',
                        host: 'old.local',
                        path: '/home/user/repo',
                        homeDir: '/home/user',
                    },
                },
            },
            machines: {
                'machine-old': {
                    id: 'machine-old',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'machine-current',
                    replacedAt: 2,
                    metadata: { host: 'old.local', homeDir: '/home/user' },
                },
                'machine-current': {
                    id: 'machine-current',
                    active: false,
                    activeAt: 3,
                    metadata: { displayName: 'Current machine', host: 'current.local', homeDir: '/home/user' },
                },
            },
            getProjectForSession: () => null,
        });

        const summary = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess-replaced',
                    serverId: 'server-a',
                },
            ] as any,
            machinesById: new Map([
                ['machine-old', { id: 'machine-old', metadata: { host: 'old.local' } }],
                ['machine-current', { id: 'machine-current', metadata: { displayName: 'Current machine', host: 'current.local' } }],
            ]),
            workspaceRefs: [],
            resolveSessionRenderable: () => ({
                metadata: {
                    machineId: 'machine-old',
                    host: 'old.local',
                    path: '/home/user/repo',
                    homeDir: '/home/user',
                },
            }) as any,
        });

        expect(summary.displayById.get('sess-replaced')).toEqual({
            machineId: 'machine-current',
            machineLabel: 'Current machine',
            workspaceSubtitle: 'repo',
            workspaceSubtitleEllipsizeMode: 'tail',
        });
    });
});
