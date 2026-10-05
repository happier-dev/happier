import { describe, expect, it } from 'vitest';

import { insertGroupTab, moveGroupTab, reorderGroupTab } from './tabGroupTransitions';

describe('tab group transitions', () => {
    it('inserts and reorders against current semantic anchors without dropping intervening members', () => {
        const group = { id: 'group', tabIds: ['a', 'late', 'b'], activeTabId: 'a', mru: ['a', 'b', 'late'] };
        expect(insertGroupTab(group, 'new', 'b')).toMatchObject({ tabIds: ['a', 'late', 'new', 'b'], activeTabId: 'new' });
        const reordered = reorderGroupTab(group, 'a', 'b');
        expect(reordered).toMatchObject({ tabIds: ['late', 'a', 'b'], activeTabId: 'a', mru: group.mru });
        expect(reorderGroupTab(group, 'a', 'deleted').tabIds).toEqual(['late', 'b', 'a']);
        expect(reorderGroupTab(group, 'a', 'a')).toBe(group);
        expect(reorderGroupTab(group, 'missing', 'b')).toBe(group);
    });

    it('moves a preview between groups and replaces only the destination preview', () => {
        const source = { id: 'source', tabIds: ['keep', 'moving'], activeTabId: 'moving', mru: ['moving', 'keep'] };
        const target = { id: 'target', tabIds: ['pinned', 'old-preview'], activeTabId: 'old-preview', mru: ['old-preview', 'pinned'] };
        const tabs = {
            keep: { id: 'keep', pinned: true, preview: false },
            moving: { id: 'moving', pinned: false, preview: true },
            pinned: { id: 'pinned', pinned: true, preview: false },
            'old-preview': { id: 'old-preview', pinned: false, preview: true },
        };

        const moved = moveGroupTab(source, target, tabs.moving, tabs);

        expect(moved.source).toMatchObject({ tabIds: ['keep'], activeTabId: 'keep', mru: ['keep'] });
        expect(moved.target).toMatchObject({ tabIds: ['pinned', 'moving'], activeTabId: 'moving', mru: ['moving', 'pinned'] });
        expect(moved.replacedPreviewTabIds).toEqual(['old-preview']);
    });
});
