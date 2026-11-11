import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import { TRIAGE_LIST_SORT_FIELDS_V1, type TriageListSortFieldV1 } from '@happier-dev/triage-protocol/v1';
import { sameTriageSourceIdentity } from '../corpus/identity/components.js';
import type { SurfaceFilterSelectionV1 } from './listWindow.js';

type Source = Readonly<{ source: PluginContributionIdentity; sourceInstanceId: string }>;
/** Source lanes that can contribute rows under the conjunctive lens facets. Row-level unit/kind membership stays with the list matcher. */
export function selectTriageListSourcesV1<T extends Source>(sources: readonly T[], filters: SurfaceFilterSelectionV1): readonly T[] {
    return sources.filter(source =>
        (filters.sources.length === 0 || filters.sources.some(value => sameTriageSourceIdentity(value.source, source.source)
            && (value.sourceInstanceId === undefined || value.sourceInstanceId === source.sourceInstanceId)))
        && (filters.types.length === 0 || filters.types.some(value => sameTriageSourceIdentity(value.source, source.source)))
        && (filters.scopes.length === 0 || filters.scopes.some(value => sameTriageSourceIdentity(value.source, source.source)
            && (value.sourceInstanceId === undefined || value.sourceInstanceId === source.sourceInstanceId))));
}
/** A mixed list may offer only fields declared by every selected source, including unavailable sources. */
export function readTriageListSortFieldsV1(sources: readonly Readonly<{ sortFields?: readonly TriageListSortFieldV1[] }>[]): readonly TriageListSortFieldV1[] {
    return sources.length === 0 ? [] : TRIAGE_LIST_SORT_FIELDS_V1.filter(field => sources.every(source => source.sortFields?.includes(field) === true));
}
