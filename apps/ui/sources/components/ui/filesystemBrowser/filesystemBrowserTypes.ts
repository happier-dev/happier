import type React from 'react';
import type { FlatList, FlatListProps, StyleProp, ViewStyle } from 'react-native';

import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { FlashListRef } from '@/components/ui/lists/flashListCompat/FlashListCompat';

export type FilesystemBrowserNode = LazyDirectoryTreeNode;

export type FilesystemBrowserRowRenderInput = Readonly<{
    node: FilesystemBrowserNode;
    showDivider: boolean;
}>;

export type FilesystemBrowserWrapContentInput = Readonly<{
    node: FilesystemBrowserNode;
    content: React.ReactElement;
}>;

export type FilesystemBrowserListProps = Readonly<{
    nodes: readonly FilesystemBrowserNode[];
    rootLoading: boolean;
    showInlineLoadingHeader?: boolean;
    rootError: string | null;
    loadingLabel: string;
    inlineRetryLabel: string;
    listHeaderTestID?: string;
    renderRow: (input: FilesystemBrowserRowRenderInput) => React.ReactElement;
    retryRoot: () => void | Promise<void>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    style?: StyleProp<ViewStyle>;
    extraData?: unknown;
    initialNumToRender?: number;
    maxToRenderPerBatch?: number;
    windowSize?: number;
    removeClippedSubviews?: boolean;
    listRef?: React.Ref<FlatList<FilesystemBrowserNode> | FlashListRef<FilesystemBrowserNode>>;
    onLayout?: FlatListProps<FilesystemBrowserNode>['onLayout'];
    onContentSizeChange?: FlatListProps<FilesystemBrowserNode>['onContentSizeChange'];
    onScroll?: FlatListProps<FilesystemBrowserNode>['onScroll'];
    onScrollToIndexFailed?: FlatListProps<FilesystemBrowserNode>['onScrollToIndexFailed'];
    scrollEventThrottle?: number;
    getItemLayout?: FlatListProps<FilesystemBrowserNode>['getItemLayout'];
}>;
