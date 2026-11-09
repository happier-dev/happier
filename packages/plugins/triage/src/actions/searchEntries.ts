import {
    computeCanonicalDomainSeparatedDigest,
    PluginError,
} from '@happier-dev/plugin-sdk';
import type { TriageDataActionHandler } from './dataContext.js';
import type {
    PluginSearchItemV1,
    PluginSearchQueryV1,
    PluginSearchResultV1,
} from '@happier-dev/plugin-sdk';

import { entryReferenceComponents, renderSourceQualifiedId } from '../corpus/identity/components.js';
import { assembleTriageListPass, createTriageListEntriesDeps, type TriageAdmittedSourceV1 } from './listEntries.js';
import { buildTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from '../composer/openEntryDetails.js';
import {
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    type TriageListRowV1,
    type TriageListWindowV1,
} from '../projection/listWindow.js';
import { projectTriageEntryDisplay, readTriageEntryGlyphV1 } from '../ui/window/entryDisplay.js';
import { projectTriageSourceWorkflowSubjectV1 } from '../ui/detail/sourceSurface.js';

/**
 * The Universal Search query Action.
 *
 * It is a second Account Action over the SAME scan/fold owner, not a second
 * search. The heavyweight list contract carries lenses, facets, lane
 * health, coverage, per-connection observations and paging frontiers; none of
 * that is the bounded `{ query, limit } → { items, truncated }` DTO the
 * universal surface speaks. Each query assembles an Account read through the
 * list owner and projects its observations through the same matcher, fold,
 * `smart` order and display owner used by the list and Composer picker. No
 * mounted page, client cache or Machine description is required.
 *
 * Activation is the incumbent open owner: every row carries an `openSurface`
 * command for the one Triage app-page destination, holding the exact strict
 * launch input `openTriageEntryDetails` would have built. There is no second
 * navigation path, and the host never learns a Triage route.
 */

const TRIAGE_SEARCH_RESULT_ID_DOMAIN_V1 = 'happier:triage:search-result-id:v1';

function deriveTriageSearchResultId(row: TriageListRowV1): string {
    return computeCanonicalDomainSeparatedDigest(
        TRIAGE_SEARCH_RESULT_ID_DOMAIN_V1,
        entryReferenceComponents(row.entryRef),
    );
}

/**
 * A row with no selectable connection is omitted rather than shown.
 *
 * Its entry is real, but nothing can be opened under it: the detail page
 * addresses one exact connection, and choosing one for the reader would open a
 * different provider's answer than the row describes. An unopenable row in a
 * search result is worse than an absent one.
 */
function toSearchItem(
    row: TriageListRowV1,
    admittedSources: ReadonlyMap<string, TriageAdmittedSourceV1>,
): readonly PluginSearchItemV1[] {
    if (row.selected.kind !== 'selected') return [];
    const display = projectTriageEntryDisplay(row);
    return [{
        id: deriveTriageSearchResultId(row),
        title: display.title,
        subtitle: [display.scopeLabel, ...(display.designation ? [display.designation] : [])].join(' · '),
        icon: readTriageEntryGlyphV1(display.lifecyclePresentation, projectTriageSourceWorkflowSubjectV1(
            admittedSources.get(renderSourceQualifiedId(row.entryRef.source))?.descriptor, row.entryRef.kindId)),
        command: {
            kind: 'openSurface',
            destination: TRIAGE_APP_PAGE_LOCAL_ID_V1,
            input: buildTriageEntryDetailLaunchInput({
                entryRef: row.entryRef,
                sourceInstance: {
                    source: row.entryRef.source,
                    sourceInstanceId: row.selected.sourceInstanceId,
                },
            }),
            // The destination's host-owned page root. The opened page's own
            // location writer replaces it with the canonical entry encoding.
            subPath: '',
        },
    }];
}

export function searchTriageEntries(
    input: PluginSearchQueryV1,
    window: TriageListWindowV1,
    admittedSources: ReadonlyMap<string, TriageAdmittedSourceV1>,
): PluginSearchResultV1 {
    const limit = Math.max(1, Math.min(input.limit, MAX_TRIAGE_LIST_WINDOW_ROWS_V1));
    const openableItems = window.rows.flatMap(row => toSearchItem(row, admittedSources));
    const items = openableItems.slice(0, limit);
    return {
        items,
        // Honest bounding: a window whose lanes have not all exhausted has more
        // to give, and an openable row cut by the bound is one the reader has
        // not seen.
        truncated: window.coverage !== 'complete'
            || openableItems.length > items.length,
    };
}
/**
 * The registered handler. It binds the owner above to the invocation context
 * exactly as the list Action does, and adds no dispatch, cache or registry.
 */
export function createTriageSearchEntriesActionHandler(): TriageDataActionHandler<
    PluginSearchQueryV1,
    PluginSearchResultV1
> {
    return async (input, context) => {
        if (context.signal.aborted) throw new PluginError({ code: 'plugin_action_aborted' });
        try {
            const limit = Math.max(1, Math.min(input.limit, MAX_TRIAGE_LIST_WINDOW_ROWS_V1));
            const pass = await assembleTriageListPass({
                v: 1, sources: { kind: 'allConfigured' },
                query: input.query,
                order: 'smart',
                limit,
            }, createTriageListEntriesDeps(context));
            if (context.signal.aborted) throw new PluginError({ code: 'plugin_action_aborted' });
            return searchTriageEntries(input, pass.window, pass.admittedSources);
        } catch (error) {
            if (context.signal.aborted) throw new PluginError({ code: 'plugin_action_aborted' });
            const code = error instanceof PluginError ? error.code : undefined;
            return { items: [], truncated: false, failure: { code: code === 'root_not_found' || code === 'ROOT_NOT_FOUND'
                ? 'root_not_found' : code === 'auth_required' ? 'auth_required' : 'unavailable' } };
        }
    };
}
