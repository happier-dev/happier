import { describe, expect, it } from 'vitest';

import { CORPUS_DEFAULT_SMART_POLICY_V1 } from '../corpus/query/smartPolicy.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../projection/listWindow.js';
import { resolveTriageEffectiveView } from './effectiveView.js';
import { CORPUS_EMPTY_SAVED_VIEWS_V1, type CorpusSavedViewV1 } from './savedViews.js';

const GITHUB = Object.freeze({ pluginId: 'happier.github', localId: 'github' });
const SENTRY = Object.freeze({ pluginId: 'happier.sentry', localId: 'sentry' });

function view(overrides: Partial<CorpusSavedViewV1> = {}): CorpusSavedViewV1 {
    return {
        viewId: '00000001-0000-4000-8000-000000000000',
        label: 'Needs my review',
        filters: { ...TRIAGE_LIST_NO_FILTERS_V1, sources: [{ source: GITHUB }], states: ['open'] },
        order: 'smart',
        smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        ...overrides,
    };
}

describe('resolveTriageEffectiveView', () => {
    it('resolves the deterministic unsaved default when no view is selected', () => {
        const resolved = resolveTriageEffectiveView({
            saved: { kind: 'absent', value: CORPUS_EMPTY_SAVED_VIEWS_V1 },
            configuredSources: [GITHUB],
        });

        expect(resolved).toEqual({
            viewId: null,
            label: null,
            availability: 'unsavedDefault',
            filters: TRIAGE_LIST_NO_FILTERS_V1,
            order: 'newest',
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
            unavailableSources: [],
        });
    });

    it('applies the selected view exactly, without reinterpreting its lens', () => {
        const selected = view();
        const resolved = resolveTriageEffectiveView({
            saved: { kind: 'parsed', value: { v: 1, views: [selected], selectedViewId: selected.viewId } },
            configuredSources: [GITHUB, SENTRY],
        });

        expect(resolved.viewId).toBe(selected.viewId);
        expect(resolved.label).toBe('Needs my review');
        expect(resolved.availability).toBe('saved');
        expect(resolved.filters).toEqual(selected.filters);
        expect(resolved.order).toBe('smart');
        expect(resolved.smartPolicy).toEqual(CORPUS_DEFAULT_SMART_POLICY_V1);
        expect(resolved.unavailableSources).toEqual([]);
    });

    it('keeps the stored lens and names the removed source instead of silently widening the view', () => {
        const selected = view();
        const resolved = resolveTriageEffectiveView({
            saved: { kind: 'parsed', value: { v: 1, views: [selected], selectedViewId: selected.viewId } },
            // The user removed their GitHub source after saving this view.
            configuredSources: [SENTRY],
        });

        // Dropping the facet value would turn "pull requests from GitHub" into
        // "everything from every source" — a view the user never saved,
        // presented as the one they did.
        expect(resolved.filters).toEqual(selected.filters);
        expect(resolved.unavailableSources).toEqual([GITHUB]);
        expect(resolved.availability).toBe('saved');
    });

    it('reports every unavailable source across the source, type and scope facets exactly once', () => {
        const selected = view({
            filters: {
                ...TRIAGE_LIST_NO_FILTERS_V1,
                sources: [{ source: GITHUB }],
                types: [{ source: GITHUB, kindId: 'pull-request' }, { source: SENTRY, kindId: 'error' }],
                scopes: [{ source: GITHUB, collisionScope: 'example/repository' }],
            },
        });
        const resolved = resolveTriageEffectiveView({
            saved: { kind: 'parsed', value: { v: 1, views: [selected], selectedViewId: selected.viewId } },
            configuredSources: [],
        });

        expect(resolved.unavailableSources).toEqual([GITHUB, SENTRY]);
    });

    it('falls back to the unsaved default and says so when the stored views cannot be read', () => {
        const resolved = resolveTriageEffectiveView({
            saved: { kind: 'unreadable', value: CORPUS_EMPTY_SAVED_VIEWS_V1 },
            configuredSources: [GITHUB],
        });

        // The list still works; the saved-view set is reported unavailable
        // rather than presented as an empty set the user could overwrite.
        expect(resolved.availability).toBe('unavailable');
        expect(resolved.viewId).toBeNull();
        expect(resolved.filters).toEqual(TRIAGE_LIST_NO_FILTERS_V1);
        expect(resolved.order).toBe('newest');
    });

    it('resolves the unsaved default when the selection names no stored view', () => {
        const selected = view();
        const resolved = resolveTriageEffectiveView({
            saved: { kind: 'parsed', value: { v: 1, views: [selected], selectedViewId: 'other' } },
            configuredSources: [GITHUB],
        });

        expect(resolved.viewId).toBeNull();
        expect(resolved.availability).toBe('unsavedDefault');
        expect(resolved.filters).toEqual(TRIAGE_LIST_NO_FILTERS_V1);
    });
});
