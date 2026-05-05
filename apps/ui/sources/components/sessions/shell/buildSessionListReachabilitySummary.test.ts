import { describe, expect, it } from 'vitest';

import { buildSessionListReachabilitySummary } from './buildSessionListReachabilitySummary';

describe('buildSessionListReachabilitySummary', () => {
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
            workspaceSubtitle: '/repo-a',
            workspaceSubtitleEllipsizeMode: 'head',
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
            workspaceSubtitle: '/repo-only',
            workspaceSubtitleEllipsizeMode: 'head',
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
});
