import type * as React from 'react';
import type { FlatListProps } from 'react-native';

import type { TranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

export type TranscriptListRendererOrientation = 'standard' | 'frame-resolved';

export type TranscriptListShellRef<TItem = unknown> = Readonly<{
    transcriptViewportCommandSpace?: 'native-inverted' | 'standard';
    scrollToIndex: (params: { index: number; animated?: boolean; viewOffset?: number; viewPosition?: number }) => void | Promise<void>;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void | Promise<void>;
    scrollToEnd?: (params?: { animated?: boolean }) => void | Promise<void>;
    clearLayoutCacheOnUpdate?: () => void;
    computeVisibleIndices?: () => { startIndex: number; endIndex: number };
    getAbsoluteLastScrollOffset?: () => number;
    getFirstVisibleIndex?: () => number;
    getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
}>;

type TranscriptListShellInteractionHandler = (event: unknown) => void;

export type TranscriptListShellPlatformInteractionProps = Readonly<{
    onMouseDown?: TranscriptListShellInteractionHandler;
    onPointerDown?: TranscriptListShellInteractionHandler;
    onTouchCancel?: TranscriptListShellInteractionHandler;
    onTouchEnd?: TranscriptListShellInteractionHandler;
    onTouchMove?: TranscriptListShellInteractionHandler;
    onTouchStart?: TranscriptListShellInteractionHandler;
    onWheel?: TranscriptListShellInteractionHandler;
}>;

export type TranscriptListRendererProps<TItem> = Readonly<{
    data: readonly TItem[];
    dataKey?: string;
    extraData?: unknown;
    keyExtractor: NonNullable<FlatListProps<TItem>['keyExtractor']>;
    getItemType?: (item: TItem, index: number, extraData?: unknown) => string | number | undefined;
    renderItem: NonNullable<FlatListProps<TItem>['renderItem']>;
    frame: TranscriptListShellFrame;
    overrideProps?: Record<string, unknown>;
    platformInteractionProps?: TranscriptListShellPlatformInteractionProps;
    onLoad?: (info: { elapsedTimeInMs: number }) => void;
    onCommitLayoutEffect?: () => void;
    onLayout?: FlatListProps<TItem>['onLayout'];
    onContentSizeChange?: FlatListProps<TItem>['onContentSizeChange'];
    onScroll?: FlatListProps<TItem>['onScroll'];
    onViewableItemsChanged?: FlatListProps<TItem>['onViewableItemsChanged'];
    viewabilityConfig?: FlatListProps<TItem>['viewabilityConfig'];
    onScrollBeginDrag?: FlatListProps<TItem>['onScrollBeginDrag'];
    onScrollEndDrag?: FlatListProps<TItem>['onScrollEndDrag'];
    onMomentumScrollBegin?: FlatListProps<TItem>['onMomentumScrollBegin'];
    onMomentumScrollEnd?: FlatListProps<TItem>['onMomentumScrollEnd'];
    onScrollToIndexFailed?: FlatListProps<TItem>['onScrollToIndexFailed'];
    onStartReachedThreshold?: number;
    onStartReached?: () => void;
    onEndReachedThreshold?: FlatListProps<TItem>['onEndReachedThreshold'];
    onEndReached?: FlatListProps<TItem>['onEndReached'];
    header?: React.ReactNode;
    footer?: React.ReactNode;
}>;

export type TranscriptListShellProps<TItem> = TranscriptListRendererProps<TItem> & Readonly<{
    olderLoadOverlay?: React.ReactNode;
    catchUpOverlay?: React.ReactNode;
    /**
     * Renderer-selection override from the host's canonical tuning source
     * (sync.getSyncTuning()). When omitted the shell resolver falls back to
     * loadSyncTuning() — same values at runtime, but hosts that read tuning
     * through the sync facade should thread it so tests and live overrides
     * flow through one path.
     */
    transcriptLegendListSpikeSurface?: 'off' | 'readOnly' | 'sidechain' | 'main' | 'flashList';
}>;

export type TranscriptListRendererComponent = <TItem>(
    props: TranscriptListRendererProps<TItem> & React.RefAttributes<TranscriptListShellRef<TItem>>,
) => React.ReactElement;

export type TranscriptListRenderer = Readonly<{
    kind: 'flashList' | 'legendList';
    orientation: TranscriptListRendererOrientation;
    Component: TranscriptListRendererComponent;
}>;
