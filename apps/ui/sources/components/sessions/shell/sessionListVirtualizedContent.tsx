import React from 'react';
import { FlatList, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { useSetting } from '@/sync/domains/state/storage';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

import { sessionListStyles } from './sessionListStyles';
import { SessionFolderFocusBreadcrumbs, SessionsListHeader } from './sessionListChrome';
import type { SessionFolderFocusScope } from '@/sync/domains/session/folders';

const sessionListNodeKeyExtractor = (item: string): string => item;

function getSessionListNodeType(nodeId: string): string {
    if (typeof nodeId === 'string' && nodeId.startsWith('session:')) {
        return 'session';
    }
    if (typeof nodeId === 'string' && nodeId.startsWith('header:')) {
        const parts = nodeId.split(':');
        const explicit = parts[1] ?? '';
        if (explicit && explicit !== 'server') {
            return `header:${explicit}`;
        }
        if (explicit === 'server' && parts.length <= 3) {
            return 'header:server';
        }
        if (nodeId.includes(':project:')) return 'header:project';
        if (nodeId.includes(':day:') || nodeId.includes(':date:')) return 'header:date';
        if (nodeId.includes(':pinned')) return 'header:pinned';
        if (nodeId.endsWith(':active') || nodeId.includes(':active:')) return 'header:active';
        if (nodeId.endsWith(':inactive') || nodeId.includes(':inactive:')) return 'header:inactive';
    }
    return 'header';
}

const SessionsListArchivedFooter = React.memo(function SessionsListArchivedFooter(props: Readonly<{
    onPress: () => void;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;

    return (
        <ItemGroup style={styles.footerContainer}>
            <Item
                title={hideInactiveSessions
                    ? t('sessionInfo.inactiveAndArchivedSessions')
                    : t('sessionInfo.archivedSessions')}
                icon={<Ionicons name="archive-outline" size={22} color={theme.colors.text.secondary} />}
                onPress={props.onPress}
            />
        </ItemGroup>
    );
});

export const SessionListVirtualizedContent = React.memo(function SessionListVirtualizedContent(props: Readonly<{
    nodeIds: ReadonlyArray<string>;
    rowHeight: number;
    safeAreaBottom: number;
    renderItem: (params: { item: string; index: number }) => React.ReactElement | null;
    rowExtraData: unknown;
    onStopScrollEventPropagationOnWeb: (event: any) => void;
    onPressArchivedSessions: () => void;
    folderFocus: SessionFolderFocusScope | null;
    folderFocusRootTitle?: string | null;
    onClearFolderFocus: () => void;
    onSelectFolderBreadcrumb: (folderId: string) => void;
}>) {
    const contentContainerStyle = React.useMemo(() => ({
        paddingBottom: props.safeAreaBottom + 128,
        maxWidth: layout.maxWidth,
    }), [props.safeAreaBottom]);
    const onPressArchivedSessionsRef = React.useRef(props.onPressArchivedSessions);
    onPressArchivedSessionsRef.current = props.onPressArchivedSessions;
    const handlePressArchivedSessions = React.useCallback(() => {
        onPressArchivedSessionsRef.current();
    }, []);
    const footerComponent = React.useMemo(() => (
        <SessionsListArchivedFooter onPress={handlePressArchivedSessions} />
    ), [handlePressArchivedSessions]);
    const headerComponent = React.useMemo(() => {
        const folderFocus = props.folderFocus;
        const onClearFolderFocus = props.onClearFolderFocus;
        const onSelectFolderBreadcrumb = props.onSelectFolderBreadcrumb;
        return function SessionListCompositeHeader() {
            return (
                <>
                    <SessionsListHeader />
                    {folderFocus ? (
                        <SessionFolderFocusBreadcrumbs
                            breadcrumbs={folderFocus.breadcrumbs}
                            onClear={onClearFolderFocus}
                            onSelectFolder={onSelectFolderBreadcrumb}
                            rootTitle={props.folderFocusRootTitle}
                        />
                    ) : null}
                </>
            );
        };
    }, [props.folderFocus, props.folderFocusRootTitle, props.onClearFolderFocus, props.onSelectFolderBreadcrumb]);

    if (Platform.OS === 'web') {
        return (
            <FlatList
                {...({
                    onWheel: props.onStopScrollEventPropagationOnWeb,
                    onTouchMove: props.onStopScrollEventPropagationOnWeb,
                } as any)}
                data={props.nodeIds as any}
                renderItem={props.renderItem as any}
                extraData={props.rowExtraData}
                keyExtractor={sessionListNodeKeyExtractor}
                contentContainerStyle={contentContainerStyle}
                ListHeaderComponent={headerComponent as any}
                ListFooterComponent={footerComponent as any}
            />
        );
    }

    return (
        <FlashList
            data={props.nodeIds as any}
            renderItem={props.renderItem as any}
            extraData={props.rowExtraData}
            keyExtractor={sessionListNodeKeyExtractor}
            getItemType={getSessionListNodeType as any}
            contentContainerStyle={contentContainerStyle as any}
            ListHeaderComponent={headerComponent as any}
            ListFooterComponent={footerComponent as any}
        />
    );
});
