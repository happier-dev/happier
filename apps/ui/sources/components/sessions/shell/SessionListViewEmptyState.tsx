import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HomeReachabilityGate } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { t, type TranslationKey } from '@/text';

import type { SessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import type { SessionListViewContext, SessionListViewFilters } from './search/sessionListViewFilters';
import {
    resolveSessionListViewEmptyState,
    sessionListSubjectCopyKey,
    type SessionListViewEmptyStateAction,
} from './sessionListViewEmptyStateModel';
import { SessionListSkeletonRows } from './SessionListSkeletonRows';

const stylesheet = StyleSheet.create(() => ({
    line: {
        width: '100%',
    },
}));

type SessionListViewEmptyStateProps = Readonly<{
    presentation: SessionListQueryPresentation;
    visibleSessionCount: number;
    selectedHomeServerIds?: readonly string[];
    filters: SessionListViewFilters;
    defaults: SessionListViewFilters;
    viewContext: SessionListViewContext;
    includeInactive: boolean;
    hasHiddenInactiveSessions: boolean;
    emptySpaceName?: string | null;
    onRetry: () => void;
    onLoadMore: () => void;
    onClearFilters: () => void;
    onBrowseAllAccessible: () => void;
    onShowInactive: () => void;
}>;

function resolveAction(
    action: SessionListViewEmptyStateAction | null,
    props: SessionListViewEmptyStateProps,
): Readonly<{ titleKey: TranslationKey; onPress: () => void }> | null {
    if (action === 'retry') return { titleKey: 'common.retry', onPress: props.onRetry };
    if (action === 'load_more') return { titleKey: sessionListSubjectCopyKey('sessionsList.querySearchOlder', props.filters.show), onPress: props.onLoadMore };
    if (action === 'clear_filters') return { titleKey: 'sessionsList.filtersClear', onPress: props.onClearFilters };
    if (action === 'browse_all_accessible') {
        return { titleKey: sessionListSubjectCopyKey('sessionsList.queryBrowseAllAccessible', props.filters.show), onPress: props.onBrowseAllAccessible };
    }
    if (action === 'show_inactive') return { titleKey: 'sessionsList.filtersInactiveShow', onPress: props.onShowInactive };
    return null;
}

/**
 * The session list's query state, said in the list's own voice: skeleton rows while the first page
 * loads, otherwise one quiet line on the rows' edge ("Nothing in My work · Show all sessions",
 * "Couldn't refresh · Retry") through the one empty-state owner. A rail never gets a page-size state
 * with a glyph and a full-width button. Partial coverage keeps its repair guidance visible;
 * other longer descriptions stay the line's accessible hint.
 */
export const SessionListViewEmptyState = React.memo((props: SessionListViewEmptyStateProps) => {
    const styles = stylesheet;
    const model = resolveSessionListViewEmptyState(props);
    if (props.presentation.kind === 'initial_loading') {
        // A Home that does not answer ends the wait with "Can't reach {Home}. Retry".
        return <HomeReachabilityGate variant="line" relevantServerIds={props.selectedHomeServerIds}><SessionListSkeletonRows /></HomeReachabilityGate>;
    }
    if (model.mode === 'none') return null;

    const action = resolveAction(model.action, props);
    const label = action ? t(action.titleKey) : null;
    const description = model.descriptionKey ? t(model.descriptionKey) : undefined;
    const showDescription = props.presentation.kind === 'partial';

    return (
        <View
            accessibilityLiveRegion="polite"
            accessibilityHint={showDescription ? undefined : description}
            style={styles.line}
            testID={model.mode === 'status' ? 'session-list-query-status' : 'session-list-query-empty-state'}
        >
            <EmptyState
                layout="line"
                titleTestID="session-list-query-empty-title"
                title={'titleParams' in model ? t(model.titleKey, model.titleParams) : t(model.titleKey)}
                subtitle={showDescription ? description : undefined}
                primaryAction={action && label ? {
                    label,
                    onPress: action.onPress,
                    testID: `session-list-query-action:${model.action}`,
                } : undefined}
            />
        </View>
    );
});

SessionListViewEmptyState.displayName = 'SessionListViewEmptyState';
