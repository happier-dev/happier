import { useSessionListLayoutChoice } from '@/hooks/session/sessionListLayoutIntent';
import { useVisibleSessionListPaneState, type VisibleSessionListPaneStateOptions } from '@/hooks/session/useVisibleSessionListPaneState';
import { buildSessionListCollapseContextKey } from '@/sync/domains/session/listing/sessionListCollapseState';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListViewFilterController } from './search/useSessionListViewFilterController';

/** The list and non-list consumers share the filter, paging and shelf producer. */
export function useSessionListPaneProjection(storageKind: SessionListStorageFilter,
    controller: SessionListViewFilterController,
    options: Pick<VisibleSessionListPaneStateOptions, 'pathname' | 'retainedPathname' | 'retainedVisibleSessionListIndex' | 'retainedEmptyState'
        | 'sessionListSurfaceDataActive' | 'attentionInteractionHeld'> = {}) {
    const layout = useSessionListLayoutChoice();
    return useVisibleSessionListPaneState(storageKind, {
        ...options,
        collapseContextKey: buildSessionListCollapseContextKey(controller, layout),
        queryHomes: controller.pagingHomes,
        emptyQuerySelectionComplete: controller.emptyQuerySelectionComplete,
        workFilter: controller.displayFilters,
        spaceMembership: controller.spaceMembership,
        includeNeedsYouEverywhere: controller.includeNeedsYouEverywhere,
        filterControlsRequired: controller.filterControlsRequired,
    });
}
