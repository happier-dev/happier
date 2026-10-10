import { describe, expect, it } from 'vitest';

import { resolvePluginsCollectionState } from './pluginsCollectionState';

const base = {
    noTarget: false,
    noticeReason: null,
    listRead: true,
    itemCount: 3,
    visibleCount: 3,
    filtering: false,
} as const;

describe('what the Plugins collection shows', () => {
    it('asks for a machine before anything else', () => {
        expect(resolvePluginsCollectionState({ ...base, noTarget: true, listRead: false, itemCount: 0, visibleCount: 0 })).toBe('noTarget');
    });

    it('holds the layout with a skeleton only while the machine has not answered yet', () => {
        expect(resolvePluginsCollectionState({ ...base, listRead: false, itemCount: 0, visibleCount: 0 })).toBe('loading');
        expect(resolvePluginsCollectionState({ ...base, noticeReason: 'refreshing', listRead: false, itemCount: 0, visibleCount: 0 })).toBe('loading');
    });

    it('never keeps loading once the read failed: it says so, with Retry', () => {
        for (const reason of ['installationUnavailable', 'projectionUnavailable'] as const) {
            expect(resolvePluginsCollectionState({ ...base, noticeReason: reason, listRead: false, itemCount: 0, visibleCount: 0 })).toBe('readFailed');
        }
    });

    it('keeps last-known plugins when the read failed or the machine is offline', () => {
        expect(resolvePluginsCollectionState({ ...base, noticeReason: 'installationUnavailable', listRead: false })).toBe('ready');
        expect(resolvePluginsCollectionState({ ...base, noticeReason: 'disconnected', listRead: false })).toBe('offline');
        expect(resolvePluginsCollectionState({ ...base, noticeReason: 'disconnected', listRead: false, itemCount: 0, visibleCount: 0 })).toBe('offline');
    });

    it('is empty only once the machine answered with nothing and nothing is being searched', () => {
        expect(resolvePluginsCollectionState({ ...base, itemCount: 0, visibleCount: 0 })).toBe('empty');
    });

    it('says "no match" only when a search or filter hides every plugin', () => {
        expect(resolvePluginsCollectionState({ ...base, visibleCount: 0, filtering: true })).toBe('noMatch');
        expect(resolvePluginsCollectionState({ ...base, itemCount: 0, visibleCount: 0, filtering: true })).toBe('noMatch');
        expect(resolvePluginsCollectionState({ ...base, noticeReason: 'disconnected', visibleCount: 0, filtering: true })).toBe('noMatch');
        expect(resolvePluginsCollectionState({ ...base, noticeReason: 'disconnected', itemCount: 0, visibleCount: 0, filtering: true })).toBe('offline');
    });
});
