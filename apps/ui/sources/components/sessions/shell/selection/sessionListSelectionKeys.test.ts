import { describe, expect, it } from 'vitest';

import { buildVisibleSessionNavigationEntries } from '@/keyboard/sessions';

import {
    buildSessionListSelectionKey,
    buildSessionListSelectionScopeKey,
    readSessionListSelectionKeysFromVisibleEntries,
} from './sessionListSelectionKeys';

describe('sessionListSelectionKeys', () => {
    it('uses server-scoped session keys so duplicate session ids do not collide', () => {
        expect(buildSessionListSelectionKey({ sessionId: 'alpha', serverId: 'server-a' })).toBe('server-a:alpha');
        expect(buildSessionListSelectionKey({ sessionId: 'alpha', serverId: 'server-b' })).toBe('server-b:alpha');
        expect(buildSessionListSelectionKey({ sessionId: 'alpha', serverId: null })).toBe('alpha');
    });

    it('reads visible selection keys from session-only navigation entries', () => {
        const visibleEntries = buildVisibleSessionNavigationEntries([
            { type: 'header' },
            { type: 'session', serverId: 'server-a', session: { id: 'alpha' } },
            { type: 'header' },
            { type: 'session', serverId: 'server-a', session: { id: 'beta' } },
        ]);

        expect(readSessionListSelectionKeysFromVisibleEntries(visibleEntries)).toEqual([
            'server-a:alpha',
            'server-a:beta',
        ]);
    });

    it('builds a stable explicit scope key from filters without depending on tag order', () => {
        const left = buildSessionListSelectionScopeKey({
            storageKind: 'all',
            activeServerId: 'server-a',
            focusedFolderId: 'folder-a',
            searchQuery: '  Planning  ',
            selectedTags: ['work', 'urgent'],
            hideInactiveSessions: true,
        });
        const right = buildSessionListSelectionScopeKey({
            storageKind: 'all',
            activeServerId: 'server-a',
            focusedFolderId: 'folder-a',
            searchQuery: 'Planning',
            selectedTags: ['urgent', 'work'],
            hideInactiveSessions: true,
        });

        expect(left).toBe(right);
        expect(left).toContain('folder-a');
        expect(left).toContain('planning');
    });
});
