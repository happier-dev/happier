import * as React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { FilesystemBrowserListProps } from './filesystemBrowserTypes';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FlashList, type FlashListRef } from '@/components/ui/lists/flashListCompat/FlashListCompat';

const FILESYSTEM_BROWSER_ESTIMATED_ITEM_SIZE = 38;
type FilesystemBrowserListNode = FilesystemBrowserListProps['nodes'][number];

export const FilesystemBrowserList = React.memo(function FilesystemBrowserList(props: FilesystemBrowserListProps): React.ReactElement {
    const { theme } = useUnistyles();
    const showRootLoadingHeader = props.rootLoading && props.showInlineLoadingHeader !== false;
    const keyExtractor = React.useCallback((node: FilesystemBrowserListNode) => `${node.type}:${node.path}`, []);
    const listHeaderComponent = React.useMemo(() => (
        showRootLoadingHeader ? (
            <View
                style={{
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                }}
            >
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {props.loadingLabel}
                </Text>
            </View>
        ) : props.rootError ? (
            <View
                testID={props.listHeaderTestID}
                style={{
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                }}
            >
                <Ionicons name="alert-circle-outline" size={16} color={theme.colors.text.secondary} />
                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {props.inlineRetryLabel}
                </Text>
                <View style={{ flex: 1 }} />
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.inlineRetryLabel}
                    onPress={() => {
                        void props.retryRoot();
                    }}
                    style={{ paddingHorizontal: 10, paddingVertical: 6 }}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.text.link, ...Typography.default('semiBold') }}>
                        {props.inlineRetryLabel}
                    </Text>
                </Pressable>
            </View>
        ) : null
    ), [props.inlineRetryLabel, props.listHeaderTestID, props.loadingLabel, props.retryRoot, props.rootError, showRootLoadingHeader, theme.colors.text.link, theme.colors.text.secondary]);

    const renderItem = React.useCallback(({ item: node, index }: { item: FilesystemBrowserListNode; index: number }) => (
        props.renderRow({
            node,
            showDivider: index < props.nodes.length - 1,
        })
    ), [props.nodes.length, props.renderRow]);

    const sharedListProps = {
        data: props.nodes,
        keyExtractor,
        style: props.style,
        contentContainerStyle: props.contentContainerStyle,
        extraData: props.extraData,
        ListHeaderComponent: listHeaderComponent,
        renderItem,
        initialNumToRender: props.initialNumToRender,
        maxToRenderPerBatch: props.maxToRenderPerBatch,
        windowSize: props.windowSize,
        removeClippedSubviews: props.removeClippedSubviews,
        onLayout: props.onLayout,
        onContentSizeChange: props.onContentSizeChange,
        onScroll: props.onScroll,
        onScrollToIndexFailed: props.onScrollToIndexFailed,
        scrollEventThrottle: props.scrollEventThrottle,
        getItemLayout: props.getItemLayout,
    } satisfies React.ComponentProps<typeof FlatList<FilesystemBrowserListNode>>;

    if (Platform.OS !== 'web') {
        return (
            <FlashList
                {...sharedListProps}
                ref={props.listRef as React.Ref<FlashListRef<FilesystemBrowserListNode>>}
                estimatedItemSize={FILESYSTEM_BROWSER_ESTIMATED_ITEM_SIZE}
            />
        );
    }

    return (
        <FlatList
            {...sharedListProps}
            ref={props.listRef as React.Ref<FlatList<FilesystemBrowserListNode>>}
        />
    );
});
