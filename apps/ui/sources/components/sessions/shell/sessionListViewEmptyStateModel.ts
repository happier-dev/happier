import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import type { SessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';

import {
    buildQualifiedAudienceSelectionKey,
    buildQualifiedTagAddressKey,
    type SessionListViewContext,
    type SessionListViewFilters,
} from './search/sessionListViewFilters';

export type SessionListViewEmptyStateAction =
    | 'retry'
    | 'load_more'
    | 'clear_filters'
    | 'browse_all_accessible'
    | 'show_inactive';

export type SessionListViewEmptyStateModel =
    | Readonly<{ mode: 'none' }>
    | Readonly<{
        mode: 'empty' | 'status';
        titleKey:
            | 'sessionsList.queryInitialLoadingTitle'
            | 'sessionsList.queryUpdatingTitle'
            | 'sessionsList.querySomeHomesUnavailableTitle'
            | 'sessionsList.queryRefreshFailedTitle'
            | 'sessionsList.queryMoreAvailableTitle'
            | 'sessionsList.queryNoMatchesLoadedTitle'
            | 'sessionsList.queryNoMatchesTitle'
            | 'sessionsList.queryAttentionEmptyTitle'
            | 'sessionsList.queryTeamEmptyTitle'
            | 'sessionsList.queryMyWorkEmptyTitle'
            | 'sessionsList.queryAssignedEmptyTitle'
            | 'sessionsList.queryFollowingEmptyTitle'
            | 'sessionsList.queryInvolvingEmptyTitle'
            | 'sessionsList.queryReachableEmptyTitle'
            | 'sessionsList.queryHistoricalSharesWithheldTitle';
        descriptionKey:
            | 'sessionsList.querySomeHomesUnavailableDescription'
            | 'sessionsList.queryRefreshFailedRetainedDescription'
            | 'sessionsList.queryRefreshFailedEmptyDescription'
            | 'sessionsList.queryMoreAvailableDescription'
            | 'sessionsList.queryNoMatchesLoadedDescription'
            | 'sessionsList.queryNoMatchesDescription'
            | 'sessionsList.queryScopeEmptyDescription'
            | 'sessionsList.queryTeamEmptyDescription'
            | 'sessionsList.queryReachableEmptyDescription'
            | 'sessionsList.queryHistoricalSharesWithheldDescription'
            | null;
        action: SessionListViewEmptyStateAction | null;
    }>;

function equalSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    if (left.size !== right.size) return false;
    for (const value of left) {
        if (!right.has(value)) return false;
    }
    return true;
}

function readOtherStructuralFacets(filters: SessionListViewFilters) {
    // These facets have their own empty-state recovery or set comparison below.
    const {
        searchQuery: _searchQuery, scope: _scope, attention: _attention, includeInactive: _includeInactive,
        homeServerIds: _homeServerIds, audiences: _audiences, tagIds: _tagIds,
        ...facets
    } = filters;
    return facets;
}

function hasChangedStructuralFacet(filters: SessionListViewFilters, defaults: SessionListViewFilters): boolean {
    return !sameStrictJsonValue(readOtherStructuralFacets(filters), readOtherStructuralFacets(defaults))
        || !equalSets(new Set(filters.homeServerIds), new Set(defaults.homeServerIds))
        || !equalSets(
            new Set(filters.audiences.map(buildQualifiedAudienceSelectionKey)),
            new Set(defaults.audiences.map(buildQualifiedAudienceSelectionKey)),
        )
        || !equalSets(
            new Set(filters.tagIds.map(buildQualifiedTagAddressKey)),
            new Set(defaults.tagIds.map(buildQualifiedTagAddressKey)),
        );
}

