import { describe, expect, it } from 'vitest';

import { buildSessionListRowViewModels } from './sessionListRowViewModels';

describe('buildSessionListRowViewModels', () => {
    it('reuses a shared empty array when there are no visible list items', () => {
        const first = buildSessionListRowViewModels({
            listItems: [],
            reachableSessionDisplayById: new Map(),
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set<string>(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: true,
            showPinnedServerBadge: false,
        });
        const second = buildSessionListRowViewModels({
            listItems: [],
            reachableSessionDisplayById: new Map(),
            hasMultipleMachines: true,
            pinnedSessionKeys: new Set<string>(),
            sessionTags: {},
            selectedSessionId: 'sess_a',
            showServerBadge: false,
            showPinnedServerBadge: true,
        });

        expect(first).toBe(second);
        expect(first).toHaveLength(0);
    });

    it('reuses the same row view model array for identical non-empty inputs', () => {
        const input = {
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess_a',
                    groupKey: 'group:day',
                    groupKind: 'date',
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
                {
                    type: 'session',
                    sessionId: 'sess_b',
                    groupKey: 'group:day',
                    groupKind: 'date',
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            reachableSessionDisplayById: new Map([
                ['sess_a', { machineId: 'machine_a', machineLabel: 'Machine A', pathSubtitle: '/repo-a' }],
                ['sess_b', { machineId: 'machine_b', machineLabel: 'Machine B', pathSubtitle: '/repo-b' }],
            ]),
            hasMultipleMachines: true,
            pinnedSessionKeys: new Set(['server_a:sess_a']),
            sessionTags: {
                'server_a:sess_a': ['important'],
            } satisfies Record<string, string[]>,
            selectedSessionId: 'sess_b',
            showServerBadge: true,
            showPinnedServerBadge: false,
        } as const;

        const first = buildSessionListRowViewModels(input);
        const second = buildSessionListRowViewModels(input);

        expect(first).toStrictEqual(second);
        expect(first).toMatchObject([
            {
                groupKey: 'group:day',
                sessionKey: 'server_a:sess_a',
                isFirst: true,
                isLast: false,
                isSingle: false,
                subtitleOverride: 'Machine A · /repo-a',
                pinned: true,
                showServerBadge: false,
                selected: false,
                tags: ['important'],
                secondaryLineMode: 'path',
            },
            {
                groupKey: 'group:day',
                sessionKey: 'server_a:sess_b',
                isFirst: false,
                isLast: true,
                isSingle: false,
                subtitleOverride: 'Machine B · /repo-b',
                pinned: false,
                showServerBadge: true,
                selected: true,
                tags: [],
                secondaryLineMode: 'path',
            },
        ]);
    });

    it('derives adjacency, pin, tags, and server badge state for visible rows', () => {
        const result = buildSessionListRowViewModels({
            listItems: [
                {
                    type: 'header',
                    title: 'Today',
                    headerKind: 'date',
                    groupKey: 'group:day',
                },
                {
                    type: 'session',
                    sessionId: 'sess_a',
                    groupKey: 'group:day',
                    groupKind: 'date',
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
                {
                    type: 'session',
                    sessionId: 'sess_b',
                    groupKey: 'group:day',
                    groupKind: 'date',
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            reachableSessionDisplayById: new Map([
                ['sess_a', { machineId: 'machine_a', machineLabel: 'Machine A', pathSubtitle: '/repo-a' }],
                ['sess_b', { machineId: 'machine_b', machineLabel: 'Machine B', pathSubtitle: '/repo-b' }],
            ]),
            hasMultipleMachines: true,
            pinnedSessionKeys: new Set(['server_a:sess_a']),
            sessionTags: {
                'server_a:sess_a': ['important'],
            },
            selectedSessionId: 'sess_b',
            showServerBadge: true,
            showPinnedServerBadge: false,
        });

        expect(result[0]).toBeNull();
        expect(result[1]).toMatchObject({
            groupKey: 'group:day',
            sessionKey: 'server_a:sess_a',
            isFirst: true,
            isLast: false,
            isSingle: false,
            subtitleOverride: 'Machine A · /repo-a',
            pinned: true,
            showServerBadge: false,
            selected: false,
            tags: ['important'],
            secondaryLineMode: 'path',
        });
        expect(result[2]).toMatchObject({
            sessionKey: 'server_a:sess_b',
            isFirst: false,
            isLast: true,
            isSingle: false,
            subtitleOverride: 'Machine B · /repo-b',
            pinned: false,
            showServerBadge: true,
            selected: true,
            tags: [],
            secondaryLineMode: 'path',
        });
    });

    it('hides path subtitles for project no-path rows and keeps status mode', () => {
        const result = buildSessionListRowViewModels({
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess_project',
                    groupKey: 'group:project',
                    groupKind: 'project',
                    variant: 'no-path',
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            reachableSessionDisplayById: new Map([
                ['sess_project', { machineId: 'machine_a', machineLabel: 'Machine A', pathSubtitle: '/repo-a' }],
            ]),
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set<string>(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: true,
            showPinnedServerBadge: true,
        });

        expect(result[0]).toMatchObject({
            isFirst: true,
            isLast: true,
            isSingle: true,
            subtitleOverride: null,
            secondaryLineMode: 'status',
        });
    });
});
