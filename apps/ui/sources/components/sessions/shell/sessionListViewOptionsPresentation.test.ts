import { describe, expect, it } from 'vitest';
import { resolveSessionListViewOptionSelectionDelta, resolveSessionListViewOptionsPresentation } from './sessionListViewOptionsPresentation';

describe('Session list View options', () => {
    it('offers exactly two layouts and one combined attention placement', () => {
        const view = resolveSessionListViewOptionsPresentation({ sessionListLayoutV1: 'projects', sessionListAttentionPlacementV1: 'both' }, 'recent_activity');
        expect(view.selectedLayout).toBe('recent_activity');
        expect(view.layoutItems.map(item => item.id)).toEqual(['layout:projects', 'layout:recent_activity']);
        expect(view.selectedAttentionPlacement).toBe('both');
        expect(view.attentionItems.map(item => item.id)).toEqual(['attention:both', 'attention:top', 'attention:inPlace']);
    });
    it('dispatches scalar choices and refuses every retired option', () => {
        expect(resolveSessionListViewOptionSelectionDelta('layout:recent_activity', {})).toEqual({ sessionListLayoutV1: 'recent_activity' });
        expect(resolveSessionListViewOptionSelectionDelta('attention:top', {})).toEqual({ sessionListAttentionPlacementV1: 'top' });
        for (const id of ['layout:active_inactive', 'working:global', 'attention:withinGroups', 'ordering:created', 'folderSort:mixed', 'grouping:active:date']) {
            expect(resolveSessionListViewOptionSelectionDelta(id, {})).toBeNull();
        }
    });
});
