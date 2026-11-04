import { describe, expect, it, vi } from 'vitest';

import {
    normalizeSessionListSectionModeV1,
    resolveSessionListLayoutApplicability,
    resolveSessionListLayoutPresentation,
    resolveSessionListLayoutChoice,
    resolveSessionListLayoutSettingsDelta,
    resolveSessionListSessionRowDragPolicy,
    projectSessionListIndexForLayout,
} from './sessionListLayout';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';

describe('session list layout projection', () => {
    it('retains custom Section bands while projecting only unfiled Sessions into Recent days', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'folder', title: 'Launch', folderId: 'launch', groupKey: 'section-launch' },
            { type: 'session', serverId: 'home-a', sessionId: 'filed', folderId: 'launch', groupKey: 'section-launch', groupKind: 'folder' },
            { type: 'header', headerKind: 'project', title: 'Project', groupKey: 'project-a' },
            { type: 'session', serverId: 'home-a', sessionId: 'unfiled', groupKey: 'project-a', groupKind: 'project' },
            { type: 'session', serverId: 'home-a', sessionId: 'root', folderId: null, groupKey: 'legacy-root', groupKind: 'folder' },
            { type: 'header', headerKind: 'folder', title: 'Empty', folderId: 'empty', groupKey: 'section-empty' },
        ];
        const projected = projectSessionListIndexForLayout({ source, choice: 'recent_activity', nowMs: 1_000_000,
            resolveSessionRow: (_serverId, sessionId) => ({ id: sessionId, active: true, createdAt: 100, meaningfulActivityAt: 200 } as SessionListRenderableSession) });
        expect(projected[0]).toBe(source[0]);
        expect(projected[1]).toBe(source[1]);
        expect(projected).toContain(source[5]);
        expect(projected.flatMap(item => item.type === 'session' && item.groupKind === 'date' ? [item.sessionId] : []).sort()).toEqual(['root', 'unfiled']);
    });
    it('projects missing current settings to Projects', () => {
        expect(normalizeSessionListSectionModeV1(undefined)).toBe('single');
        expect(resolveSessionListLayoutChoice({})).toBe('projects');
    });

    it('reads the scalar layout and writes only that preference', () => {
        expect(resolveSessionListLayoutChoice({ sessionListLayoutV1: 'recent_activity' })).toBe('recent_activity');
        expect(resolveSessionListLayoutSettingsDelta('projects')).toEqual({ sessionListLayoutV1: 'projects' });
        expect(resolveSessionListLayoutSettingsDelta('recent_activity')).toEqual({ sessionListLayoutV1: 'recent_activity' });
    });

    it('lets visit intent override Projects without writing the saved choice', () => {
        const saved = { sessionListLayoutV1: 'projects' } as const;
        expect(resolveSessionListLayoutChoice(saved, 'recent_activity')).toBe('recent_activity');
        expect(resolveSessionListLayoutChoice(saved, null)).toBe('projects');
        expect(saved.sessionListLayoutV1).toBe('projects');
    });

    it('keeps section placement available in both layouts with one flat Recent timeline', () => {
        expect(resolveSessionListLayoutPresentation('recent_activity', 'grouped')).toBe('flat-with-badge');
        expect(resolveSessionListLayoutApplicability({ choice: 'recent_activity', foldersFeatureEnabled: true }))
            .toEqual({ usesProjectGrouping: false, usesFolderTreePresentation: true, showsAdvancedSectionGrouping: false });
        expect(resolveSessionListLayoutApplicability({ choice: 'projects', foldersFeatureEnabled: true }))
            .toEqual({ usesProjectGrouping: true, usesFolderTreePresentation: true, showsAdvancedSectionGrouping: false });
    });

    it('advertises only drag operations the effective group policy can commit', () => {
        expect(resolveSessionListSessionRowDragPolicy({
            manualSessionOrderingEnabled: true,
            folderContainmentEnabled: false,
            item: { section: 'active', groupKind: 'date' },
            layoutV1: 'projects',
        })).toEqual({
            canReorderSiblings: false,
            canMoveBetweenFolders: false,
            canPutUnder: false,
            canDrag: false,
        });

        expect(resolveSessionListSessionRowDragPolicy({
            manualSessionOrderingEnabled: true,
            folderContainmentEnabled: true,
            item: { section: 'active', groupKind: 'date' },
            layoutV1: 'projects',
        })).toEqual({
            canReorderSiblings: false,
            canMoveBetweenFolders: true,
            canPutUnder: false,
            canDrag: true,
        });

        expect(resolveSessionListSessionRowDragPolicy({
            manualSessionOrderingEnabled: false,
            folderContainmentEnabled: false,
            item: { section: 'active', groupKind: 'project' },
            layoutV1: 'projects',
        })).toEqual({
            canReorderSiblings: false,
            canMoveBetweenFolders: false,
            canPutUnder: false,
            canDrag: false,
        });

        // Putting a Session under a lead is its own drag, available whatever the ordering or folders.
        expect(resolveSessionListSessionRowDragPolicy({
            manualSessionOrderingEnabled: false,
            folderContainmentEnabled: false,
            putUnderEnabled: true,
            item: { section: 'active', groupKind: 'project' },
            layoutV1: 'recent_activity',
        })).toEqual({
            canReorderSiblings: false,
            canMoveBetweenFolders: false,
            canPutUnder: true,
            canDrag: true,
        });
    });

    it('retains unresolved qualified members as one loading tail group and rehomes them after hydration', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 4, 17, 18, 0));
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 'home-a' },
            { type: 'session', sessionId: 'hydrated', serverId: 'home-a', section: 'active', groupKey: 'a', groupKind: 'project' },
            { type: 'session', sessionId: 'pending', serverId: 'home-b', section: 'active', groupKey: 'b', groupKind: 'project' },
        ];
        const hydratedRow = {
            id: 'hydrated',
            active: true,
            createdAt: 100,
            meaningfulActivityAt: new Date(2026, 4, 17, 8, 0).getTime(),
            metadata: null,
        } as SessionListRenderableSession;
        const pendingRow = {
            id: 'pending',
            active: true,
            createdAt: 200,
            meaningfulActivityAt: new Date(2026, 4, 17, 12, 0).getTime(),
            metadata: null,
        } as SessionListRenderableSession;

        const whileLoading = projectSessionListIndexForLayout({
            source,
            choice: 'recent_activity',
            resolveSessionRow: (serverId, sessionId) => (
                serverId === 'home-a' && sessionId === 'hydrated' ? hydratedRow : null
            ),
        });

        expect(whileLoading.map((item) => item.type === 'header'
            ? `header:${item.headerKind}`
            : item.type === 'session' ? `session:${item.serverId}:${item.sessionId}:${item.groupKind}` : `run:${item.serverId}:${item.runId}`,
        )).toEqual([
            'header:date',
            'session:home-a:hydrated:date',
            'header:loading',
            'session:home-b:pending:loading',
        ]);

        const afterHydration = projectSessionListIndexForLayout({
            source,
            choice: 'recent_activity',
            resolveSessionRow: (serverId, sessionId) => {
                if (serverId === 'home-a' && sessionId === 'hydrated') return hydratedRow;
                if (serverId === 'home-b' && sessionId === 'pending') return pendingRow;
                return null;
            },
        });

        expect(afterHydration.map((item) => item.type === 'header'
            ? `header:${item.headerKind}`
            : item.type === 'session' ? `session:${item.serverId}:${item.sessionId}:${item.groupKind}` : `run:${item.serverId}:${item.runId}`,
        )).toEqual([
            'header:date',
            'session:home-b:pending:date',
            'session:home-a:hydrated:date',
        ]);
        vi.useRealTimers();
    });

    it('keeps an unresolved qualified member visible under hidden-inactive rules', () => {
        const projected = projectSessionListIndexForLayout({
            source: [
                { type: 'session', sessionId: 'pending', serverId: 'home-b', groupKey: 'b', groupKind: 'project' },
            ],
            choice: 'recent_activity',
            resolveSessionRow: () => null,
        });

        expect(projected.filter((item) => item.type === 'session')).toEqual([
            expect.objectContaining({ sessionId: 'pending', serverId: 'home-b', section: 'active', groupKind: 'loading' }),
        ]);
    });

    it('builds one qualified cross-Home timeline without structural source headers', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 4, 17, 18, 0));
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'server', title: 'Home A', serverId: 'home-a' },
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 'home-a' },
            { type: 'header', headerKind: 'project', title: 'Repo A', serverId: 'home-a', groupKey: 'a-project' },
            { type: 'session', sessionId: 'same', serverId: 'home-a', section: 'active', groupKey: 'a-project', groupKind: 'project' },
            { type: 'header', headerKind: 'server', title: 'Home B', serverId: 'home-b' },
            { type: 'header', headerKind: 'project', title: 'Repo B', serverId: 'home-b', groupKey: 'b-project' },
            { type: 'session', sessionId: 'same', serverId: 'home-b', section: 'inactive', groupKey: 'b-project', groupKind: 'project' },
        ];
        const rows: Record<string, SessionListRenderableSession> = {
            'home-a:same': {
                id: 'same',
                active: true,
                createdAt: 100,
                meaningfulActivityAt: new Date(2026, 4, 17, 8, 0).getTime(),
                updatedAt: new Date(2026, 4, 17, 18, 0).getTime(),
                metadata: null,
            } as SessionListRenderableSession,
            'home-b:same': {
                id: 'same',
                active: false,
                createdAt: 200,
                meaningfulActivityAt: new Date(2026, 4, 17, 12, 0).getTime(),
                updatedAt: new Date(2026, 4, 16, 18, 0).getTime(),
                metadata: null,
            } as SessionListRenderableSession,
        };

        const projected = projectSessionListIndexForLayout({
            source,
            choice: 'recent_activity',
            resolveSessionRow: (serverId, sessionId) => rows[`${serverId}:${sessionId}`] ?? null,
        });

        expect(projected.map((item) => item.type === 'header'
            ? `header:${item.headerKind}:${item.title}`
            : item.type === 'session' ? `session:${item.serverId}:${item.sessionId}:${item.groupKind}` : `run:${item.serverId}:${item.runId}`,
        )).toEqual([
            'header:date:Today',
            'session:home-b:same:date',
            'session:home-a:same:date',
        ]);
        vi.useRealTimers();
    });
});
