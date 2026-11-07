import { describe, expect, it } from 'vitest';

import { buildOrderMapAfterMove } from './orderMapUpdate';

describe('buildOrderMapAfterMove', () => {
    it('preserves the same session in independent groups when reordering pins', () => {
        const result = buildOrderMapAfterMove({
            currentMap: { 'pinned-v1': ['s:a', 's:b'], project: ['s:a', 's:b'] },
            scopeKey: 'pinned-v1', movedKey: 's:b', directKeys: ['s:a', 's:b'], beforeKey: 's:a', maxKeys: 100,
        });
        expect(result).toEqual({ 'pinned-v1': ['s:b', 's:a'], project: ['s:a', 's:b'] });
    });

    it('removes a moved session from its source group while preserving its pin order', () => {
        const result = buildOrderMapAfterMove({
            currentMap: { 'pinned-v1': ['s:b', 's:a'], from: ['s:a', 's:b'], to: ['s:c'] },
            scopeKey: 'to', sourceScopeKey: 'from', movedKey: 's:b', directKeys: ['s:c'], afterKey: 's:c', maxKeys: 100,
        });
        expect(result).toEqual({ 'pinned-v1': ['s:b', 's:a'], from: ['s:a'], to: ['s:c', 's:b'] });
    });

    it('emits an empty source group when its last session moves away', () => {
        expect(buildOrderMapAfterMove({
            currentMap: { from: ['s:b'], to: ['s:c'] }, scopeKey: 'to', sourceScopeKey: 'from',
            movedKey: 's:b', directKeys: ['s:c'], afterKey: 's:c', maxKeys: 100,
        })).toEqual({ from: [], to: ['s:c', 's:b'] });
    });

    it('keeps the latest current-map order as the baseline and appends newly visible keys after it', () => {
        // Contract per plan sections 1.5/3.5: the latest current map carries the
        // user's most recent intent (including background reorders) and is the
        // baseline. Newly visible direct keys not yet in the current map are
        // appended after it; direct keys must never reorder current-map entries.
        const result = buildOrderMapAfterMove({
            currentMap: {
                project: ['server-a:older-b', 'server-a:older-a'],
            },
            scopeKey: 'project',
            movedKey: 'server-a:older-a',
            directKeys: ['server-a:new-session', 'server-a:older-b', 'server-a:older-a'],
            afterKey: 'server-a:older-b',
            maxKeys: 100,
        });

        expect(result).toEqual({
            project: ['server-a:older-b', 'server-a:older-a', 'server-a:new-session'],
        });
    });

    it('does not let stale direct-key order bias the current-map order of unrelated keys', () => {
        // The current map orders root-b before root-a; a stale tree snapshot that
        // lists them root-a before root-b must not flip that order on commit.
        const result = buildOrderMapAfterMove({
            currentMap: {
                project: ['server-a:root-b', 'server-a:root-a'],
            },
            scopeKey: 'project',
            movedKey: 'server-a:inside-a',
            directKeys: ['server-a:root-a', 'server-a:root-b', 'server-a:inside-a'],
            afterKey: 'server-a:root-a',
            maxKeys: 100,
        });

        expect(result).toEqual({
            project: ['server-a:root-b', 'server-a:root-a', 'server-a:inside-a'],
        });
    });
});