export function resolveSessionListViewEmptyState(input: Readonly<{
    presentation: SessionListQueryPresentation;
    visibleSessionCount: number;
    filters: SessionListViewFilters;
    defaults: SessionListViewFilters;
    viewContext: SessionListViewContext;
    includeInactive: boolean;
    hasHiddenInactiveSessions: boolean;
}>): SessionListViewEmptyStateModel {
    const hasRows = input.visibleSessionCount > 0;
    const hasSearch = input.filters.searchQuery.trim().length > 0;

    if (input.presentation.kind === 'initial_loading') {
        return { mode: 'empty', titleKey: 'sessionsList.queryInitialLoadingTitle', descriptionKey: null, action: null };
    }
    if (input.presentation.kind === 'refreshing') {
        return { mode: 'status', titleKey: 'sessionsList.queryUpdatingTitle', descriptionKey: null, action: null };
    }
    if (input.presentation.kind === 'partial') {
        const recoverable = input.presentation.unavailableHomes.some((home) => (
            home.reason === 'offline' || home.reason === 'error'
        ));
        // An unavailable Home that retrying cannot fix (disabled, unsupported) leaves
        // the current facets unanswerable. With no rows behind them that is a dead end,
        // so the incumbent clear action is the way back to a corpus this Home can serve.
        return {
            mode: hasRows ? 'status' : 'empty',
            titleKey: 'sessionsList.querySomeHomesUnavailableTitle',
            descriptionKey: 'sessionsList.querySomeHomesUnavailableDescription',
            action: recoverable ? 'retry' : (hasRows ? null : 'clear_filters'),
        };
    }
    if (input.presentation.kind === 'error') {
        return {
            mode: input.presentation.retainedRows ? 'status' : 'empty',
            titleKey: 'sessionsList.queryRefreshFailedTitle',
            descriptionKey: input.presentation.retainedRows
                ? 'sessionsList.queryRefreshFailedRetainedDescription'
                : 'sessionsList.queryRefreshFailedEmptyDescription',
            action: 'retry',
        };
    }
    // Withheld shares make coverage incomplete even when pagination is exhausted.
    // Explain the owner-upgrade recovery without inventing another page to load.
    if (input.presentation.historicalSharesWithheld) {
        return {
            mode: hasRows ? 'status' : 'empty',
            titleKey: 'sessionsList.queryHistoricalSharesWithheldTitle',
            descriptionKey: 'sessionsList.queryHistoricalSharesWithheldDescription',
            action: input.presentation.hasMore === true ? 'load_more' : null,
        };
    }
    if (hasRows) {
        return input.presentation.complete
            ? { mode: 'none' }
            : {
                mode: 'status',
                titleKey: 'sessionsList.queryMoreAvailableTitle',
                descriptionKey: 'sessionsList.queryMoreAvailableDescription',
                action: 'load_more',
            };
    }
    if (!input.presentation.complete) {
        return hasSearch || hasChangedStructuralFacet(input.filters, input.defaults)
            ? {
                mode: 'empty',
                titleKey: 'sessionsList.queryNoMatchesLoadedTitle',
                descriptionKey: 'sessionsList.queryNoMatchesLoadedDescription',
                action: 'load_more',
            }
            : {
                mode: 'empty',
                titleKey: 'sessionsList.queryMoreAvailableTitle',
                descriptionKey: 'sessionsList.queryMoreAvailableDescription',
                action: 'load_more',
            };
    }
    if (hasSearch || hasChangedStructuralFacet(input.filters, input.defaults)) {
        return {
            mode: 'empty',
            titleKey: 'sessionsList.queryNoMatchesTitle',
            descriptionKey: 'sessionsList.queryNoMatchesDescription',
            action: 'clear_filters',
        };
    }
    if (input.filters.attention === 'needs_my_attention') {
        return {
            mode: 'empty',
            titleKey: 'sessionsList.queryAttentionEmptyTitle',
            descriptionKey: 'sessionsList.queryScopeEmptyDescription',
            action: 'clear_filters',
        };
    }
    if (!input.includeInactive && input.hasHiddenInactiveSessions) {
        return {
            mode: 'empty',
            titleKey: 'sessionsList.queryNoMatchesTitle',
            descriptionKey: 'sessionsList.queryNoMatchesDescription',
            action: 'show_inactive',
        };
    }
    // Only a complete Team-wide read is evidence that the Team itself is empty.
    // Under a personal scope the scope branch below owns the answer, so its
    // Browse-all recovery survives inside Team Sessions.
    if (input.viewContext.kind === 'team' && input.filters.scope === 'all_accessible') {
        return {
            mode: 'empty',
            titleKey: 'sessionsList.queryTeamEmptyTitle',
            descriptionKey: 'sessionsList.queryTeamEmptyDescription',
            action: null,
        };
    }
    const scopeTitleKey = input.filters.scope === 'my_work'
        ? 'sessionsList.queryMyWorkEmptyTitle' as const
        : input.filters.scope === 'assigned_to_me'
            ? 'sessionsList.queryAssignedEmptyTitle' as const
            : input.filters.scope === 'following'
                ? 'sessionsList.queryFollowingEmptyTitle' as const
                : input.filters.scope === 'involving_me'
                    ? 'sessionsList.queryInvolvingEmptyTitle' as const
                    : null;
    if (scopeTitleKey) {
        return {
            mode: 'empty',
            titleKey: scopeTitleKey,
            descriptionKey: 'sessionsList.queryScopeEmptyDescription',
            action: 'browse_all_accessible',
        };
    }
    return {
        mode: 'empty',
        titleKey: 'sessionsList.queryReachableEmptyTitle',
        descriptionKey: 'sessionsList.queryReachableEmptyDescription',
        action: null,
    };
}
