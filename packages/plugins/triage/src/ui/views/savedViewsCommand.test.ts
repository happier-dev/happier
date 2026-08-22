import { describe, expect, it } from 'vitest';

import { TRIAGE_LIST_NO_FILTERS_V1 } from '../../projection/listWindow.js';
import type { CorpusSavedViewV1 } from '../../settings/savedViews.js';
import {
    readTriageSavedViewsProjectionV1,
    triageRenameSavedViewInputV1,
    triageUpdateSavedViewInputV1,
} from './savedViewsCommand.js';

const SOURCE = { pluginId: 'happier.example.source', localId: 'example-forge' };

const STORED: CorpusSavedViewV1 = {
    viewId: '0000000a-0000-4000-8000-00000000000a',
    label: 'Needs my review',
    filters: { ...TRIAGE_LIST_NO_FILTERS_V1, states: ['done'] },
    order: 'smart',
    smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
};

const EDITED_LENS = {
    filters: { ...TRIAGE_LIST_NO_FILTERS_V1, states: ['open'] as const },
    order: 'newest' as const,
    smartPolicy: { v: 1, precedence: ['attention', 'activity'] } as const,
};

describe('the surface’s saved-view commands', () => {
    it('renames without carrying the lens the reader is looking at into the view', () => {
        // Both intents reach one `update` command, so the difference between
        // them is the whole contract here: a rename that took the live lens
        // would overwrite the saved view under the guise of a name change.
        expect(triageRenameSavedViewInputV1(STORED, 'Mine to review')).toEqual({
            v: 1,
            kind: 'update',
            viewId: STORED.viewId,
            label: 'Mine to review',
            filters: STORED.filters,
            order: 'smart',
            smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
        });
    });

    it('updates the lens without renaming the view', () => {
        expect(triageUpdateSavedViewInputV1(STORED, EDITED_LENS)).toEqual({
            v: 1,
            kind: 'update',
            viewId: STORED.viewId,
            label: STORED.label,
            filters: EDITED_LENS.filters,
            order: 'newest',
            smartPolicy: { v: 1, precedence: ['attention', 'activity'] },
        });
    });

    it('reads an Action projection as the resolver’s own durable read', () => {
        const read = readTriageSavedViewsProjectionV1({
            availability: 'parsed',
            views: [{
                viewId: STORED.viewId,
                label: STORED.label,
                filters: { sources: [{ source: SOURCE }], types: [], scopes: [], states: [], attention: [] },
                order: 'oldest',
                smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
            }],
            selectedViewId: STORED.viewId,
        });

        expect(read.kind).toBe('parsed');
        expect(read.value.selectedViewId).toBe(STORED.viewId);
        expect(read.value.views[0]?.smartPolicy).toEqual({ v: 1, precedence: ['activity', 'attention'] });
        expect(read.value.views[0]?.filters.sources).toEqual([{ source: SOURCE }]);
    });

    it('reports a set it cannot narrow as unreadable rather than ranking it', () => {
        // The wire widens the closed ladder to a two-member array. A repeated
        // predicate is not a policy this build can evaluate, and silently
        // ranking by it would apply an order nobody saved.
        const read = readTriageSavedViewsProjectionV1({
            availability: 'parsed',
            views: [{
                viewId: STORED.viewId,
                label: STORED.label,
                filters: TRIAGE_LIST_NO_FILTERS_V1,
                order: 'newest',
                smartPolicy: { v: 1, precedence: ['attention', 'attention'] },
            }],
            selectedViewId: STORED.viewId,
        });

        expect(read.kind).toBe('unreadable');
        expect(read.value.views).toEqual([]);
    });

    it('keeps an unavailable read apart from an empty one', () => {
        // "You have saved no views" invites a write that destroys the set; "this
        // build cannot read them" refuses one.
        expect(readTriageSavedViewsProjectionV1({
            availability: 'unavailable',
            views: [],
            selectedViewId: null,
        }).kind).toBe('unreadable');
        expect(readTriageSavedViewsProjectionV1({
            availability: 'absent',
            views: [],
            selectedViewId: null,
        }).kind).toBe('absent');
    });
});
