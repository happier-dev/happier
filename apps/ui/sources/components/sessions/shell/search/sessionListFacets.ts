import { conditionModelFromFilter, isCollectionConditionChoiceOn, toggleCollectionConditionValue } from '@happier-dev/plugin-ui/components';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { sessionWorkFilterFields } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import type { SelectionListFilter } from '@/components/ui/selectionList';
import { t } from '@/text';

import { applySessionListConditionEdit, toSessionListConditionFilter } from './sessionListConditionFields';
import type { SessionListViewFilterController } from './useSessionListViewFilterController';

type FacetController = Pick<SessionListViewFilterController,
    'filters' | 'includeInactive' | 'updateFilters' | 'setSource' | 'setIncludeInactive' | 'resetFilters'>;

/** What people filter a Session list by most: each an existing condition value, one press from on or off. */
const FACETS = [
    { id: 'needs-you', fieldId: 'attention', value: 'needs_my_attention', label: () => t('workStatus.buckets.needs_you') },
    { id: 'working', fieldId: 'statuses', value: 'working', label: () => t('workStatus.buckets.working') },
    { id: 'failed', fieldId: 'statuses', value: 'failed', label: () => t('sessionsList.filtersStatusFailed') },
] as const satisfies readonly Readonly<{ id: string; fieldId: string; value: JsonValue; label: () => string }>[];

function readConditionModel(controller: Pick<FacetController, 'filters' | 'includeInactive'>) {
    return conditionModelFromFilter(sessionWorkFilterFields,
        toSessionListConditionFilter(controller.filters, controller.includeInactive));
}

/**
 * The Sessions title menu's common filters (lab `spfield`): one press each, in place. Once on, a filter is a token
 * on the line under the title like any other condition; the funnel at Find's end keeps the long tail.
 */
export function buildSessionListFacets(controller: FacetController): readonly SelectionListFilter[] {
    const model = readConditionModel(controller);
    return FACETS.map((quick) => {
        const label = quick.label();
        return {
            id: quick.id,
            label,
            valueLabel: label,
            selected: isCollectionConditionChoiceOn(model, quick.fieldId, quick.value),
            onToggle: () => {
                applySessionListConditionEdit(toggleCollectionConditionValue(model, quick.fieldId, quick.value), controller);
            },
        };
    });
}
