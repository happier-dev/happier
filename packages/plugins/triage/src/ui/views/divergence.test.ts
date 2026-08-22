import { describe, expect, it } from 'vitest';

import { TRIAGE_LIST_NO_FILTERS_V1 } from '../../projection/listWindow.js';
import type { CorpusSavedViewV1 } from '../../settings/savedViews.js';
import { readTriageSavedViewLensStatusV1 } from './divergence.js';

const SOURCE = { pluginId: 'happier.example.source', localId: 'example-forge' };
const OTHER = { pluginId: 'happier.example.source', localId: 'other-forge' };

const STORED: CorpusSavedViewV1 = {
    viewId: '0000000a-0000-4000-8000-00000000000a',
    label: 'Needs my review',
    filters: {
        ...TRIAGE_LIST_NO_FILTERS_V1,
        sources: [{ source: SOURCE }, { source: OTHER }],
        states: ['done'],
    },
    order: 'smart',
    smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
};

const STORED_LENS = {
    filters: STORED.filters,
    order: STORED.order,
    smartPolicy: STORED.smartPolicy,
};

describe('the saved-view lens status', () => {
    it('calls a lens that matches the selected view saved, whatever order it was built in', () => {
        // The reader pressed the two sources in the other order. That is one
        // constraint, and calling it "modified" would leave Update as the only
        // way to silence a difference that does not exist.
        expect(readTriageSavedViewLensStatusV1({
            selected: STORED,
            lens: {
                ...STORED_LENS,
                filters: {
                    ...STORED.filters,
                    sources: [{ source: OTHER }, { source: SOURCE }],
                },
            },
            query: '',
        })).toBe('saved');
    });

    it('marks a facet, an order or a Smart ladder change as modified', () => {
        expect(readTriageSavedViewLensStatusV1({
            selected: STORED,
            lens: { ...STORED_LENS, filters: { ...STORED.filters, states: ['done', 'open'] } },
            query: '',
        })).toBe('modified');
        expect(readTriageSavedViewLensStatusV1({
            selected: STORED,
            lens: { ...STORED_LENS, order: 'newest' },
            query: '',
        })).toBe('modified');
        // The ladder is compared whatever the order is: a view retains it
        // across a non-Smart switch, so changing it changes the view.
        expect(readTriageSavedViewLensStatusV1({
            selected: STORED,
            lens: {
                ...STORED_LENS,
                order: 'newest',
                smartPolicy: { v: 1, precedence: ['attention', 'activity'] },
            },
            query: '',
        })).toBe('modified');
    });

    it('treats a settled query as a constraint the saved view does not describe', () => {
        // A saved view carries no query text at all, so a list narrowed by the
        // reader's own search is not the view it is named after.
        expect(readTriageSavedViewLensStatusV1({
            selected: STORED,
            lens: STORED_LENS,
            query: 'normalizer',
        })).toBe('modified');
    });

    it('says nothing about a lens no saved view is behind', () => {
        expect(readTriageSavedViewLensStatusV1({
            selected: null,
            lens: STORED_LENS,
            query: 'normalizer',
        })).toBe('unsaved');
    });
});
