import * as React from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Pressable, View, Platform, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';

import type { DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { PierreScrollRootVirtualizerProvider } from '@/components/ui/code/diff/pierre/PierreScrollRootVirtualizerProvider';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedViewportStyle';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';
import { DiffFileActionsMenu } from './DiffFileActionsMenu';
import { Typography } from '@/constants/Typography';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { DiffViewerBaseProps } from './diffViewerTypes';
import { FindHighlightedText, sliceFindRanges } from '@/components/ui/text/FindHighlightedText';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';

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

type DiffFilesListViewRenderContext = Readonly<{
    canRenderInlineDiffs: boolean;
    clearMeasurementCache: () => void;
    inlineDiffContainerVariant?: 'default' | 'none';
    maxVirtualizedHeight: number;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
    onToggleExpanded: (key: string) => void;
    renderBeforeFileRow?: DiffFilesListViewProps['renderBeforeFileRow'];
    renderFileRow?: DiffFilesListViewProps['renderFileRow'];
    renderInlineUnifiedDiff?: DiffFilesListViewProps['renderInlineUnifiedDiff'];
    getFindStateForFile?: DiffFilesListViewProps['getFindStateForFile'];
    showLineNumbers: boolean;
    showPrefix: boolean;
    virtualizationByteThreshold: number;
    virtualizationLineThreshold: number;
    wrapLines: boolean;
}>;

type DiffFilesListViewItem = Readonly<{
    key: string;
    file: DiffFileEntry;
    expanded: boolean;
    focused: boolean;
}>;

export type DiffFilesListViewHandle = Readonly<{
    clearMeasurementCache: () => void;
    scrollToIndex: (params: Readonly<{ index: number; animated?: boolean; viewPosition?: number; viewOffset?: number }>) => void;
    scrollToOffset: (params: Readonly<{ offset: number; animated?: boolean }>) => void;
}>;

type DiffFilesListVirtualizedListLayout = 'bounded' | 'intrinsic';

export type DiffFilesListViewProps = Readonly<{
    testID?: string;
    files: readonly DiffFileEntry[];
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
    ListFooterComponent?: any;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onViewableItemsChanged?: (info: any) => void;
    scrollEventThrottle?: number;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
    drawDistanceMultiplier?: number;
    getFindStateForFile?: (file: DiffFileEntry) => DiffFileFindState | undefined;
    renderBeforeFileRow?: (params: Readonly<{ file: DiffFileEntry; index: number }>) => React.ReactNode;
    renderFileRow?: (params: Readonly<{
        file: DiffFileEntry;
        index: number;
        expanded: boolean;
        focused: boolean;
        onToggleExpanded: () => void;
    }>) => React.ReactNode;
    renderInlineUnifiedDiff?: (params: Readonly<{
        file: DiffFileEntry;
        virtualized: boolean;
        maxVirtualizedHeight: number;
        wrapLines: boolean;
        showLineNumbers: boolean;
        showPrefix: boolean;
        findState?: DiffFileFindState;
    }>) => React.ReactNode;
}>;

export const DiffFilesListView = React.forwardRef<DiffFilesListViewHandle, DiffFilesListViewProps>(function DiffFilesListView(
    props,
    ref,
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
        ListFooterComponent,
        onScroll,
        onLayout,
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
    const shouldUseVirtualizedList = virtualizeFileList === true
        && !(virtualizedListLayout === 'intrinsic' && Platform.OS !== 'web');
    const [focusedFileKey, setFocusedFileKey] = React.useState<string | null>(null);
    const listRef = React.useRef<VirtualizedListRef | null>(null);

    const { height: windowHeight } = useWindowDimensions();
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

    const getItemType = React.useCallback(() => 'file', []);
    const virtualizedListStyle = React.useMemo(() => {
        const style: Record<string, unknown> = { flex: 1 };
        if (Platform.OS === 'web') {
            style.overflowAnchor = 'none';
        }
        return style;
    }, []);
    const virtualizedListContentContainerStyle = React.useMemo(() => ({ paddingBottom: 12 }), []);
    const keyExtractor = React.useCallback((item: DiffFilesListViewItem) => item.key, []);

    const listItemCacheRef = React.useRef(new Map<string, DiffFilesListViewItem>());
    const listData = React.useMemo(() => {
        const previous = listItemCacheRef.current;
        const next = new Map<string, DiffFilesListViewItem>();
        const data = files.map((file) => {
            const key = file.key;
            const expanded = expandedKeys.has(key);
            const focused = focusedFileKey === key;
            const previousItem = previous.get(key);
            if (
                previousItem
                && previousItem.file === file
                && previousItem.expanded === expanded
                && previousItem.focused === focused
            ) {
                next.set(key, previousItem);
                return previousItem;
            }
            const item = { key, file, expanded, focused };
            next.set(key, item);
            return item;
        });
        listItemCacheRef.current = next;
        return data;
    }, [expandedKeys, files, focusedFileKey]);

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
            listRef.current?.scrollToIndex?.(params);
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

    const renderContextRef = React.useRef<DiffFilesListViewRenderContext | null>(null);
    renderContextRef.current = {
        canRenderInlineDiffs,
        clearMeasurementCache,
        inlineDiffContainerVariant,
        maxVirtualizedHeight,
        onOpenFile,
        onOpenFilePinned,
        onToggleExpanded,
        renderBeforeFileRow,
        renderFileRow,
        renderInlineUnifiedDiff,
        showLineNumbers,
        getFindStateForFile,
        showPrefix,
        virtualizationByteThreshold,
        virtualizationLineThreshold,
        wrapLines,
    };

    const listExtraData = React.useMemo(() => ({
        getFindStateForFile,
        canRenderInlineDiffs,
        inlineDiffContainerVariant,
        maxVirtualizedHeight,
        onOpenFile,
        onOpenFilePinned,
        onToggleExpanded,
        renderBeforeFileRow,
        renderFileRow,
        renderInlineUnifiedDiff,
        showLineNumbers,
        showPrefix,
        virtualizationByteThreshold,
        virtualizationLineThreshold,
        wrapLines,
    }), [
        getFindStateForFile,
        canRenderInlineDiffs,
        inlineDiffContainerVariant,
        maxVirtualizedHeight,
        onOpenFile,
        onOpenFilePinned,
        onToggleExpanded,
        renderBeforeFileRow,
        renderFileRow,
        renderInlineUnifiedDiff,
        showLineNumbers,
        showPrefix,
        virtualizationByteThreshold,
        virtualizationLineThreshold,
        wrapLines,
    ]);

    const renderFileNode = React.useCallback((item: DiffFilesListViewItem, index: number) => {
        const ctx = renderContextRef.current;
        if (!ctx) return null;
        const { file, expanded, focused } = item;
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
        const customInlineDiff = ctx.canRenderInlineDiffs && expanded && ctx.renderInlineUnifiedDiff
            ? ctx.renderInlineUnifiedDiff(inlineDiffRendererProps)
            : null;
        const hasCustomInlineDiff = customInlineDiff !== null && customInlineDiff !== undefined && customInlineDiff !== false;
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
                                    hovered ? styles.fileRowHovered : null,
                                    pressed ? styles.fileRowPressed : null,
                                ];
                            }}
                            accessibilityRole="button"
                        >
                            <View style={styles.fileRowMain}>
                                <Icon name={expanded ? 'caret-down' : 'caret-right'} size={12} color={styles.filePath.color} />
                                <FileIcon fileName={file.filePath ?? ''} size={16} appearance="line" />
                                <InlineRepoPathLabel fullPath={diffFileDisplayPath(file)} preferNameOverPath pathTextStyle={styles.path} nameTextStyle={styles.filePath} findRanges={findState?.pathRanges} />
                                {file.kind ? (
                                    <View
                                        style={[
                                            styles.kindBadge,
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
                            <Pressable
                                testID={`diff-files-open:${file.key}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('session.detailsPanel.openTabA11y', { title: file.filePath })}
                                hitSlop={8}
                                onPress={() => ctx.onOpenFile?.(file.filePath as string)}
                                // @ts-expect-error - react-native types do not model web-only double click props; RN Web supports onDoubleClick.
                                onDoubleClick={
                                    Platform.OS === 'web' && ctx.onOpenFilePinned
                                        ? (event: any) => {
                                            event?.preventDefault?.();
                                            event?.stopPropagation?.();
                                            ctx.onOpenFilePinned?.(file.filePath as string);
                                        }
                                        : undefined
                                }
                                style={(state) => {
                                    const { pressed } = state;
                                    // RN Web exposes `hovered` in the Pressable state callback, but `react-native` types do not model it.
                                    const hovered = (state as { hovered?: boolean }).hovered === true;
                                    return [
                                        styles.openFileButton,
                                        hovered ? styles.openFileButtonHovered : null,
                                        pressed ? styles.openFileButtonPressed : null,
                                    ];
                                }}
                            >
                                <Icon name="file" size={14} color={styles.openFileIcon.color as any} />
                            </Pressable>
                        ) : null}
                    </View>
                )}

                {ctx.canRenderInlineDiffs && expanded ? (
                    hasCustomInlineDiff ? (
                        ctx.inlineDiffContainerVariant === 'none' ? (
                            <React.Fragment>{customInlineDiff}</React.Fragment>
                        ) : (
                            <View style={[styles.inlineDiffContainer, inlineVirtualizedContainerStyle]}>
                                {customInlineDiff}
                            </View>
                        )
                    ) : fallbackInlineDiff
                ) : null}
            </View>
        );
    }, []);
    const renderVirtualizedItem = React.useCallback(
        ({ item, index }: { item: DiffFilesListViewItem; index: number }) => renderFileNode(item, index),
        [renderFileNode],
    );

    return (
        <PierreScrollRootVirtualizerProvider>
            {shouldUseVirtualizedList ? (
                <VirtualizedList<DiffFilesListViewItem>
                    ref={listRef}
                    testID={testID}
                    style={virtualizedListStyle}
                    data={listData}
                    keyExtractor={keyExtractor}
                    renderItem={renderVirtualizedItem}
                    contentContainerStyle={virtualizedListContentContainerStyle}
                    extraData={listExtraData}
                    estimatedItemSize={DIFF_FILE_ROW_ESTIMATED_ITEM_SIZE}
                    drawDistance={drawDistance}
                    getItemType={getItemType}
                    ListHeaderComponent={ListHeaderComponent}
                    ListFooterComponent={ListFooterComponent}
                    onScroll={onScroll}
                    onLayout={onLayout}
                    onContentSizeChange={onContentSizeChange}
                    onViewableItemsChanged={onViewableItemsChanged}
                    scrollEventThrottle={scrollEventThrottle}
                />
            ) : (
                <View>
                    {ListHeaderComponent
                        ? (typeof ListHeaderComponent === 'function'
                            ? ListHeaderComponent()
                            : ListHeaderComponent)
                        : null}
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
    );
});

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
        marginLeft: 10,
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
