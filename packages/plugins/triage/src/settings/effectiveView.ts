import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';

import { sameTriageSourceIdentity } from '../corpus/identity/components.js';
import {
    CORPUS_DEFAULT_SMART_POLICY_V1,
    type CorpusSmartPolicyV1,
} from '../corpus/query/smartPolicy.js';
import {
    TRIAGE_LIST_NO_FILTERS_V1,
    type SurfaceFilterSelectionV1,
    type TriageListOrderV1,
} from '../projection/listWindow.js';
import type { CorpusSavedViewsReadV1 } from './savedViews.js';

/**
 * The one read-side resolution from durable saved-view state to the lens the
 * query actually runs.
 *
 * It is deliberately thin: it selects, it never rewrites. A saved view is the
 * user's own statement of what they want to look at, so this resolver applies
 * the stored facets, order and policy exactly and never reinterprets source
 * vocabulary on their behalf.
 *
 * **A view naming a source the user later removed degrades honestly.** The
 * tempting implementation drops the now-unconfigured facet values so the view
 * "still works" — but a lens that said "pull requests from GitHub" then silently
 * becomes "everything from every source", presented under the label the user
 * saved. Instead the lens is applied as stored — which legitimately matches
 * nothing — and the removed sources are named, so the surface can explain an
 * empty view rather than showing a different one.
 */

export type CorpusEffectiveViewV1 = Readonly<{
    /** The saved view this lens came from, or `null` for the unsaved default. */
    viewId: string | null;
    label: string | null;
    /**
     * `saved` when a stored view is applied, `unsavedDefault` when none is
     * selected, and `unavailable` when the stored set could not be read — which
     * is reported rather than shown as an empty set the user could overwrite.
     */
    availability: 'saved' | 'unsavedDefault' | 'unavailable';
    filters: SurfaceFilterSelectionV1;
    order: TriageListOrderV1;
    smartPolicy: CorpusSmartPolicyV1;
    /**
     * Sources this lens names that are no longer configured, in the order they
     * first appear across the source, type and scope facets. Non-empty means the
     * view is narrower than the configured set can satisfy, not that it should
     * be widened.
     */
    unavailableSources: readonly PluginContributionIdentity[];
}>;

function collectUnavailableSources(
    filters: SurfaceFilterSelectionV1,
    configuredSources: readonly PluginContributionIdentity[],
): readonly PluginContributionIdentity[] {
    const named: PluginContributionIdentity[] = [
        ...filters.sources.map((value) => value.source),
        ...filters.types.map((value) => value.source),
        ...filters.scopes.map((value) => value.source),
    ];
    const unavailable: PluginContributionIdentity[] = [];
    for (const source of named) {
        if (configuredSources.some((configured) => sameTriageSourceIdentity(configured, source))) continue;
        if (unavailable.some((seen) => sameTriageSourceIdentity(seen, source))) continue;
        unavailable.push(source);
    }
    return unavailable;
}

const UNSAVED_DEFAULT = Object.freeze({
    viewId: null,
    label: null,
    filters: TRIAGE_LIST_NO_FILTERS_V1,
    order: 'newest' as const,
    smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
    unavailableSources: Object.freeze([]),
});

export function resolveTriageEffectiveView(input: Readonly<{
    saved: CorpusSavedViewsReadV1;
    /** The sources currently configured, as the aggregate list reports them. */
    configuredSources: readonly PluginContributionIdentity[];
}>): CorpusEffectiveViewV1 {
    if (input.saved.kind === 'unreadable') {
        return { ...UNSAVED_DEFAULT, availability: 'unavailable' };
    }

    const { views, selectedViewId } = input.saved.value;
    const selected = selectedViewId === null
        ? undefined
        : views.find((view) => view.viewId === selectedViewId);
    if (!selected) return { ...UNSAVED_DEFAULT, availability: 'unsavedDefault' };

    return {
        viewId: selected.viewId,
        label: selected.label,
        availability: 'saved',
        filters: selected.filters,
        order: selected.order,
        smartPolicy: selected.smartPolicy,
        unavailableSources: collectUnavailableSources(selected.filters, input.configuredSources),
    };
}
