import React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { Text } from '@/components/ui/text/Text';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { layout } from '@/components/ui/layout/layout';

import { sessionListStyles } from './sessionListStyles';
import { SessionsListHeader } from './sessionListChrome';

function getSessionListItemKey(item: SessionListViewItem, index: number): string {
    if (item.type === 'header') {
        const groupKey = String(item.groupKey ?? '').trim();
        const headerKind = String(item.headerKind ?? '').trim();
        const serverId = String(item.serverId ?? '').trim();
        if (groupKey) return `header:${groupKey}`;
        if (headerKind === 'server' && (serverId || item.title)) return `server:${serverId || item.title}`;
        return `header:${headerKind}:${serverId}:${item.title}:${index}`;
    }

    const serverId = String(item.serverId ?? '').trim();
    const sessionId = String(item.session?.id ?? '').trim();
    if (serverId && sessionId) return `session:${serverId}:${sessionId}`;
    return `session:${index}`;
}

function getSessionListItemType(item: SessionListViewItem): string {
    if (item.type === 'session') return 'session';
    const headerKind = String(item.headerKind ?? '').trim();
    return headerKind ? `header:${headerKind}` : 'header';
}

const SessionsListArchivedFooter = React.memo(function SessionsListArchivedFooter(props: Readonly<{
    onPress: () => void;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();

    return (
        <View style={styles.footerContainer}>
            <Pressable
                style={styles.footerButton}
                onPress={props.onPress}
                accessibilityRole="button"
            >
                <Ionicons name="archive-outline" size={18} color={theme.colors.text} />
                <Text style={styles.footerButtonLabel}>
                    {t('sessionInfo.archivedSessions')}
                </Text>
            </Pressable>
        </View>
    );
});

export const SessionListVirtualizedContent = React.memo(function SessionListVirtualizedContent(props: Readonly<{
    listItems: ReadonlyArray<SessionListViewItem>;
    rowHeight: number;
    safeAreaBottom: number;
    renderItem: (params: { item: SessionListViewItem; index: number }) => React.ReactElement | null;
    onStopScrollEventPropagationOnWeb: (event: any) => void;
    onPressArchivedSessions: () => void;
}>) {
    const contentContainerStyle = React.useMemo(
        () => ({ paddingBottom: props.safeAreaBottom + 128, maxWidth: layout.maxWidth }),
        [props.safeAreaBottom],
    );

    const footer = React.useCallback(
        () => <SessionsListArchivedFooter onPress={props.onPressArchivedSessions} />,
        [props.onPressArchivedSessions],
    );

    if (Platform.OS === 'web') {
        return (
            <FlatList
                {...({
                    onWheel: props.onStopScrollEventPropagationOnWeb,
                    onTouchMove: props.onStopScrollEventPropagationOnWeb,
                } as any)}
                data={props.listItems as any}
                renderItem={props.renderItem as any}
                keyExtractor={getSessionListItemKey as any}
                contentContainerStyle={contentContainerStyle}
                ListHeaderComponent={SessionsListHeader as any}
                ListFooterComponent={footer as any}
            />
        );
    }

    return (
        <FlashList
            data={props.listItems as any}
            renderItem={props.renderItem as any}
            keyExtractor={getSessionListItemKey as any}
            estimatedItemSize={props.rowHeight}
            getItemType={getSessionListItemType as any}
            contentContainerStyle={contentContainerStyle as any}
            ListHeaderComponent={SessionsListHeader as any}
            ListFooterComponent={footer as any}
        />
    );
});
