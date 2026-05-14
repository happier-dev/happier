import React from 'react';
import { View, Platform } from 'react-native';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { sessionListStyles } from './sessionListStyles';
import { SessionListVirtualizedContent } from './sessionListVirtualizedContent';
import { useSessionListViewStateFromPaneState } from './useSessionListViewState';
import { useVisibleSessionListPaneState, type VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';

export function SessionsList(props: Readonly<{ storageKind?: SessionListStorageFilter }>) {
    return <SessionsListView {...props} />;
}

export function SessionsListView(props: Readonly<{
    storageKind?: SessionListStorageFilter;
    paneState?: VisibleSessionListPaneState;
}>) {
    const storageKind = props.storageKind ?? 'all';
    if (props.paneState) {
        return <SessionsListViewContent storageKind={storageKind} paneState={props.paneState} />;
    }

    return <SessionsListViewWithResolvedPaneState storageKind={storageKind} />;
}

function SessionsListViewWithResolvedPaneState(props: Readonly<{
    storageKind: SessionListStorageFilter;
}>) {
    const paneState = useVisibleSessionListPaneState(props.storageKind);
    return <SessionsListViewContent storageKind={props.storageKind} paneState={paneState} />;
}

function SessionsListViewContent(props: Readonly<{
    storageKind: SessionListStorageFilter;
    paneState: VisibleSessionListPaneState;
}>) {
    const styles = sessionListStyles;
    const safeArea = useChromeSafeAreaInsets();
    const viewState = useSessionListViewStateFromPaneState(props.storageKind, props.paneState);

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <SessionListVirtualizedContent
                    nodeIds={viewState.nodeIds}
                    rowHeight={viewState.rowHeight}
                    safeAreaBottom={safeArea.bottom}
                    renderItem={viewState.renderVirtualizedItem}
                    onStopScrollEventPropagationOnWeb={(event: any) => {
                        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
                        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
                        // Stopping propagation here keeps the event within the sessions list subtree so native scrolling works.
                        if (Platform.OS !== 'web') return;
                        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
                    }}
                    onPressArchivedSessions={viewState.onPressArchivedSessions}
                    folderFocus={viewState.folderFocus}
                    folderFocusRootTitle={viewState.folderFocusRootTitle}
                    onClearFolderFocus={viewState.onClearFolderFocus}
                    onSelectFolderBreadcrumb={viewState.onSelectFolderBreadcrumb}
                />
            </View>
        </View>
    );
}
