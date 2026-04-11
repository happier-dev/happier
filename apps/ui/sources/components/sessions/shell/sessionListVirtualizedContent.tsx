import React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { Text } from '@/components/ui/text/Text';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { useSetting } from '@/sync/domains/state/storage';

import { sessionListStyles } from './sessionListStyles';
import { SessionsListHeader } from './sessionListChrome';

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
        <View style={styles.footerContainer}>
            <Pressable
                style={styles.footerButton}
                onPress={props.onPress}
                accessibilityRole="button"
            >
                <Ionicons name="archive-outline" size={18} color={theme.colors.text} />
                <Text style={styles.footerButtonLabel}>
                    {hideInactiveSessions
                        ? t('sessionInfo.inactiveAndArchivedSessions')
                        : t('sessionInfo.archivedSessions')}
                </Text>
            </Pressable>
        </View>
    );
});

export const SessionListVirtualizedContent = React.memo(function SessionListVirtualizedContent(props: Readonly<{
    nodeIds: ReadonlyArray<string>;
    rowHeight: number;
    safeAreaBottom: number;
    renderItem: (params: { item: string; index: number }) => React.ReactElement | null;
    onStopScrollEventPropagationOnWeb: (event: any) => void;
    onPressArchivedSessions: () => void;
}>) {
    const contentContainerStyle = { paddingBottom: props.safeAreaBottom + 128, maxWidth: layout.maxWidth };

    if (Platform.OS === 'web') {
        return (
            <FlatList
                {...({
                    onWheel: props.onStopScrollEventPropagationOnWeb,
                    onTouchMove: props.onStopScrollEventPropagationOnWeb,
                } as any)}
                data={props.nodeIds as any}
                renderItem={props.renderItem as any}
                keyExtractor={(item: string) => item}
                contentContainerStyle={contentContainerStyle}
                ListHeaderComponent={SessionsListHeader as any}
                ListFooterComponent={<SessionsListArchivedFooter onPress={props.onPressArchivedSessions} /> as any}
            />
        );
    }

    return (
        <FlashList
            data={props.nodeIds as any}
            renderItem={props.renderItem as any}
            keyExtractor={(item: string) => item}
            estimatedItemSize={props.rowHeight}
            getItemType={getSessionListNodeType as any}
            contentContainerStyle={contentContainerStyle as any}
            ListHeaderComponent={SessionsListHeader as any}
            ListFooterComponent={<SessionsListArchivedFooter onPress={props.onPressArchivedSessions} /> as any}
        />
    );
});
