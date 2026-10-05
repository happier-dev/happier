import React from 'react';
import { FlatList, Platform, View } from 'react-native';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import {
    resolveCodeLineRangeSelection,
    type CodeLineInteractionMode,
} from '@/components/ui/code/interactions/resolveCodeLineRangeSelection';

import { CodeLineRow, CODE_LINE_BASE_HEIGHT, type CodeLinePressEvent } from './CodeLineRow';
import { resolveEffectiveSyntaxHighlighting } from './resolveEffectiveSyntaxHighlighting';
import { CodeLinesReadingAnchor, type NativeCodeReadingAnchor } from './CodeLinesReadingAnchor';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';

export type CodeLinesExternalScrollView = Readonly<{
    scrollRef: React.RefObject<{ scrollTo: (options: { y: number; animated: boolean }) => void } | null>;
    contentRef?: React.RefObject<View | null>;
    viewportRef?: React.RefObject<View | null>;
    offsetRef: React.RefObject<number>;
}>;

function measureExternalLayout(
    owner: CodeLinesExternalScrollView,
    row: View,
    measured: (x: number, y: number, width: number, height: number) => void,
): void {
    const content = owner.contentRef?.current;
    if (content) {
        row.measureLayout(content, measured);
        return;
    }
    owner.viewportRef?.current?.measureInWindow((_x, viewportY) => {
        row.measureInWindow((x, y, width, height) => {
            measured(x, y - viewportY + owner.offsetRef.current, width, height);
        });
    });
}

export type CodeLinesViewProps = {
    lines: readonly CodeLine[];
    selectedLineIds?: ReadonlySet<string>;
    interactionMode?: CodeLineInteractionMode;
    rangeSelectionActive?: boolean;
    onPressLine?: (line: CodeLine, event?: CodeLinePressEvent) => void;
    onPressLineRange?: (lines: readonly CodeLine[]) => void;
    pressLineWhenNotSelectable?: boolean;
    onPressAddComment?: (line: CodeLine) => void;
    isCommentActive?: (line: CodeLine) => boolean;
    renderAfterLine?: (line: CodeLine) => React.ReactNode;
    showInactiveCommentAffordance?: boolean;
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
    wrapLines?: boolean;
    virtualized?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    scrollToLineId?: string;
    /** Inline native viewers delegate measured targets to their enclosing scroll owner. */
    onScrollToLine?: (windowY: number) => void;
    externalScrollView?: CodeLinesExternalScrollView;
    highlightLineId?: string;
    highlightLineIds?: ReadonlySet<string>;
    findRangesByLineId?: ReadonlyMap<string, readonly FindTextRange[]>;
    testID?: string;
    onLayout?: (e: any) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScroll?: (e: any) => void;
    scrollEventThrottle?: number;
};

type InlineToken = Readonly<{ text: string; color: string }>;
type PreventableEvent = Readonly<{
    preventDefault?: () => void;
    nativeEvent?: Readonly<{ preventDefault?: () => void }>;
}>;

const EMPTY_LINE_ID_SET: ReadonlySet<string> = new Set();
const VIRTUALIZED_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
const LIST_FOOTER_STYLE = { height: 16 } as const;

function preventNativeTextSelection(event?: PreventableEvent): void {
    event?.preventDefault?.();
    event?.nativeEvent?.preventDefault?.();
}

