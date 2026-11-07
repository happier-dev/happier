import * as React from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ViewToken } from 'react-native';
import { Pressable, View, Platform } from 'react-native';
import { usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';

import type { DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { usePierreDiffRendererPreload } from '@/components/ui/code/diff/pierre/pierreRendererLoader';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { PierreScrollRootVirtualizerProvider } from '@/components/ui/code/diff/pierre/PierreScrollRootVirtualizerProvider';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedViewportStyle';
import { Icon } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';
import { DiffFileActionsMenu } from './DiffFileActionsMenu';
import { Typography } from '@/constants/Typography';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { DiffViewerBaseProps } from './diffViewerTypes';
import { FindHighlightedText, sliceFindRanges } from '@/components/ui/text/FindHighlightedText';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { PaneHeaderScrollIsolation, usePaneHeaderScrollSink } from '@/components/appShell/panes/paneHeaderScroll';
import { useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';

export function diffFileDisplayPath(file: DiffFileEntry) {
    const { dir, name } = normalizeRepoPathParts({ fullPath: file.filePath ?? t('status.unknown') });
    return dir ? `${dir}/${name}` : name;
}

export function diffFileDisplayStats(file: DiffFileEntry) {
    return file.isComplete === false ? t('common.unavailable') : `+${file.added} -${file.removed}`;
}

export function diffFileDisplayKind(file: DiffFileEntry) {
    return file.kind === 'new' ? t('common.create') : file.kind === 'deleted' ? t('common.delete') : file.kind === 'renamed' ? t('common.rename') : null;
}

export type DiffFileFindState = Pick<DiffViewerBaseProps, 'findActive' | 'findRangesByLineId' | 'scrollToLineId'> & Readonly<{
    pathRanges?: readonly FindTextRange[];
    statsRanges?: readonly FindTextRange[];
    kindRanges?: readonly FindTextRange[];
    contextLines?: number;
}>;

const DIFF_FILE_ROW_ESTIMATED_ITEM_SIZE = 72;

type DiffFilesListViewRenderContext<TFile extends DiffFileEntry> = Readonly<{
    fileRowColor: string;
    rowHoverColor: string;
    controlColor: string;
    canRenderInlineDiffs: boolean;
    focusedFileKey: string | null;
    clearMeasurementCache: () => void;
    inlineDiffContainerVariant?: 'default' | 'none';
    maxVirtualizedHeight: number;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
    onToggleExpanded: (key: string) => void;
    renderBeforeFileRow?: DiffFilesListViewProps<TFile>['renderBeforeFileRow'];
    renderFileRow?: DiffFilesListViewProps<TFile>['renderFileRow'];
    getFindStateForFile?: DiffFilesListViewProps<TFile>['getFindStateForFile'];
    showLineNumbers: boolean;
    showPrefix: boolean;
    virtualizationByteThreshold: number;
    virtualizationLineThreshold: number;
    wrapLines: boolean;
}>;

type DiffFilesListViewItem<TFile extends DiffFileEntry> = Readonly<{
    key: string;
    file: TFile;
    expanded: boolean;
}>;

function InlineDiffBody<TFile extends DiffFileEntry>(props: Readonly<{
    rendererContext: React.Context<DiffFilesListViewProps<TFile>['renderInlineUnifiedDiff']>;
    input: Parameters<NonNullable<DiffFilesListViewProps<TFile>['renderInlineUnifiedDiff']>>[0];
    fallback: React.ReactNode;
    containerVariant: DiffFilesListViewProps<TFile>['inlineDiffContainerVariant'];
    virtualized: boolean;
}>) {
    const render = React.useContext(props.rendererContext);
    const content = render?.(props.input);
    if (content === null || content === undefined || content === false) return <>{props.fallback}</>;
    if (props.containerVariant === 'none') return <>{content}</>;
    return <View style={[styles.inlineDiffContainer, props.virtualized
        ? resolveInlineDiffVirtualizedViewportStyle(props.input.maxVirtualizedHeight) : null]}>{content}</View>;
}

/** A row drawn before the files in the list's own scroll (`leadingRows`); it holds no file index. */
type DiffFilesListLeadingItem = Readonly<{
    leading: true;
    key: string;
    index: number;
    render: ((index: number) => React.ReactNode) | undefined;
}>;
type DiffFilesListRow<TFile extends DiffFileEntry> = DiffFilesListViewItem<TFile> | DiffFilesListLeadingItem;
const isLeadingItem = <TFile extends DiffFileEntry,>(item: DiffFilesListRow<TFile>): item is DiffFilesListLeadingItem => 'leading' in item;

export type DiffFilesListViewHandle = Readonly<{
    clearMeasurementCache: () => void;
    scrollToIndex: (params: Readonly<{ index: number; animated?: boolean; viewPosition?: number; viewOffset?: number }>) => void;
    scrollToOffset: (params: Readonly<{ offset: number; animated?: boolean }>) => void;
}>;

type DiffFilesListVirtualizedListLayout = 'bounded' | 'intrinsic';

export type DiffFilesListViewProps<TFile extends DiffFileEntry = DiffFileEntry> = Readonly<{
    testID?: string;
    files: readonly TFile[];
    expandedKeys: ReadonlySet<string>;
    onToggleExpanded: (key: string) => void;
    canRenderInlineDiffs: boolean;
    wrapLines: boolean;
    showLineNumbers: boolean;
    showPrefix: boolean;
    virtualizeFileList?: boolean;
    virtualizedListLayout?: DiffFilesListVirtualizedListLayout;
    inlineDiffContainerVariant?: 'default' | 'none';
    ListHeaderComponent?: any;
    /**
     * Rows that read before the files in the same scroll (the Review's file index): virtualized with the
     * files, so a large inventory mounts only what is on screen. File indices (scrollToIndex, viewability,
     * render callbacks) stay in file space; `onViewableChange` says whether any of these rows is on screen.
     */
    leadingRows?: Readonly<{
        keys: readonly string[];
        render: (index: number) => React.ReactNode;
        /** A row's height before it is drawn, so offsets past unmeasured rows (a restored scroll, a far jump) hold. */
        estimatedSize?: (index: number) => number;
        onViewableChange?: (viewable: boolean) => void;
    }> | null;
    ListFooterComponent?: any;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    onLoad?: () => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onViewableItemsChanged?: (info: any) => void;
    scrollEventThrottle?: number;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
    drawDistanceMultiplier?: number;
    getFindStateForFile?: (file: TFile) => DiffFileFindState | undefined;
    renderBeforeFileRow?: (params: Readonly<{ file: TFile; index: number }>) => React.ReactNode;
    renderFileRow?: (params: Readonly<{
        file: TFile;
        index: number;
        expanded: boolean;
        focused: boolean;
        onToggleExpanded: () => void;
    }>) => React.ReactNode;
    renderInlineUnifiedDiff?: (params: Readonly<{
        file: TFile;
        virtualized: boolean;
        maxVirtualizedHeight: number;
        wrapLines: boolean;
        showLineNumbers: boolean;
        showPrefix: boolean;
        findState?: DiffFileFindState;
    }>) => React.ReactNode;
}>;

/** The gap between the file menu and the open-file button beside it. */
const OPEN_FILE_BUTTON_GAP_PX = 10;

/**
 * The open-file button keeps a raw pressable for the web-only double click (pins the tab), which the shared
 * pressable does not model; its hit area is still the shared owner's, sharing the gap to the file menu beside it.
 */
function OpenFileButton(props: Readonly<{
    testID: string;
    accessibilityLabel: string;
    onPress: () => void;
    onDoublePress: (() => void) | undefined;
    controlColor: string;
    hoverColor: string;
}>) {
    const hitArea = useHappierHitArea({
        restingStyle: () => styles.openFileButton,
        hitTarget: HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE,
        hitReach: { left: OPEN_FILE_BUTTON_GAP_PX / 2 },
    });
    const doubleClick = props.onDoublePress
        ? { onDoubleClick: (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            props.onDoublePress?.();
        } }
        : {};
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            onPress={props.onPress}
            {...doubleClick}
            style={(state) => {
                // RN Web exposes `hovered` in the Pressable state callback, but `react-native` types do not model it.
                const hovered = (state as { hovered?: boolean }).hovered === true;
                return [
                    styles.openFileButton,
                    { backgroundColor: props.controlColor },
                    hovered ? [styles.openFileButtonHovered, { backgroundColor: props.hoverColor }] : null,
                    state.pressed ? styles.openFileButtonPressed : null,
                ];
            }}
        >
            {hitArea.frame}
            <Icon name="file" size={14} color={styles.openFileIcon.color as string} />
        </Pressable>
    );
}

function DiffFilesListViewInner<TFile extends DiffFileEntry>(
    props: DiffFilesListViewProps<TFile>,
    ref: React.ForwardedRef<DiffFilesListViewHandle>,
) {
    const {
        testID,
        files,
        expandedKeys,
        onToggleExpanded,
        canRenderInlineDiffs,
        wrapLines,
        showLineNumbers,
        showPrefix,
        virtualizeFileList,
        inlineDiffContainerVariant,
        ListHeaderComponent,
        leadingRows,
        ListFooterComponent,
        onScroll,
        onLayout,
        onLoad,
        onContentSizeChange,
        onViewableItemsChanged,
        scrollEventThrottle,
        onOpenFile,
        onOpenFilePinned,
        drawDistanceMultiplier,
        renderBeforeFileRow,
        renderFileRow,
        renderInlineUnifiedDiff,
        getFindStateForFile,
    } = props;
    const virtualizedListLayout = props.virtualizedListLayout ?? 'bounded';
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const fileRowColor = paintColor(theme.colors.surface.inset);
    const rowHoverColor = paintColor(theme.colors.surface.elevated ?? theme.colors.surface.inset);
    const controlColor = paintColor(theme.colors.surface.elevated ?? theme.colors.surface.base);
    const shouldUseVirtualizedList = virtualizeFileList === true
        && !(virtualizedListLayout === 'intrinsic' && Platform.OS !== 'web');
    // A bounded list is the pane's scrolling body (a commit, a stash, a review): it drives the header's shade.
    // An intrinsic list sits inside other content (a transcript card, a Markdown block) and never does.
    const paneHeaderScroll = usePaneHeaderScrollSink();
    const paneHeaderSink = shouldUseVirtualizedList && virtualizedListLayout === 'bounded' ? paneHeaderScroll : null;
    const handleScroll = React.useMemo(() => paneHeaderSink === null ? onScroll
        : (event: NativeSyntheticEvent<NativeScrollEvent>) => {
            paneHeaderSink.reportTopDistance(event.nativeEvent.contentOffset.y);
            onScroll?.(event);
        }, [onScroll, paneHeaderSink]);
    // A list mounting in a retained tab starts at its top, whatever that tab's earlier body left.
    React.useLayoutEffect(() => { paneHeaderSink?.reportTopDistance(0); }, [paneHeaderSink]);
    const [focusedFileKey, setFocusedFileKey] = React.useState<string | null>(null);
    // Only expanded bodies consume renderer changes; the held inventory is independent of them.
    const [inlineRendererContext] = React.useState(() => React.createContext<DiffFilesListViewProps<TFile>['renderInlineUnifiedDiff']>(undefined));
    const listRef = React.useRef<VirtualizedListRef | null>(null);

    // The bodies this list draws arrive after it mounts: prepare their renderer now, while rows load.
    usePierreDiffRendererPreload(canRenderInlineDiffs);
    const { height: windowHeight } = usePresentationWindowDimensions();
    const { lineThreshold: virtualizationLineThreshold, byteThreshold: virtualizationByteThreshold } = useInlineDiffVirtualizationThresholds();

    const maxVirtualizedHeight = resolveInlineDiffVirtualizedMaxHeight(windowHeight);
    const drawDistance = React.useMemo(() => {
        const height = typeof windowHeight === 'number' && Number.isFinite(windowHeight) ? windowHeight : 0;
        const rawMultiplier = typeof drawDistanceMultiplier === 'number' && Number.isFinite(drawDistanceMultiplier)
            ? drawDistanceMultiplier
            : 2;
        const multiplier = Math.max(0.25, rawMultiplier);
        return Math.max(1, Math.floor(height * multiplier));
    }, [drawDistanceMultiplier, windowHeight]);

    // Expanded diff heights must not become the estimate for every collapsed
    // header: a large inventory can otherwise exceed the browser's scroll extent.
    // Leading rows (the Review index) are their own type, so their small measured height never becomes a file's estimate.
    const getItemType = React.useCallback((item: DiffFilesListRow<TFile>) => isLeadingItem(item) ? 'leading' : item.expanded ? 'expanded-file' : 'file', []);
    const virtualizedListStyle = React.useMemo(() => {
        const style: Record<string, unknown> = { flex: 1 };
        if (Platform.OS === 'web') {
            style.overflowAnchor = 'none';
        }
        return style;
    }, []);
    const virtualizedListContentContainerStyle = React.useMemo(() => ({ paddingBottom: 12 }), []);
    const keyExtractor = React.useCallback((item: DiffFilesListRow<TFile>) => item.key, []);

    const listItemCacheRef = React.useRef(new Map<string, DiffFilesListViewItem<TFile>>());
    const listData = React.useMemo(() => {
        const previous = listItemCacheRef.current;
        const next = new Map<string, DiffFilesListViewItem<TFile>>();
        const data = files.map((file) => {
            const key = file.key;
            const expanded = expandedKeys.has(key);
            const previousItem = previous.get(key);
            if (
                previousItem
                && previousItem.file === file
                && previousItem.expanded === expanded
            ) {
                next.set(key, previousItem);
                return previousItem;
            }
            const item = { key, file, expanded };
            next.set(key, item);
            return item;
        });
        listItemCacheRef.current = next;
        return data;
    }, [expandedKeys, files]);
    const leadingKeys = leadingRows?.keys;
    const renderLeadingRow = leadingRows?.render;
    const leadingItems = React.useMemo<readonly DiffFilesListLeadingItem[]>(
        () => (leadingKeys ?? []).map((key, index) => ({ leading: true, key: `leading:${key}`, index, render: renderLeadingRow })),
        [leadingKeys, renderLeadingRow],
    );
    const leadingCount = leadingItems.length;
    const estimateLeadingRow = leadingRows?.estimatedSize;
    const getEstimatedItemSize = React.useMemo(() => (estimateLeadingRow
        ? (item: DiffFilesListRow<TFile>) => (isLeadingItem(item) ? estimateLeadingRow(item.index) : undefined)
        : undefined), [estimateLeadingRow]);
    const leadingCountRef = React.useRef(leadingCount);
    leadingCountRef.current = leadingCount;
    const rows = React.useMemo<readonly DiffFilesListRow<TFile>[]>(
        () => (leadingCount === 0 ? listData : [...leadingItems, ...listData]),
        [leadingCount, leadingItems, listData],
    );

    const clearMeasurementCache = React.useCallback(() => {
        if (virtualizeFileList !== true) return;
        try {
            listRef.current?.clearMeasurementCache?.({ mode: 'sizes' });
        } catch {
            // ignore
        }
    }, [virtualizeFileList]);

    const scrollToIndex = React.useCallback((params: Readonly<{ index: number; animated?: boolean; viewPosition?: number; viewOffset?: number }>) => {
        try {
            listRef.current?.scrollToIndex?.({ ...params, index: params.index + leadingCountRef.current });
        } catch {
            // ignore
        }
    }, []);

    const scrollToOffset = React.useCallback((params: Readonly<{ offset: number; animated?: boolean }>) => {
        try {
            listRef.current?.scrollToOffset?.(params);
        } catch {
            // ignore
        }
    }, []);

    React.useImperativeHandle(
        ref,
        () => ({
            clearMeasurementCache,
            scrollToIndex,
            scrollToOffset,
        }),
        [clearMeasurementCache, scrollToIndex, scrollToOffset],
    );

    // Viewability reaches the consumer in file space; leading rows report only whether any is on screen.
    const viewabilityTargetsRef = React.useRef({ onViewableItemsChanged, onLeadingViewableChange: leadingRows?.onViewableChange });
    viewabilityTargetsRef.current = { onViewableItemsChanged, onLeadingViewableChange: leadingRows?.onViewableChange };
    const hasViewabilityConsumer = onViewableItemsChanged != null || leadingRows?.onViewableChange != null;
    const handleViewableItemsChanged = React.useCallback((info: { viewableItems: ViewToken[]; changed: ViewToken[] }) => {
        const targets = viewabilityTargetsRef.current;
        const count = leadingCountRef.current;
        if (count === 0) {
            targets.onViewableItemsChanged?.(info);
            return;
        }
        const toFileSpace = (tokens: readonly ViewToken[]) => tokens.flatMap((token) => (
            token.item && isLeadingItem(token.item as DiffFilesListRow<TFile>) ? []
                : [{ ...token, index: typeof token.index === 'number' ? token.index - count : token.index }]
        ));
        targets.onLeadingViewableChange?.(info.viewableItems.some((token) => token.isViewable && token.item && isLeadingItem(token.item as DiffFilesListRow<TFile>)));
        targets.onViewableItemsChanged?.({ viewableItems: toFileSpace(info.viewableItems), changed: toFileSpace(info.changed) });
    }, []);

    const renderContextRef = React.useRef<DiffFilesListViewRenderContext<TFile> | null>(null);
    renderContextRef.current = {
        fileRowColor, rowHoverColor, controlColor,
        canRenderInlineDiffs,
        focusedFileKey,
        clearMeasurementCache,
        inlineDiffContainerVariant,
        maxVirtualizedHeight,
        onOpenFile,
        onOpenFilePinned,
        onToggleExpanded,
        renderBeforeFileRow,
        renderFileRow,
        showLineNumbers,
        getFindStateForFile,
        showPrefix,
        virtualizationByteThreshold,
        virtualizationLineThreshold,
        wrapLines,
    };

    const listExtraData = React.useMemo(() => ({
        fileRowColor, rowHoverColor, controlColor,
        focusedFileKey,
        getFindStateForFile,
        canRenderInlineDiffs,
        inlineDiffContainerVariant,
        maxVirtualizedHeight,
        onOpenFile,
        onOpenFilePinned,
        onToggleExpanded,
        renderBeforeFileRow,
        renderFileRow,
        showLineNumbers,
        showPrefix,
        virtualizationByteThreshold,
        virtualizationLineThreshold,
        wrapLines,
    }), [
        fileRowColor, rowHoverColor, controlColor,
        focusedFileKey,
        getFindStateForFile,
        canRenderInlineDiffs,
        inlineDiffContainerVariant,
        maxVirtualizedHeight,
        onOpenFile,
        onOpenFilePinned,
        onToggleExpanded,
        renderBeforeFileRow,
        renderFileRow,
        showLineNumbers,
        showPrefix,
        virtualizationByteThreshold,
        virtualizationLineThreshold,
        wrapLines,
    ]);

    const renderFileNode = React.useCallback((item: DiffFilesListViewItem<TFile>, index: number) => {
        const ctx = renderContextRef.current;
        if (!ctx) return null;
        const { file, expanded } = item;
        const focused = ctx.focusedFileKey === file.key;
        const findState = ctx.getFindStateForFile?.(file);
        const statsText = diffFileDisplayStats(file);
        const addedTextLength = String(file.added).length + 1;
        const kindText = diffFileDisplayKind(file);
        const handleToggleExpanded = () => {
            // Expanded inline diffs have highly variable height. Invalidate the
            // canonical backend's size cache before the state change so the
            // current logical row remains the expansion anchor without leaving
            // a stale virtualizer buffer.
            ctx.clearMeasurementCache();
            ctx.onToggleExpanded(file.key);
        };
        const presentationStyleOverride =
            file.kind === 'new' || file.kind === 'deleted' || file.oldText === '' || file.newText === ''
                ? 'unified'
                : undefined;
        const hasInlineDiffPayload =
            typeof file.unifiedDiff === 'string'
            || (typeof file.oldText === 'string' && typeof file.newText === 'string');
        const inlineVirtualized = ctx.canRenderInlineDiffs && expanded && hasInlineDiffPayload
            ? resolveInlineDiffVirtualization({
                unifiedDiff: typeof file.unifiedDiff === 'string' ? file.unifiedDiff : null,
                oldText: typeof file.oldText === 'string' ? file.oldText : null,
                newText: typeof file.newText === 'string' ? file.newText : null,
                lineThreshold: ctx.virtualizationLineThreshold,
                byteThreshold: ctx.virtualizationByteThreshold,
            })
            : false;

        const inlineDiffRendererProps = {
            findState,
            file,
            virtualized: inlineVirtualized,
            maxVirtualizedHeight: ctx.maxVirtualizedHeight,
            wrapLines: ctx.wrapLines,
            showLineNumbers: ctx.showLineNumbers,
            showPrefix: ctx.showPrefix,
        };
        const inlineVirtualizedContainerStyle = inlineVirtualized
            ? resolveInlineDiffVirtualizedViewportStyle(ctx.maxVirtualizedHeight)
            : null;
        const fallbackInlineDiff =
            file.unifiedDiff ? (
                <View style={[styles.inlineDiffContainer, inlineVirtualizedContainerStyle]}>
                    <DiffViewer
                        findActive={findState?.findActive}
                        findRangesByLineId={findState?.findRangesByLineId}
                        scrollToLineId={findState?.scrollToLineId}
                        mode="unified"
                        filePath={file.filePath ?? null}
                        unifiedDiff={file.unifiedDiff}
                        wrapLines={ctx.wrapLines}
                        virtualized={inlineVirtualized}
                        presentationStyleOverride={presentationStyleOverride}
                        showLineNumbers={ctx.showLineNumbers}
                        showPrefix={ctx.showPrefix}
                    />
                </View>
            ) : file.oldText != null && file.newText != null ? (
                <View style={[styles.inlineDiffContainer, inlineVirtualizedContainerStyle]}>
                    <DiffViewer
                        findActive={findState?.findActive}
                        findRangesByLineId={findState?.findRangesByLineId}
                        scrollToLineId={findState?.scrollToLineId}
                        mode="text"
                        filePath={file.filePath ?? null}
                        oldText={file.oldText}
                        newText={file.newText}
                        contextLines={findState?.contextLines ?? 3}
                        wrapLines={ctx.wrapLines}
                        virtualized={inlineVirtualized}
                        presentationStyleOverride={presentationStyleOverride}
                        showLineNumbers={ctx.showLineNumbers}
                        showPrefix={ctx.showPrefix}
                    />
                </View>
            ) : null;

        return (
            <View>
                {ctx.renderBeforeFileRow ? ctx.renderBeforeFileRow({ file, index }) : null}

                {ctx.renderFileRow ? (
                    ctx.renderFileRow({ file, index, expanded, focused, onToggleExpanded: handleToggleExpanded })
                ) : (
                    <View
                        style={[
                            styles.fileRowContainer,
                            { backgroundColor: ctx.fileRowColor },
                            focused ? styles.fileRowFocused : null,
                        ]}
                    >
                        <Pressable
                            onPress={handleToggleExpanded}
                            onFocus={() => setFocusedFileKey(file.key)}
                            onBlur={() => setFocusedFileKey((prev) => (prev === file.key ? null : prev))}
                            style={(state) => {
                                const { pressed } = state;
                                // RN Web exposes `hovered` in the Pressable state callback, but `react-native` types do not model it.
                                const hovered = (state as { hovered?: boolean }).hovered === true;
                                return [
                                    styles.fileRowInteractive,
                                    hovered ? [styles.fileRowHovered, { backgroundColor: ctx.rowHoverColor }] : null,
                                    pressed ? styles.fileRowPressed : null,
                                ];
                            }}
                            accessibilityRole="button"
                        >
                            <View style={styles.fileRowMain}>
                                <DisclosureCaret expanded={expanded} size={12} />
                                <FileIcon fileName={file.filePath ?? ''} size={16} appearance="line" />
                                <InlineRepoPathLabel fullPath={diffFileDisplayPath(file)} preferNameOverPath align="start" pathTextStyle={styles.path} nameTextStyle={styles.filePath} findRanges={findState?.pathRanges} />
                                {file.kind ? (
                                    <View
                                        style={[
                                            styles.kindBadge,
                                            { backgroundColor: ctx.controlColor },
                                            file.kind === 'new'
                                                ? styles.kindBadgeNew
                                                : file.kind === 'deleted'
                                                    ? styles.kindBadgeDeleted
                                                    : styles.kindBadgeRenamed,
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.kindText,
                                                file.kind === 'new'
                                                    ? styles.kindTextNew
                                                    : file.kind === 'deleted'
                                                        ? styles.kindTextDeleted
                                                        : styles.kindTextRenamed,
                                            ]}
                                        >
                                            {findState?.kindRanges?.length ? <FindHighlightedText text={kindText ?? ''} ranges={findState.kindRanges} /> : kindText}
                                        </Text>
                                    </View>
                                ) : null}
                            </View>
                            <Text style={styles.statsText}>
                                {findState?.statsRanges?.length
                                    ? file.isComplete === false
                                        ? <FindHighlightedText text={statsText} ranges={findState.statsRanges} />
                                        : <><Text style={styles.added}><FindHighlightedText text={statsText.slice(0, addedTextLength)} ranges={sliceFindRanges(findState.statsRanges, 0, addedTextLength)} /></Text><FindHighlightedText text=" " ranges={sliceFindRanges(findState.statsRanges, addedTextLength, 1)} /><Text style={styles.removed}><FindHighlightedText text={statsText.slice(addedTextLength + 1)} ranges={sliceFindRanges(findState.statsRanges, addedTextLength + 1, String(file.removed).length + 1)} /></Text></>
                                    : file.isComplete === false ? statsText : <><Text style={styles.added}>{statsText.slice(0, addedTextLength)}</Text> <Text style={styles.removed}>{statsText.slice(addedTextLength + 1)}</Text></>}
                            </Text>
                        </Pressable>

                        {typeof file.filePath === 'string' ? <DiffFileActionsMenu filePath={file.filePath} /> : null}

                        {typeof file.filePath === 'string' && (ctx.onOpenFile || ctx.onOpenFilePinned) ? (
                            <OpenFileButton
                                testID={`diff-files-open:${file.key}`}
                                accessibilityLabel={t('session.detailsPanel.openTabA11y', { title: file.filePath })}
                                onPress={() => ctx.onOpenFile?.(file.filePath as string)}
                                onDoublePress={Platform.OS === 'web' && ctx.onOpenFilePinned ? () => ctx.onOpenFilePinned?.(file.filePath as string) : undefined}
                                controlColor={ctx.controlColor}
                                hoverColor={ctx.rowHoverColor}
                            />
                        ) : null}
                    </View>
                )}

                {ctx.canRenderInlineDiffs && expanded ? (
                    <InlineDiffBody rendererContext={inlineRendererContext} input={inlineDiffRendererProps}
                        fallback={fallbackInlineDiff} containerVariant={ctx.inlineDiffContainerVariant}
                        virtualized={inlineVirtualized} />
                ) : null}
            </View>
        );
    }, [inlineRendererContext]);
    const renderVirtualizedItem = React.useCallback(
        ({ item, index }: { item: DiffFilesListRow<TFile>; index: number }) => (isLeadingItem(item)
            ? <>{item.render?.(item.index) ?? null}</>
            : renderFileNode(item, index - leadingCountRef.current)),
        [renderFileNode],
    );

    return (
        // Nothing inside a diff list (inline viewers, their own scroll roots) speaks for the pane's header.
        <inlineRendererContext.Provider value={renderInlineUnifiedDiff}>
        <PaneHeaderScrollIsolation>
        <PierreScrollRootVirtualizerProvider>
            {shouldUseVirtualizedList ? (
                <VirtualizedList<DiffFilesListRow<TFile>>
                    ref={listRef}
                    testID={testID}
                    style={virtualizedListStyle}
                    data={rows}
                    keyExtractor={keyExtractor}
                    renderItem={renderVirtualizedItem}
                    contentContainerStyle={virtualizedListContentContainerStyle}
                    extraData={listExtraData}
                    estimatedItemSize={DIFF_FILE_ROW_ESTIMATED_ITEM_SIZE}
                    drawDistance={drawDistance}
                    getItemType={getItemType}
                    getEstimatedItemSize={getEstimatedItemSize}
                    ListHeaderComponent={ListHeaderComponent}
                    ListFooterComponent={ListFooterComponent}
                    onScroll={handleScroll}
                    onLayout={onLayout}
                    onLoad={onLoad}
                    onContentSizeChange={onContentSizeChange}
                    onViewableItemsChanged={hasViewabilityConsumer ? handleViewableItemsChanged : undefined}
                    scrollEventThrottle={scrollEventThrottle}
                />
            ) : (
                <View>
                    {ListHeaderComponent
                        ? (typeof ListHeaderComponent === 'function'
                            ? ListHeaderComponent()
                            : ListHeaderComponent)
                        : null}
                    {leadingItems.map((item) => (
                        <React.Fragment key={item.key}>{renderLeadingRow?.(item.index) ?? null}</React.Fragment>
                    ))}
                    {listData.map((item, index) => (
                        <React.Fragment key={item.key}>
                            {renderFileNode(item, index)}
                        </React.Fragment>
                    ))}
                    {ListFooterComponent
                        ? (typeof ListFooterComponent === 'function'
                            ? ListFooterComponent()
                            : ListFooterComponent)
                        : null}
                </View>
            )}
        </PierreScrollRootVirtualizerProvider>
        </PaneHeaderScrollIsolation>
        </inlineRendererContext.Provider>
    );
}

// forwardRef retains the file type shared by the data and its row renderers.
export const DiffFilesListView = React.forwardRef(DiffFilesListViewInner) as <TFile extends DiffFileEntry = DiffFileEntry>(
    props: DiffFilesListViewProps<TFile> & React.RefAttributes<DiffFilesListViewHandle>,
) => React.ReactElement;

const styles = StyleSheet.create((theme) => ({
    fileRowContainer: {
        flexDirection: 'row',
        alignItems: 'stretch',
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        marginBottom: 8,
        overflow: 'hidden',
        ...Platform.select({
            web: { cursor: 'pointer', overflowAnchor: 'none' } as any,
            default: null,
        }),
    },
    fileRowInteractive: {
        flex: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    fileRowHovered: {
        backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.inset,
    },
    fileRowPressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
    fileRowFocused: {
        borderColor: theme.colors.text.link ?? theme.colors.border.default,
    },
    fileRowMain: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    filePath: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
        flexShrink: 1,
        minWidth: 0,
    },
    path: { fontSize: 12, color: theme.colors.text.tertiary, ...Typography.default() },
    added: { color: theme.colors.diff.success },
    removed: { color: theme.colors.diff.error },
    statsText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'monospace',
    },
    openFileButton: {
        marginLeft: OPEN_FILE_BUTTON_GAP_PX,
        // The row's own horizontal inset, so the button sits inside its card instead of on the pane edge.
        marginRight: 12,
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.base,
        ...Platform.select({
            web: { cursor: 'pointer' } as any,
            default: null,
        }),
    },
    openFileButtonHovered: {
        backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.inset,
    },
    openFileButtonPressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
    openFileIcon: {
        color: theme.colors.text.secondary,
    },
    kindBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.base,
    },
    kindBadgeNew: {
        borderColor: theme.colors.state.success.foreground,
    },
    kindBadgeDeleted: {
        borderColor: theme.colors.state.danger.foreground ?? theme.colors.state.neutral.foreground,
    },
    kindBadgeRenamed: {
        borderColor: theme.colors.accent.indigo,
    },
    kindText: {
        fontSize: 11,
        fontWeight: '600',
        fontFamily: 'monospace',
    },
    kindTextNew: {
        color: theme.colors.state.success.foreground,
    },
    kindTextDeleted: {
        color: theme.colors.state.danger.foreground ?? theme.colors.state.neutral.foreground,
    },
    kindTextRenamed: {
        color: theme.colors.accent.indigo,
    },
    inlineDiffContainer: {
        marginBottom: 12,
        borderRadius: 10,
        overflow: 'hidden',
        ...Platform.select({
            web: { overflowAnchor: 'none' as any } as any,
            default: null,
        }),
    },
}));
