import { describe, expect, it } from 'vitest';

import {
    areSessionListIndexItemsEqual,
    buildSessionListIndexFromViewData,
    buildSessionListIndexItemFromViewItem,
    type SessionListIndexItem,
} from './sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { buildSessionListViewData, type SessionListViewItem } from './sessionListViewData';
import { buildSessionListViewDataFromIndex } from './sessionListViewDataFromIndex';

function makeRenderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
    };
}

function makeSource(): SessionListViewItem[] {
    return [
        {
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            groupKey: 'server:server-a:day:2026-05-04',
            serverId: 'server-a',
        },
        {
            type: 'session',
            session: makeRenderable('a'),
            section: 'inactive',
            groupKey: 'server:server-a:day:2026-05-04',
            groupKind: 'date',
            serverId: 'server-a',
        },
        {
            type: 'session',
            session: makeRenderable('b'),
            section: 'inactive',
            groupKey: 'server:server-a:day:2026-05-04',
            groupKind: 'date',
            serverId: 'server-a',
        },
    ];
}

describe('buildSessionListViewDataFromIndex', () => {
    it('preserves both APP headings through projection with 29 active sessions and an inactive group', () => {
        const sessions = [
            ...Array.from({ length: 29 }, (_, index) => ({ id: `active-${index}`, active: true, folder: 'APP' })),
            { id: 'inactive', active: false, folder: 'APP' },
            { id: 'dmux', active: true, folder: 'dmux' },
            { id: 'bitwarden-1', active: true, folder: 'Bitwarden' },
            { id: 'bitwarden-2', active: true, folder: 'Bitwarden' },
        ].map(({ id, active, folder }, index) => ({
            ...makeRenderable(id),
            active,
            createdAt: index,
            metadata: { machineId: 'machine-a', path: `/srv/projects/TEAM/${folder}`, host: 'host-a', version: '0.0.0' },
        }));
        const source = buildSessionListViewData(Object.fromEntries(sessions.map((session) => [session.id, session])), {}, {
            groupInactiveSessionsByProject: true,
            serverScope: { serverId: 'server-a' },
        });
        const sourceIndex = buildSessionListIndexFromViewData(source)!;
        // A computed index (e.g. after pinning/ordering) takes the rehydration path.
        const index = sourceIndex.map((item) => ({ ...item }));
        const result = buildSessionListViewDataFromIndex({ index, source, sourceIndex });
        const headers = (result ?? []).filter((item): item is Extract<SessionListViewItem, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'project'
        );

        expect(headers.filter((item) => item.title === 'APP').map((item) => item.section)).toEqual(['active', 'inactive']);
        expect(headers.map((item) => item.title)).toEqual(['Bitwarden', 'dmux', 'APP', 'APP']);
        expect(result?.filter((item) => item.type === 'session' && item.section === 'active' && item.session.metadata?.path?.endsWith('/APP'))).toHaveLength(29);
        // The same lookup is used on subsequent store pushes; unchanged rows must keep their own section.
        const next = buildSessionListViewDataFromIndex({ index, source, sourceIndex, previous: result });
        expect(next).toBe(result);
    });

    it('preserves the source view-data reference when the computed index is unchanged', () => {
        const source = makeSource();
        const sourceIndex = buildSessionListIndexFromViewData(source);

        const result = buildSessionListViewDataFromIndex({
            index: sourceIndex,
            source,
            sourceIndex,
        });

        expect(result).toBe(source);
    });

    it('reuses source session rows when the index only normalizes omitted keep-visible flags to false', () => {
        const source = makeSource();
        const sessionItem = source[1];
        expect(sessionItem?.type).toBe('session');
        if (sessionItem?.type !== 'session') return;
        const sessionWithoutFalseFlag = {
            ...sessionItem,
            session: {
                ...sessionItem.session,
                keepVisibleWhenInactive: undefined,
            },
        };
        const normalizedSource = [
            source[0]!,
            sessionWithoutFalseFlag,
            source[2]!,
        ];
        const sourceIndex = buildSessionListIndexFromViewData(normalizedSource);
        expect(sourceIndex).not.toBeNull();
        const typedSourceIndex = sourceIndex as SessionListIndexItem[];
        const computedIndex: SessionListIndexItem[] = typedSourceIndex.map((item) => ({ ...item }));

        const result = buildSessionListViewDataFromIndex({
            index: computedIndex,
            source: normalizedSource,
            sourceIndex: typedSourceIndex,
        });

        expect(result?.[1]).toBe(sessionWithoutFalseFlag);
        expect(result?.[1]?.type === 'session' ? result[1].session : null).toBe(sessionWithoutFalseFlag.session);
    });

    it('rehydrates synthetic headers and projected session fields from a computed index', () => {
        const source = makeSource();
        const sourceIndex = buildSessionListIndexFromViewData(source);
        expect(sourceIndex).not.toBeNull();
        const typedSourceIndex = sourceIndex as SessionListIndexItem[];
        const pinnedSession = typedSourceIndex[2] as Extract<SessionListIndexItem, { type: 'session' }>;
        const computedIndex: SessionListIndexItem[] = [
            { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: 'pinned-v1' },
            {
                ...pinnedSession,
                pinned: true,
                groupKey: 'pinned-v1',
                groupKind: 'pinned',
                variant: 'default',
            },
            typedSourceIndex[0]!,
            typedSourceIndex[1]!,
        ];

        const result = buildSessionListViewDataFromIndex({
            index: computedIndex,
            source,
            sourceIndex: typedSourceIndex,
        });

        expect(result?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}:${item.title}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.pinned === true ? 'pinned' : 'unpinned'}`
        )).toEqual([
            'header:pinned:Pinned',
            'session:b:pinned:pinned',
            'header:date:Today',
            'session:a:date:unpinned',
        ]);
        expect(result?.[2]).toBe(source[0]);
        expect(result?.[3]).toBe(source[1]);
    });

    it('preserves index meaning through reordered folder rows and machine-backed headers', () => {
        const workspace = {
            t: 'workspaceScope' as const,
            serverId: 'server-a',
            machineId: 'machine-a',
            rootPath: '/repo',
        };
        const machine = {
            id: 'machine-a',
            updatedAt: 10,
            active: true,
            activeAt: 10,
            revokedAt: null,
            metadataVersion: 1,
            metadata: { displayName: 'Build host', host: 'host-a', homeDir: '/home/a' },
        };
        const source: SessionListViewItem[] = [
            {
                type: 'header',
                title: 'Workspace',
                headerKind: 'folder',
                groupKey: 'folder:server-a:workspace-a:folder-a',
                workspaceKey: 'workspace-a',
                folderId: 'folder-a',
                depth: 1,
                workspace,
                machine,
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderable('a'),
                section: 'inactive',
                groupKey: 'folder:server-a:workspace-a:folder-a',
                groupKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 2,
                workspace,
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderable('b'),
                section: 'inactive',
                groupKey: 'folder:server-a:workspace-a:folder-a',
                groupKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 2,
                workspace,
                serverId: 'server-a',
            },
        ];
        const sourceIndex = buildSessionListIndexFromViewData(source) as SessionListIndexItem[];
        const header = sourceIndex[0] as Extract<SessionListIndexItem, { type: 'header' }>;
        const computedIndex: SessionListIndexItem[] = [
            { ...header, machine: { ...machine, activeAt: 20 } },
            sourceIndex[2]!,
            sourceIndex[1]!,
        ];

        const result = buildSessionListViewDataFromIndex({
            index: computedIndex,
            source,
            sourceIndex,
        });

        expect(result?.map((item) => item.type === 'header' ? `header:${item.machine?.activeAt}` : item.session.id))
            .toEqual(['header:20', 'b', 'a']);
        expect(result?.every((item, index) => areSessionListIndexItemsEqual(
            buildSessionListIndexItemFromViewItem(item),
            computedIndex[index],
        ))).toBe(true);
    });

    describe('previous-row identity', () => {
        function buildPinnedProjection(source: ReadonlyArray<SessionListViewItem>) {
            const sourceIndex = buildSessionListIndexFromViewData(source) as SessionListIndexItem[];
            const pinnedSession = sourceIndex[2] as Extract<SessionListIndexItem, { type: 'session' }>;
            const index: SessionListIndexItem[] = [
                { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: 'pinned-v1' },
                { ...pinnedSession, pinned: true, groupKey: 'pinned-v1', groupKind: 'pinned' },
                sourceIndex[0]!,
                sourceIndex[1]!,
            ];
            return { index, sourceIndex };
        }

        it('returns the previous view data when every rebuilt row is field-identical', () => {
            const source = makeSource();
            const first = buildPinnedProjection(source);
            const previous = buildSessionListViewDataFromIndex({
                index: first.index,
                source,
                sourceIndex: first.sourceIndex,
            });
            expect(previous).not.toBeNull();

            // A store push that replaces the row objects but keeps every session payload.
            const nextSource = source.map((item) => ({ ...item }));
            const second = buildPinnedProjection(nextSource);
            const result = buildSessionListViewDataFromIndex({
                index: second.index,
                source: nextSource,
                sourceIndex: second.sourceIndex,
                previous,
            });

            expect(result).toBe(previous);
        });

        it('replaces only the changed row and keeps the other previous row objects', () => {
            const source = makeSource();
            const first = buildPinnedProjection(source);
            const previous = buildSessionListViewDataFromIndex({
                index: first.index,
                source,
                sourceIndex: first.sourceIndex,
            }) as SessionListViewItem[];

            const changedRow = source[1] as Extract<SessionListViewItem, { type: 'session' }>;
            const nextSource: SessionListViewItem[] = [
                source[0]!,
                { ...changedRow, session: { ...changedRow.session, seq: 42 } },
                source[2]!,
            ];
            const second = buildPinnedProjection(nextSource);
            const result = buildSessionListViewDataFromIndex({
                index: second.index,
                source: nextSource,
                sourceIndex: second.sourceIndex,
                previous,
            });

            expect(result).not.toBe(previous);
            expect(result?.[0]).toBe(previous[0]);
            expect(result?.[1]).toBe(previous[1]);
            expect(result?.[2]).toBe(previous[2]);
            expect(result?.[3]).not.toBe(previous[3]);
            expect(result?.[3]?.type === 'session' ? result[3].session.seq : null).toBe(42);
        });

        it('rebuilds a header row whose count changed even though its placement is unchanged', () => {
            const source: SessionListViewItem[] = [
                { ...(makeSource()[0] as Extract<SessionListViewItem, { type: 'header' }>), sessionCount: 2 },
                makeSource()[1]!,
                makeSource()[2]!,
            ];
            const first = buildPinnedProjection(source);
            const previous = buildSessionListViewDataFromIndex({
                index: first.index,
                source,
                sourceIndex: first.sourceIndex,
            }) as SessionListViewItem[];

            const nextSource: SessionListViewItem[] = [
                { ...(source[0] as Extract<SessionListViewItem, { type: 'header' }>), sessionCount: 3 },
                source[1]!,
                source[2]!,
            ];
            const second = buildPinnedProjection(nextSource);
            const result = buildSessionListViewDataFromIndex({
                index: second.index,
                source: nextSource,
                sourceIndex: second.sourceIndex,
                previous,
            });

            expect(result).not.toBe(previous);
            expect(result?.[2]).not.toBe(previous[2]);
            expect(result?.[2]?.type === 'header' ? result[2].sessionCount : null).toBe(3);
        });
    });
});
