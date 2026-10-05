import type React from 'react';
import type { FlatListProps, StyleProp, ViewStyle } from 'react-native';

import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';

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
    treeRole?: boolean;
    rootLoading: boolean;
    showInlineLoadingHeader?: boolean;
    rootError: string | null;
    loadingLabel: string;
    inlineRetryLabel: string;
    listHeaderTestID?: string;
    /** Drawn after the last row, in the same scroll (the Git pane's timeline under its tree). */
    listFooter?: React.ReactElement | null;
    /**
     * `scroll` (default): a virtualized list that owns its scroll. `inline`: the rows drawn in place,
     * inside a scroll someone else owns (a turn card in the transcript), with no list or scroll of
     * their own. The caller bounds an inline tree by folding folders, never by dropping rows.
     */
    presentation?: 'scroll' | 'inline';
    renderRow: (input: FilesystemBrowserRowRenderInput) => React.ReactElement;
    retryRoot: () => void | Promise<void>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    style?: StyleProp<ViewStyle>;
    extraData?: unknown;
    initialNumToRender?: number;
    maxToRenderPerBatch?: number;
    windowSize?: number;
    removeClippedSubviews?: boolean;
    listRef?: React.Ref<VirtualizedListRef>;
    onLayout?: FlatListProps<FilesystemBrowserNode>['onLayout'];
    onContentSizeChange?: FlatListProps<FilesystemBrowserNode>['onContentSizeChange'];
    onScroll?: FlatListProps<FilesystemBrowserNode>['onScroll'];
    onScrollToIndexFailed?: FlatListProps<FilesystemBrowserNode>['onScrollToIndexFailed'];
    scrollEventThrottle?: number;
    getItemLayout?: FlatListProps<FilesystemBrowserNode>['getItemLayout'];
}>;
