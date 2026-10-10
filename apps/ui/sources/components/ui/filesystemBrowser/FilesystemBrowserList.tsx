import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { resolveFilesystemErrorReason } from './filesystemErrorReason';

import type { FilesystemBrowserListProps } from './filesystemBrowserTypes';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListProps } from '@/components/ui/lists/virtualized/virtualizedListTypes';

const FILESYSTEM_BROWSER_ESTIMATED_ITEM_SIZE = 38;
const FILESYSTEM_BROWSER_VIEWABILITY = { itemVisiblePercentThreshold: 0 } as const;
type FilesystemBrowserListNode = FilesystemBrowserListProps['nodes'][number];

export const FilesystemBrowserList = React.memo(function FilesystemBrowserList(props: FilesystemBrowserListProps): React.ReactElement {
    const { theme } = useUnistyles();
    const showRootLoadingHeader = props.rootLoading && props.showInlineLoadingHeader !== false && !props.listEmpty;
    const keyExtractor = React.useCallback((node: FilesystemBrowserListNode) => `${node.type}:${node.path}`, []);
    const statusHeader = React.useMemo(() => (
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
        ) : props.rootError && !props.listEmpty ? (
            <SurfaceStateCard
                testID={props.listHeaderTestID}
                size="line"
                kind="error"
                title={t('files.pane.rootErrorTitleUnnamed')}
                reason={props.rootErrorReason ?? resolveFilesystemErrorReason(props.rootError)}
                diagnosticCode={props.rootError}
                action={{ label: props.inlineRetryLabel, onPress: props.retryRoot }}
            />
        ) : null
    ), [props.inlineRetryLabel, props.listEmpty, props.listHeaderTestID, props.loadingLabel, props.retryRoot, props.rootError, props.rootErrorReason, showRootLoadingHeader, theme.colors.text.secondary]);
    const listHeaderComponent = React.useMemo(() => props.listHeader
        ? <>{props.listHeader}{statusHeader}</> : statusHeader, [props.listHeader, statusHeader]);
    const latestProps = React.useRef(props);
    latestProps.current = props;
    const visibleKeys = React.useRef<readonly string[]>([]);
    const onViewableItemsChanged = React.useCallback<NonNullable<VirtualizedListProps<FilesystemBrowserListNode>['onViewableItemsChanged']>>(({ viewableItems }) => {
        const current = latestProps.current;
        if (!current.onVisibleNodesChange) return;
        const visibleNodes = viewableItems.flatMap(token => {
            const node = token.index == null ? undefined : current.nodes[token.index];
            return token.isViewable && node && token.key === keyExtractor(node) ? [node] : [];
        });
        visibleKeys.current = visibleNodes.map(keyExtractor);
        current.onVisibleNodesChange(visibleNodes);
    }, [keyExtractor]);
    React.useEffect(() => {
        if (!props.onVisibleNodesChange) return;
        if (props.presentation === 'inline') {
            props.onVisibleNodesChange(props.nodes);
            return;
        }
        // A disclosure/reload can replace node objects while the viewport stays put.
        // Reconcile only the previously viewable keys, never demand the complete listing.
        const byKey = new Map(props.nodes.map(node => [keyExtractor(node), node]));
        props.onVisibleNodesChange(visibleKeys.current.flatMap(key => {
            const node = byKey.get(key);
            return node ? [node] : [];
        }));
    }, [keyExtractor, props.nodes, props.onVisibleNodesChange, props.presentation]);

    const renderItem = React.useCallback(({ item: node, index }: { item: FilesystemBrowserListNode; index: number }) => (
        props.renderRow({
            node,
            showDivider: index < props.nodes.length - 1,
        })
    ), [props.nodes.length, props.renderRow]);

    if (props.presentation === 'inline') {
        return (
            <View style={props.style} {...(Platform.OS === 'web' && props.treeRole ? { role: 'tree' as const } : {})}>
                {listHeaderComponent}
                {props.nodes.map((node, index) => (
                    <React.Fragment key={keyExtractor(node)}>{renderItem({ item: node, index })}</React.Fragment>
                ))}
                {props.nodes.length === 0 ? props.listEmpty : null}
                {props.listFooter ?? null}
            </View>
        );
    }

    // The virtualized abstraction owns the platform/backend choice; `auto`
    // resolves to the canonical Legend backend on every platform.
    const list = (
        <VirtualizedList<FilesystemBrowserListNode>
            data={props.nodes}
            keyExtractor={keyExtractor}
            style={props.style}
            contentContainerStyle={props.contentContainerStyle}
            extraData={props.extraData}
            ListHeaderComponent={listHeaderComponent}
            ListFooterComponent={props.listFooter ?? null}
            ListEmptyComponent={props.listEmpty ?? null}
            renderItem={renderItem}
            initialNumToRender={props.initialNumToRender}
            maxToRenderPerBatch={props.maxToRenderPerBatch}
            windowSize={props.windowSize}
            removeClippedSubviews={props.removeClippedSubviews}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            onScroll={props.onScroll}
            onViewableItemsChanged={props.onVisibleNodesChange ? onViewableItemsChanged : undefined}
            viewabilityConfig={FILESYSTEM_BROWSER_VIEWABILITY}
            onScrollToIndexFailed={props.onScrollToIndexFailed}
            scrollEventThrottle={props.scrollEventThrottle}
            getItemLayout={props.getItemLayout}
            estimatedItemSize={FILESYSTEM_BROWSER_ESTIMATED_ITEM_SIZE}
            ref={props.listRef}
        />
    );
    return props.treeRole ? (
        <View style={{ flex: 1, minHeight: 0 }} {...(Platform.OS === 'web' ? { role: 'tree' as const } : {})}>{list}</View>
    ) : list;
});