export function CodeLinesViewCore(
    props: CodeLinesViewProps & Readonly<{
        getAdvancedTokens?: (index: number) => readonly InlineToken[] | null | undefined;
        advancedTokensRevision?: number;
    }>
) {
    const lineRefs = React.useRef(new Map<string, View>());
    const externalRowLayouts = React.useRef(new Map<string, { y: number; height: number }>());
    const measureExternalRow = React.useCallback((id: string) => {
        const owner = props.externalScrollView;
        const row = lineRefs.current.get(id);
        if (Platform.OS === 'web' || !owner || !row) return;
        measureExternalLayout(owner, row, (_x, y, _width, height) => {
            if (lineRefs.current.get(id) === row) externalRowLayouts.current.set(id, { y, height });
        });
    }, [props.externalScrollView]);
    const lineNativeIdPrefix = React.useId();
    const completedScrollTarget = React.useRef<string | null>(null);
    const contentRef = React.useRef<View | null>(null);
    const nativeReadingAnchor = React.useRef<NativeCodeReadingAnchor | null>(null);
    const pendingReadingScroll = React.useRef<NativeCodeReadingAnchor | null>(null);
    const nativeScrollOffset = React.useRef(0);
    const readingLinesRef = React.useRef(props.lines);
    readingLinesRef.current = props.lines;
    const measureNativeReadingAnchor = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        const anchor = nativeReadingAnchor.current;
        if (!anchor) return;
        const lines = readingLinesRef.current;
        const line = lines[anchor.index];
        const row = line ? lineRefs.current.get(line.id) : null;
        const scrollView = listRef.current?.getNativeScrollRef?.();
        if (!row || !scrollView || !('measureInWindow' in scrollView)) return;
        scrollView.measureInWindow((_x, viewportY) => {
            row.measureInWindow((_rowX, rowY) => {
                if (nativeReadingAnchor.current !== anchor || readingLinesRef.current !== lines) return;
                nativeReadingAnchor.current = { index: anchor.index, offset: rowY - viewportY };
            });
        });
    }, []);
    const onViewableItemsChanged = React.useCallback(({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
        const index = viewableItems.find((item) => item.index !== null)?.index;
        if (index !== undefined && index !== null) {
            nativeReadingAnchor.current = { index, offset: 0 };
            measureNativeReadingAnchor();
        }
    }, [measureNativeReadingAnchor]);
    const selected = props.selectedLineIds ?? EMPTY_LINE_ID_SET;
    const paddingHorizontal = props.contentPaddingHorizontal ?? 0;
    const paddingVertical = props.contentPaddingVertical ?? 0;
    const wrapLines = props.wrapLines ?? true;
    const virtualized = props.virtualized ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const showPrefix = props.showPrefix ?? true;
    const advancedTokensRevision = props.advancedTokensRevision ?? 0;
    const interactionMode = props.interactionMode ?? 'read';
    const onPressLine = props.onPressLine;
    const onPressLineRange = props.onPressLineRange;
    const rangeSelectionActive = props.rangeSelectionActive;
    const rangeGesturesEnabled = interactionMode !== 'read' && typeof onPressLineRange === 'function';
    const lastPressedLineIdRef = React.useRef<string | null>(null);
    const explicitRangeStartLineIdRef = React.useRef<string | null>(null);
    const dragStartLineIdRef = React.useRef<string | null>(null);
    const dragCurrentLineIdRef = React.useRef<string | null>(null);

    const effectiveSyntaxHighlighting = React.useMemo(() => {
        return resolveEffectiveSyntaxHighlighting({ lines: props.lines, config: props.syntaxHighlighting });
    }, [props.lines, props.syntaxHighlighting]);

    const isHighlighted = React.useCallback((lineId: string) => {
        return props.highlightLineId === lineId || props.highlightLineIds?.has(lineId) === true;
    }, [props.highlightLineId, props.highlightLineIds]);

    const resolveRange = React.useCallback((startLineId: string, endLineId: string): readonly CodeLine[] => {
        return resolveCodeLineRangeSelection({
            lines: props.lines,
            startLineId,
            endLineId,
            includeLine: (line) => !line.renderIsHeaderLine,
        });
    }, [props.lines]);

    const completeRange = React.useCallback((startLineId: string, endLineId: string) => {
        const range = resolveRange(startLineId, endLineId);
        if (range.length === 0) return;
        onPressLineRange?.(range);
    }, [onPressLineRange, resolveRange]);

    const handlePressLine = React.useCallback((line: CodeLine, event?: CodeLinePressEvent) => {
        if (!rangeGesturesEnabled) {
            lastPressedLineIdRef.current = line.id;
            onPressLine?.(line, event);
            return;
        }

        if (rangeSelectionActive === true) {
            const startLineId = explicitRangeStartLineIdRef.current;
            if (!startLineId) {
                explicitRangeStartLineIdRef.current = line.id;
                lastPressedLineIdRef.current = line.id;
                return;
            }
            explicitRangeStartLineIdRef.current = null;
            lastPressedLineIdRef.current = line.id;
            completeRange(startLineId, line.id);
            return;
        }

        const shiftPressed = event?.shiftKey === true || event?.nativeEvent?.shiftKey === true;
        const startLineId = lastPressedLineIdRef.current;
        if (shiftPressed && startLineId) {
            lastPressedLineIdRef.current = line.id;
            completeRange(startLineId, line.id);
            return;
        }

        lastPressedLineIdRef.current = line.id;
        onPressLine?.(line, event);
    }, [completeRange, onPressLine, rangeGesturesEnabled, rangeSelectionActive]);

    const handlePressInLine = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        if (!rangeGesturesEnabled || Platform.OS !== 'web') return;
        preventNativeTextSelection(event);
        dragStartLineIdRef.current = line.id;
        dragCurrentLineIdRef.current = line.id;
    }, [rangeGesturesEnabled]);

    const handleHoverLine = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        if (!rangeGesturesEnabled || Platform.OS !== 'web') return;
        if (!dragStartLineIdRef.current) return;
        preventNativeTextSelection(event);
        dragCurrentLineIdRef.current = line.id;
    }, [rangeGesturesEnabled]);

    const handlePressOutLine = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        if (!rangeGesturesEnabled || Platform.OS !== 'web') return;
        preventNativeTextSelection(event);
        const startLineId = dragStartLineIdRef.current;
        const endLineId = dragCurrentLineIdRef.current ?? line.id;
        dragStartLineIdRef.current = null;
        dragCurrentLineIdRef.current = null;
        if (!startLineId || startLineId === endLineId) return;
        completeRange(startLineId, endLineId);
    }, [completeRange, rangeGesturesEnabled]);

    const renderLine = React.useCallback((item: CodeLine, index: number) => (
        <View
            collapsable={false}
            nativeID={`${lineNativeIdPrefix}-${item.id}`}
            onLayout={props.externalScrollView ? () => measureExternalRow(item.id) : undefined}
            ref={(node) => {
                if (node) lineRefs.current.set(item.id, node);
                else lineRefs.current.delete(item.id);
            }}
        >
            <CodeLineRow
                line={item}
                selected={selected.has(item.id)}
                highlighted={isHighlighted(item.id)}
                findRanges={props.findRangesByLineId?.get(item.id)}
                onPressLine={handlePressLine}
                onPressInLine={rangeGesturesEnabled && Platform.OS === 'web' ? handlePressInLine : undefined}
                onHoverLine={rangeGesturesEnabled && Platform.OS === 'web' ? handleHoverLine : undefined}
                onPressOutLine={rangeGesturesEnabled && Platform.OS === 'web' ? handlePressOutLine : undefined}
                pressLineWhenNotSelectable={props.pressLineWhenNotSelectable}
                onPressAddComment={props.onPressAddComment}
                commentActive={props.isCommentActive ? props.isCommentActive(item) : false}
                showInactiveCommentAffordance={props.showInactiveCommentAffordance}
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPrefix={showPrefix}
                syntaxHighlighting={effectiveSyntaxHighlighting}
                advancedTokens={effectiveSyntaxHighlighting.mode === 'advanced' ? (props.getAdvancedTokens?.(index) ?? undefined) : undefined}
            />
            {props.renderAfterLine ? props.renderAfterLine(item) : null}
        </View>
    ), [
        lineNativeIdPrefix,
        measureExternalRow,
        props.externalScrollView,
        props.findRangesByLineId,
        effectiveSyntaxHighlighting,
        handleHoverLine,
        handlePressInLine,
        handlePressLine,
        handlePressOutLine,
        isHighlighted,
        props.getAdvancedTokens,
        props.isCommentActive,
        props.onPressAddComment,
        props.pressLineWhenNotSelectable,
        props.renderAfterLine,
        props.showInactiveCommentAffordance,
        rangeGesturesEnabled,
        selected,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    const renderItem = React.useCallback(({ item, index }: { item: CodeLine; index: number }) => {
        return renderLine(item, index);
    }, [renderLine]);

    const contentContainerStyle = React.useMemo(() => ({
        paddingHorizontal,
        paddingVertical,
    }), [paddingHorizontal, paddingVertical]);

    const listFooterComponent = React.useMemo(() => <View style={LIST_FOOTER_STYLE} />, []);

    const listRef = React.useRef<FlatList<CodeLine> | null>(null);

    const scrollIndex = React.useMemo(() => {
        const id = props.scrollToLineId;
        if (!id) return -1;
        return props.lines.findIndex((l) => l.id === id);
    }, [props.lines, props.scrollToLineId]);

    const estimatedRowHeight = CODE_LINE_BASE_HEIGHT;
    const currentFindRange = props.scrollToLineId
        ? props.findRangesByLineId?.get(props.scrollToLineId)?.find((range) => range.current)
        : undefined;
    // Two occurrences can share a line. Their range is the navigation identity, while equivalent
    // decoration refreshes retain the completed target and leave manual reading scroll untouched.
    const scrollTargetKey = props.scrollToLineId
        ? JSON.stringify([props.scrollToLineId, currentFindRange?.start ?? null, currentFindRange?.end ?? null])
        : null;

    const getItemLayout = React.useCallback((_: unknown, index: number) => {
        // A best-effort constant-height layout to make scroll-to-index reliable on React Native Web.
        // If a line wraps, the offset can be slightly off, but the highlight still guides the user.
        return {
            length: estimatedRowHeight,
            offset: estimatedRowHeight * index,
            index,
        };
    }, [estimatedRowHeight]);

    React.useEffect(() => {
        const targetId = props.scrollToLineId;
        if (!targetId) {
            completedScrollTarget.current = null;
            return;
        }
        if (scrollIndex < 0 || completedScrollTarget.current === scrollTargetKey) return;
        const firstLineId = props.lines[0]?.id ?? null;

        let cancelled = false;

        const tryScrollIntoView = (): boolean => {
            if (typeof document === 'undefined') return false;
            // React Native Web maps `nativeID` to DOM `id`.
            const el = (document as any)?.getElementById?.(`${lineNativeIdPrefix}-${targetId}`);
            if (!el) return false;
            if (typeof el.scrollIntoView !== 'function') return false;
            try {
                el.scrollIntoView({ block: 'center' });
                return true;
            } catch {
                return false;
            }
        };

        const tryScrollDomOffset = (): boolean => {
            if (typeof document === 'undefined') return false;
            const doc: any = document as any;
            const fallbackAnchor = doc?.getElementById?.(`${lineNativeIdPrefix}-${targetId}`)
                ?? (firstLineId ? doc?.getElementById?.(`${lineNativeIdPrefix}-${firstLineId}`) : null);
            if (!fallbackAnchor) return false;

            let el = fallbackAnchor.parentElement;
            let steps = 0;
            while (el && steps < 30) {
                const overflowY = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function')
                    ? window.getComputedStyle(el).overflowY
                    : null;
                const overflowOk = overflowY ? (overflowY === 'auto' || overflowY === 'scroll') : true;
                if (overflowOk && el.scrollHeight > el.clientHeight + 5) {
                    const top = estimatedRowHeight * scrollIndex;
                    try {
                        if (typeof el.scrollTo === 'function') {
                            el.scrollTo({ top });
                        } else {
                            el.scrollTop = top;
                        }
                    } catch {
                        try {
                            el.scrollTop = estimatedRowHeight * scrollIndex;
                        } catch {
                            // ignore
                        }
                    }
                    return true;
                }
                el = el.parentElement;
                steps++;
            }

            return false;
        };

        const attemptScroll = () => {
            if (cancelled) return;
            pendingReadingScroll.current = null;
            pendingReadingScroll.current = null;
            if (!virtualized && typeof document === 'undefined') {
                const row = lineRefs.current.get(targetId);
                const owner = props.externalScrollView;
                if (row && owner) {
                    measureExternalLayout(owner, row, (_x, y) => {
                        if (cancelled) return;
                        const scrollY = Math.max(0, y);
                        completedScrollTarget.current = scrollTargetKey;
                        owner.offsetRef.current = scrollY;
                        owner.scrollRef.current?.scrollTo({ y: scrollY, animated: true });
                    });
                    return;
                }
                if (!props.onScrollToLine) return;
                row?.measureInWindow((_x, y) => {
                    if (cancelled) return;
                    completedScrollTarget.current = scrollTargetKey;
                    props.onScrollToLine?.(y);
                });
                return;
            }
            // Defer until after layout to avoid "no item at index" on first paint.
            try {
                if (listRef.current) {
                    listRef.current.scrollToIndex({ index: scrollIndex, viewPosition: 0.25, animated: true });
                    completedScrollTarget.current = scrollTargetKey;
                }
            } catch {
                // ignore
            }
            // React Native Web sometimes fails to forward FlatList refs; fall back to DOM scrollTop.
            const offsetScrolled = tryScrollDomOffset();
            if (tryScrollIntoView() || offsetScrolled) completedScrollTarget.current = scrollTargetKey;
        };

        let attempts = 0;
        let timer: any = null;
        const tick = () => {
            attempts += 1;
            attemptScroll();
            if (cancelled) return;
            // Retry briefly to catch layout + virtualization rendering on web.
            if (attempts < 6 && typeof document !== 'undefined') {
                timer = setTimeout(tick, 50);
            }
        };

        timer = setTimeout(tick, 0);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [estimatedRowHeight, lineNativeIdPrefix, props.lines, props.externalScrollView, props.onScrollToLine, props.scrollToLineId, scrollTargetKey, scrollIndex, virtualized]);

    // FlatList is a PureComponent: when behavior depends on props outside `data`, we must provide `extraData`
    // to ensure rows get re-rendered. This matters for "selected" state and inline review-comment composers.
    const listExtraData = React.useMemo(() => ({
        selectedLineIds: props.selectedLineIds,
        renderAfterLine: props.renderAfterLine,
        onPressLine: handlePressLine,
        onPressInLine: rangeGesturesEnabled && Platform.OS === 'web' ? handlePressInLine : undefined,
        onHoverLine: rangeGesturesEnabled && Platform.OS === 'web' ? handleHoverLine : undefined,
        onPressOutLine: rangeGesturesEnabled && Platform.OS === 'web' ? handlePressOutLine : undefined,
        interactionMode,
        rangeSelectionActive: props.rangeSelectionActive,
        onPressLineRange: props.onPressLineRange,
        pressLineWhenNotSelectable: props.pressLineWhenNotSelectable,
        onPressAddComment: props.onPressAddComment,
        isCommentActive: props.isCommentActive,
        showInactiveCommentAffordance: props.showInactiveCommentAffordance,
        wrapLines,
        showLineNumbers,
        showPrefix,
        syntaxHighlighting: effectiveSyntaxHighlighting,
        highlightLineId: props.highlightLineId,
        highlightLineIds: props.highlightLineIds,
        findRangesByLineId: props.findRangesByLineId,
        advancedTokensRevision,
    } as const), [
        effectiveSyntaxHighlighting,
        advancedTokensRevision,
        handleHoverLine,
        handlePressInLine,
        handlePressLine,
        handlePressOutLine,
        interactionMode,
        rangeGesturesEnabled,
        props.highlightLineId,
        props.highlightLineIds,
        props.findRangesByLineId,
        props.isCommentActive,
        props.onPressAddComment,
        props.onPressLineRange,
        props.pressLineWhenNotSelectable,
        props.showInactiveCommentAffordance,
        props.rangeSelectionActive,
        props.renderAfterLine,
        props.selectedLineIds,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    const preserveReadingAnchor = (children: React.ReactNode) => (
        <CodeLinesReadingAnchor
            lines={props.lines}
            viewId={lineNativeIdPrefix}
            scrollToLineId={props.scrollToLineId}
            getRoot={() => virtualized ? listRef.current?.getNativeScrollRef?.() : contentRef.current}
            nativeAnchor={Platform.OS === 'web' ? undefined : nativeReadingAnchor}
            getNativeAnchor={!virtualized && props.externalScrollView ? (lines) => {
                const scrollY = props.externalScrollView!.offsetRef.current;
                const first = lines[0] ? externalRowLayouts.current.get(lines[0].id) : null;
                // Inline siblings share one viewport: only its top passage owns restoration.
                if (!first || scrollY < first.y) return null;
                const index = lines.findIndex((line) => {
                    const layout = externalRowLayouts.current.get(line.id);
                    return layout !== undefined && layout.y + layout.height > scrollY;
                });
                const layout = index >= 0 ? externalRowLayouts.current.get(lines[index].id) : null;
                return layout ? { index, offset: layout.y - scrollY } : null;
            } : undefined}
            scrollToIndex={virtualized ? (index, offset) => {
                pendingReadingScroll.current = { index, offset };
                const lines = props.lines;
                const target = lines[index];
                const row = target ? lineRefs.current.get(target.id) : null;
                const scrollView = listRef.current?.getNativeScrollRef?.();
                if (Platform.OS !== 'web' && row && scrollView && 'measureInWindow' in scrollView) {
                    scrollView.measureInWindow((_x, viewportY) => {
                        row.measureInWindow((_rowX, rowY) => {
                            if (readingLinesRef.current !== lines) return;
                            const nextOffset = Math.max(0, nativeScrollOffset.current + rowY - viewportY - offset);
                            nativeScrollOffset.current = nextOffset;
                            listRef.current?.scrollToOffset({ offset: nextOffset, animated: false });
                        });
                    });
                } else {
                    listRef.current?.scrollToIndex({ index, viewOffset: offset, animated: false });
                }
            } : props.externalScrollView ? (index, offset) => {
                const owner = props.externalScrollView;
                const line = props.lines[index];
                const row = line ? lineRefs.current.get(line.id) : null;
                if (!owner || !row || !line) return;
                measureExternalLayout(owner, row, (_x, y, _width, height) => {
                    if (readingLinesRef.current !== props.lines) return;
                    externalRowLayouts.current.set(line.id, { y, height });
                    const scrollY = Math.max(0, y - offset);
                    owner.offsetRef.current = scrollY;
                    owner.scrollRef.current?.scrollTo({ y: scrollY, animated: false });
                });
            } : undefined}
        >
            {children}
        </CodeLinesReadingAnchor>
    );

    if (!virtualized) {
        return preserveReadingAnchor(
            <View ref={contentRef} style={{ paddingHorizontal, paddingVertical }}>
                {props.lines.map((line, index) => (
                    <React.Fragment key={line.id}>
                        {renderLine(line, index)}
                    </React.Fragment>
                ))}
                <View style={{ height: 16 }} />
            </View>
        );
    }

    return preserveReadingAnchor(
        <FlatList
            ref={(node) => {
                // react-test-renderer does not provide a stable ref object; we store it manually.
                listRef.current = node as any;
            }}
            data={props.lines as CodeLine[]}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            extraData={listExtraData}
            testID={props.testID}
            style={VIRTUALIZED_LIST_STYLE}
            disableVirtualization={!virtualized}
            initialScrollIndex={scrollIndex >= 0 ? scrollIndex : undefined}
            getItemLayout={wrapLines ? undefined : getItemLayout}
            contentContainerStyle={contentContainerStyle}
            ListFooterComponent={listFooterComponent}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            onViewableItemsChanged={onViewableItemsChanged}
            onScroll={(event) => {
                nativeScrollOffset.current = event.nativeEvent.contentOffset.y;
                measureNativeReadingAnchor();
                props.onScroll?.(event);
            }}
            scrollEventThrottle={props.scrollEventThrottle}
            onScrollToIndexFailed={(info) => {
                const readingTarget = pendingReadingScroll.current?.index === info.index ? pendingReadingScroll.current : null;
                pendingReadingScroll.current = null;
                // Best-effort retry: FlatList can fail if measurement hasn't completed yet.
                try {
                    listRef.current?.scrollToOffset({
                        offset: info.averageItemLength * info.index - (readingTarget?.offset ?? 0),
                        animated: !readingTarget,
                    });
                } catch {
                    // ignore
                }
                setTimeout(() => {
                    try {
                        listRef.current?.scrollToIndex(readingTarget
                            ? { index: info.index, viewOffset: readingTarget.offset, animated: false }
                            : { index: info.index, viewPosition: 0.25, animated: true });
                    } catch {
                        // ignore
                    }
                }, 50);
            }}
        />
    );
}
