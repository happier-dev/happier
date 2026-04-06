import { describe, expect, it } from 'vitest';

import {
    getAllKnownTags,
    getTagsForSession,
    resolveSessionItemTagCollections,
    setTagsForSession,
    toggleTagForSession,
} from './sessionTagUtils';

describe('sessionTagUtils', () => {
    it('reuses a shared empty tag array for missing sessions', () => {
        const first = getTagsForSession(undefined, 'server_a:sess_a');
        const second = getTagsForSession(null, 'server_a:sess_a');

        expect(first).toBe(second);
        expect(first).toEqual([]);
    });

    it('reuses a shared empty tag list when no tags are known', () => {
        const first = getAllKnownTags(undefined);
        const second = getAllKnownTags({});

        expect(first).toBe(second);
        expect(first).toEqual([]);
    });

    it('reuses the same known-tag array for identical non-empty tag maps', () => {
        const first = getAllKnownTags({
            'server_a:sess_a': ['important', 'review'],
            'server_a:sess_b': ['review', 'blocked'],
        });
        const second = getAllKnownTags({
            'server_a:sess_a': ['important', 'review'],
            'server_a:sess_b': ['review', 'blocked'],
        });

        expect(first).toStrictEqual(second);
        expect(first).toEqual(['blocked', 'important', 'review']);
    });

    it('reuses the shared empty tag collections for absent session item inputs', () => {
        const first = resolveSessionItemTagCollections({});
        const second = resolveSessionItemTagCollections({ tags: undefined, allKnownTags: undefined });

        expect(first).toBe(second);
        expect(first.activeTags).toBe(first.knownTags);
        expect(first.activeTags).toEqual([]);
        expect(second.activeTags).toBe(second.knownTags);
    });

    it('returns the previous session tag map when the requested tags are unchanged', () => {
        const prev = {
            'server_a:sess_a': ['important'],
        };

        expect(setTagsForSession(prev, 'server_a:sess_a', ['important'])).toBe(prev);
    });

    it('keeps the previous session tag map when clearing a missing tag entry', () => {
        const prev = {
            'server_a:sess_a': ['important'],
        };

        expect(setTagsForSession(prev, 'server_a:sess_b', [])).toBe(prev);
    });

    it('toggles tags while preserving canonical session tag map behavior', () => {
        const prev = {
            'server_a:sess_a': ['important'],
        };

        expect(toggleTagForSession(prev, 'server_a:sess_a', 'important')).toEqual({});
        expect(toggleTagForSession({}, 'server_a:sess_a', 'important')).toEqual({
            'server_a:sess_a': ['important'],
        });
    });
});
