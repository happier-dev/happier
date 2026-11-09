import React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { VirtualizedList, type VirtualizedListRef } from '@/components/ui/lists/virtualized';
import type { SharedValue } from 'react-native-reanimated';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { codeLineScrollTargetKey } from '@/components/ui/code/model/codeLineScrollTargetKey';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import {
    resolveCodeLineRangeSelection,
    type CodeLineInteractionMode,
} from '@/components/ui/code/interactions/resolveCodeLineRangeSelection';

import { CodeLineRow, CODE_LINE_BASE_HEIGHT, type CodeLineDiagnosticRange, type CodeLinePressEvent } from './CodeLineRow';
import { resolveEffectiveSyntaxHighlighting } from './resolveEffectiveSyntaxHighlighting';
import { CodeLinesReadingAnchor, type NativeCodeReadingAnchor } from './CodeLinesReadingAnchor';
import { retainCodeLineLanding, scrollCodeLineIntoView } from './scrollCodeLineIntoView';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { Rect } from '../editor/codeEditorTypes';
import { CODE_GUTTER_METRICS } from '../editor/codeEditorFontMetrics';
import { readCodeTextPointer } from '../interactions/codeTextDom';
import { resolveCodeTokenPress } from '../interactions/codeTokenPress';
import { resolveAgentWashColor, resolveCodeSelectionColor } from '../editor/editorTheme';
import { EditorAgentCaret } from '@/components/ui/motion/EditorAgentCaret';
import { useCodeTextSelectionPaint } from './useCodeTextSelectionPaint';
import { DiffLeadingContent } from '@/components/ui/code/diff/happier/DiffLeadingContent';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { useCodeLinesSemanticTokens, type CodeLinesSemanticBinding } from './useCodeLinesSemanticTokens';
import { findVerticalScroller } from './readCodeViewReadingLine';
import { FindBarBandContext } from '@/components/ui/find/FindBarPlacement';
import { fireAndForget } from '@/utils/system/fireAndForget';

// The list projects global decorations into row-local props. Unchanged code rows retain
// their text/token tree when Find moves to another row in the same file.
const MemoizedCodeLineRow = React.memo(CodeLineRow);

/**
 * What renders under a line (an inline comment composer, a saved comment) spans the visible code column and
 * holds still while unwrapped code scrolls sideways, as change rows do, so its actions stay at the pane edge.
 */
function renderPinnedAfterLine(node: React.ReactNode, inset: number): React.ReactNode {
    return node === null || node === undefined || node === false ? null : <DiffLeadingContent inset={inset}>{node}</DiffLeadingContent>;
}

export type CodeLinesExternalScrollView = Readonly<{
    scrollRef: React.RefObject<{ scrollTo: (options: { y: number; animated: boolean }) => void } | null>;
    contentRef?: React.RefObject<View | null>;
    viewportRef?: React.RefObject<View | null>;
    offsetRef: React.RefObject<number>;
    getViewport?: () => Readonly<{ offset: number; height: number }>;
    subscribeViewport?: (listener: () => void) => () => void;
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

export type CodeLinesAgentPresence = Readonly<{
    startLine: number;
    endLine: number;
    agentId: string | null;
    agentName: string;
    reducedMotion: boolean;
}>;

/** The wash and the caret for one region; the caret element is made once per region so it arrives once. */
function useCodeLinesAgentPresence(presence: CodeLinesAgentPresence | null | undefined, washColor: string) {
    const previousEndLine = React.useRef<number | null>(null);
    const endLine = presence?.endLine ?? null;
    const caret = React.useMemo(() => {
        if (!presence) return null;
        const from = previousEndLine.current;
        const travelFromPx = from !== null && from !== presence.endLine ? (from - presence.endLine) * CODE_LINE_BASE_HEIGHT : undefined;
        return <EditorAgentCaret key={presence.endLine} agentId={presence.agentId} agentName={presence.agentName}
            lineHeight={CODE_LINE_BASE_HEIGHT} travelFromPx={travelFromPx} reducedMotion={presence.reducedMotion} />;
        // A new caret per region; its name and mark follow the presence it was made for.
    }, [presence?.endLine, presence?.agentId, presence?.agentName, presence?.reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (endLine !== null) previousEndLine.current = endLine; }, [endLine]);
    return React.useMemo(() => presence ? {
        startLine: presence.startLine, endLine: presence.endLine, washColor, caret,
    } : null, [caret, presence?.startLine, presence?.endLine, washColor]); // eslint-disable-line react-hooks/exhaustive-deps
}

function agentPresenceCovers(presence: Readonly<{ startLine: number; endLine: number }> | null, line: CodeLine): boolean {
    return presence !== null && typeof line.newLine === 'number' && line.kind !== 'remove' && !line.renderIsHeaderLine
        && line.newLine >= presence.startLine && line.newLine <= presence.endLine;
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
    /**
     * A lane before the line numbers, one cell per line (Blame's run column). The cell sits outside the
     * line's own press target, so it can be its own control; it stretches to the line's wrapped height.
     */
    renderLeadingLane?: (line: CodeLine) => React.ReactNode;
    /** Content above the first line, inside this view's scroller (the diff's `leadingContent`). */
    listHeader?: React.ReactNode;
    showInactiveCommentAffordance?: boolean;
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
    /** Extra room under the last line (a phone sheet over the code), so any line can scroll above it. */
    contentPaddingBottom?: number;
    wrapLines?: boolean;
    virtualized?: boolean;
    showLineNumbers?: boolean;
    lineNumberDigits?: number;
    reviewLaneWidth?: number;
    showPrefix?: boolean;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    /** Full source before folding; grammar state and token budgets follow the source, not its visible projection. */
    syntaxHighlightingLines?: readonly CodeLine[];
    scrollToLineId?: string;
    /** A new explicit request may revisit the same line (Track Resume). Equal requests retain the reader's scroll. */
    scrollToLineRequestId?: number;
    scrollToLineAlignment?: 'start';
    onRememberReadingLine?: (line: number) => void;
    /** Inline native viewers delegate measured targets to their enclosing scroll owner. */
    onScrollToLine?: (windowY: number) => void;
    externalScrollView?: CodeLinesExternalScrollView;
    highlightLineId?: string;
    highlightLineIds?: ReadonlySet<string>;
    reviewedLineIds?: ReadonlySet<string>;
    /**
     * The agent writing in this file now (P5 Track): new-side lines `startLine..endLine` carry the ink wash and the
     * agent caret stands after `endLine`. It jumps per region and travels from the last one.
     */
    agentPresence?: CodeLinesAgentPresence | null;
    /** An agent's write landing while you read (P3-R8): these lines take the add tint, faded by `opacity`. */
    liveTint?: Readonly<{ lineIds: ReadonlySet<string>; opacity: SharedValue<number> }>;
    findRangesByLineId?: ReadonlyMap<string, readonly FindTextRange[]>;
    intelligence?: Readonly<{
        /** `rect` is the pointed line's box at the pointer (window space), for anchoring a card. */
        onPointerToken: (lineId: string, offset16: number, rect: Rect | null, newLine: number) => void;
        /** Modifier-click (desktop) or a plain tap (touch, outside a selection). */
        /** True only when the canonical identifier owner accepted the press; otherwise ordinary line selection wins. */
        onActivateToken: (lineId: string, offset16: number, activation: Readonly<{ via: 'modifier' | 'touch'; rect: Rect | null }>, newLine: number) => boolean;
        /** The pointer left code text (whitespace past a line's end, the gutter, outside the view). */
        onPointerAway?: () => void;
        /** The file's problems by 1-based file line (squiggles on new-side lines), from the page's language answers. */
        diagnosticsByNewLine?: ReadonlyMap<number, readonly CodeLineDiagnosticRange[]>;
        semantic?: CodeLinesSemanticBinding;
    }>;
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

/** `data-code-line-kind/-old/-new` on each row: the one DOM fact selection readers use (`diffTextSelection`). */
function codeLineDomDataSet(line: CodeLine): Readonly<Record<string, string>> {
    return {
        codeLineKind: line.kind,
        ...(line.oldLine !== null ? { codeLineOld: String(line.oldLine) } : {}),
        ...(line.newLine !== null ? { codeLineNew: String(line.newLine) } : {}),
    };
}
const VIRTUALIZED_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
const LIST_FOOTER_STYLE = { height: 16 } as const;

type CodePointerEvent = Readonly<{
    target?: unknown;
    clientX?: number;
    clientY?: number;
    metaKey?: boolean;
    ctrlKey?: boolean;
    pointerType?: string;
    nativeEvent?: Readonly<{ clientX?: number; clientY?: number; metaKey?: boolean; ctrlKey?: boolean; pointerType?: string }>;
}>;

function resolvePointerToken(event: CodePointerEvent, lines: ReadonlyMap<string, CodeLine>) {
    if (typeof document === 'undefined') return null;
    const target = event.target;
    if (!target || typeof target !== 'object' || !('closest' in target) || typeof target.closest !== 'function') return null;
    const code = target.closest('[data-code-text]') as Element | null;
    const id = code?.getAttribute('data-code-text');
    const line = id ? lines.get(id) : null;
    if (!code || !line || line.renderIsHeaderLine || line.newLine === null || line.kind === 'remove' || !line.renderCodeText.trim()) return null;
    const x = event.clientX ?? event.nativeEvent?.clientX;
    const y = event.clientY ?? event.nativeEvent?.clientY;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    const pointer = readCodeTextPointer(code, x, y);
    return pointer ? { lineId: line.id, newLine: line.newLine, offset16: Math.min(line.renderCodeText.length, pointer.offset16), rect: pointer.rect } : null;
}

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
    const { theme } = useUnistyles();
    const semantic = useCodeLinesSemanticTokens(props.intelligence?.semantic, props.lines);
    useCodeTextSelectionPaint(resolveCodeSelectionColor(theme.colors.accent.blue));
    const agentPresence = useCodeLinesAgentPresence(props.agentPresence, resolveAgentWashColor(theme));
    const lineRefs = React.useRef(new Map<string, View>());
    const externalRowLayouts = React.useRef(new Map<string, { y: number; height: number }>());
    const refreshExternalSemanticViewport = useEventCallback(() => {
        if (!props.intelligence?.semantic?.enabled) return;
        const viewport = props.externalScrollView?.getViewport?.();
        if (!viewport || viewport.height <= 0) return;
        semantic.onVisibleIndices(props.lines.flatMap((line, index) => {
            const layout = externalRowLayouts.current.get(line.id);
            return layout && layout.y + layout.height > viewport.offset && layout.y < viewport.offset + viewport.height ? [index] : [];
        }));
    });
    const measureExternalRow = React.useCallback((id: string) => {
        const owner = props.externalScrollView;
        const row = lineRefs.current.get(id);
        if (Platform.OS === 'web' || !owner || !row) return;
        measureExternalLayout(owner, row, (_x, y, _width, height) => {
            if (lineRefs.current.get(id) === row) {
                externalRowLayouts.current.set(id, { y, height });
            }
        });
    }, [props.externalScrollView]);
    const lineNativeIdPrefix = React.useId();
    const completedScrollTarget = React.useRef<string | null>(null);
    const stopRetainedLanding = React.useRef<ReturnType<typeof retainCodeLineLanding> | null>(null);
    const pendingTargetLanding = React.useRef<((retryBootstrap?: boolean) => void) | null>(null);
    const contentRef = React.useRef<View | null>(null);
    const nativeReadingAnchor = React.useRef<NativeCodeReadingAnchor | null>(null);
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
        const scrollView = listRef.current?.getNativeScrollRef?.() as View | null | undefined;
        if (!row || !scrollView || !('measureInWindow' in scrollView)) return;
        scrollView.measureInWindow((_x, viewportY) => {
            row.measureInWindow((_rowX, rowY) => {
                if (nativeReadingAnchor.current !== anchor || readingLinesRef.current !== lines) return;
                nativeReadingAnchor.current = { index: anchor.index, offset: rowY - viewportY };
            });
        });
    }, []);
    const onViewableItemsChanged = React.useCallback(({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
        semantic.onVisibleIndices(viewableItems.flatMap(item => item.index === null ? [] : [item.index]));
        const index = viewableItems.find((item) => item.index !== null)?.index;
        if (index !== undefined && index !== null) {
            nativeReadingAnchor.current = { index, offset: 0 };
            measureNativeReadingAnchor();
        }
    }, [measureNativeReadingAnchor, semantic.onVisibleIndices]);
    const selected = props.selectedLineIds ?? EMPTY_LINE_ID_SET;
    const paddingHorizontal = props.contentPaddingHorizontal ?? 0;
    const paddingVertical = props.contentPaddingVertical ?? 0;
    // An open inline Find bar floats over the top of this view: line 1 starts below its band, and a
    // landing never puts the current line inside it. Views with an external scroll owner are inline
    // passages of a longer page, so only a view that owns its scroller keeps the band.
    const findBarBandPx = React.useContext(FindBarBandContext);
    const findBandPx = props.externalScrollView ? 0 : findBarBandPx;
    const paddingTop = Math.max(paddingVertical, findBandPx);
    const paddingBottom = paddingVertical + (props.contentPaddingBottom ?? 0);
    const wrapLines = props.wrapLines ?? true;
    const virtualized = props.virtualized ?? true;
    React.useEffect(() => {
        if (virtualized || !props.intelligence?.semantic?.enabled) return;
        if (Platform.OS !== 'web') {
            refreshExternalSemanticViewport();
            return props.externalScrollView?.subscribeViewport?.(refreshExternalSemanticViewport);
        }
        if (typeof IntersectionObserver === 'undefined' || !(contentRef.current instanceof HTMLElement)) return;
        const visible = new Set<number>();
        const indices = new Map<Element, number>();
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const index = indices.get(entry.target);
                if (index === undefined) continue;
                if (entry.isIntersecting) visible.add(index); else visible.delete(index);
            }
            semantic.onVisibleIndices([...visible]);
        }, { root: findVerticalScroller(contentRef.current) });
        props.lines.forEach((line, index) => {
            const row = lineRefs.current.get(line.id);
            if (row instanceof Element) { indices.set(row, index); observer.observe(row); }
        });
        return () => observer.disconnect();
    }, [virtualized, props.intelligence?.semantic?.enabled, props.lines, props.externalScrollView, refreshExternalSemanticViewport, semantic.onVisibleIndices]);
    const showLineNumbers = props.showLineNumbers ?? true;
    const lineNumberDigits = React.useMemo(() => Math.max(props.lineNumberDigits ?? 1, props.lines.reduce(
        (digits, line) => Math.max(digits, String(Math.max(line.oldLine ?? 0, line.newLine ?? 0)).length), 1,
    )), [props.lineNumberDigits, props.lines]);
    const reviewLaneWidth = React.useMemo(() => props.reviewLaneWidth ?? (
        props.onPressAddComment && (props.showInactiveCommentAffordance !== false || props.lines.some(line => props.isCommentActive?.(line)))
            ? CODE_GUTTER_METRICS.reviewLaneWidth : 0
    ), [props.reviewLaneWidth, props.onPressAddComment, props.showInactiveCommentAffordance, props.lines, props.isCommentActive]);
    const showPrefix = props.showPrefix ?? true;
    const advancedTokensRevision = props.advancedTokensRevision ?? 0;
    const interactionMode = props.interactionMode ?? 'read';
    const onPressLine = props.onPressLine;
    const onPressLineRange = props.onPressLineRange;
    const rangeSelectionActive = props.rangeSelectionActive;
    const rangeGesturesEnabled = interactionMode !== 'read' && typeof onPressLineRange === 'function';
    const intelligenceEnabled = props.intelligence !== undefined;
    const intelligenceLines = React.useMemo(() => intelligenceEnabled
        ? new Map(props.lines.map((line) => [line.id, line])) : null, [intelligenceEnabled, props.lines]);
    const onPointerToken = props.intelligence?.onPointerToken;
    const onActivateToken = props.intelligence?.onActivateToken;
    const onPointerAway = props.intelligence?.onPointerAway;
    const diagnosticsByNewLine = props.intelligence?.diagnosticsByNewLine;
    const handlePointerMove = React.useCallback((event: CodePointerEvent) => {
        if ((event.pointerType ?? event.nativeEvent?.pointerType) === 'touch') return;
        const token = intelligenceLines ? resolvePointerToken(event, intelligenceLines) : null;
        if (token) onPointerToken?.(token.lineId, token.offset16, token.rect, token.newLine);
        else onPointerAway?.();
    }, [intelligenceLines, onPointerAway, onPointerToken]);
    // Resolve while the touch still targets the code, but commit through the row's Pressability click.
    // Opening a sheet on pointerup retargets that touch's compatibility click to its dismiss layer.
    const pendingTouchToken = React.useRef<ReturnType<typeof resolvePointerToken>>(null);
    const handleTokenTouch = React.useCallback((event: CodePointerEvent) => {
        pendingTouchToken.current = null;
        if ((event.pointerType ?? event.nativeEvent?.pointerType) !== 'touch') return;
        if (typeof window !== 'undefined' && window.getSelection?.()?.isCollapsed === false) return;
        const token = intelligenceLines ? resolvePointerToken(event, intelligenceLines) : null;
        if (!token || !onActivateToken) return;
        pendingTouchToken.current = token;
    }, [intelligenceLines, onActivateToken]);
    // Native rows resolve a tap themselves (tap-to-name); they report no anchor rect.
    const onRowActivateToken = useEventCallback((lineId: string, offset16: number) => {
        const newLine = intelligenceLines?.get(lineId)?.newLine;
        return rangeSelectionActive !== true && typeof newLine === 'number'
            && onActivateToken?.(lineId, offset16, { via: 'touch', rect: null }, newLine) === true;
    });
    const intelligenceEvents = Platform.OS === 'web' && props.intelligence
        ? { onPointerMove: handlePointerMove, onPointerLeave: onPointerAway } : {};
    // Resolve touch coordinates in capture; the row's real press owns both touch and modifier activation.
    const tokenTouchRef = React.useRef(handleTokenTouch);
    tokenTouchRef.current = handleTokenTouch;
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !intelligenceEnabled || typeof document === 'undefined') return;
        const rowSelector = `[id^="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(lineNativeIdPrefix) : lineNativeIdPrefix}-"]`;
        const owns = (target: EventTarget | null) => {
            const element = target as Partial<Pick<Element, 'closest'>> | null;
            return typeof element?.closest === 'function' && element.closest(rowSelector) !== null;
        };
        const onPointerUp = (event: PointerEvent) => { if (owns(event.target)) tokenTouchRef.current(event as unknown as CodePointerEvent); };
        const clearTouch = () => { pendingTouchToken.current = null; };
        document.addEventListener('pointerdown', clearTouch, true);
        document.addEventListener('pointercancel', clearTouch, true);
        document.addEventListener('pointerup', onPointerUp, true);
        return () => {
            document.removeEventListener('pointerdown', clearTouch, true);
            document.removeEventListener('pointercancel', clearTouch, true);
            document.removeEventListener('pointerup', onPointerUp, true);
        };
    }, [intelligenceEnabled, lineNativeIdPrefix]);
    const lastPressedLineIdRef = React.useRef<string | null>(null);
    const explicitRangeStartLineIdRef = React.useRef<string | null>(null);
    const selectAnchorLineIdRef = React.useRef<string | null>(null);
    const dragStartLineIdRef = React.useRef<string | null>(null);
    const dragCurrentLineIdRef = React.useRef<string | null>(null);

    const syntaxLines = props.syntaxHighlightingLines ?? props.lines;
    const effectiveSyntaxHighlighting = React.useMemo(() => {
        return resolveEffectiveSyntaxHighlighting({ lines: syntaxLines, config: props.syntaxHighlighting });
    }, [syntaxLines, props.syntaxHighlighting]);

    // A landed line (a link's path:line, Go to definition) keeps the current-line band until the reader
    // takes over: presses into the code or scrolls the line away. A new landing bands again.
    const landedHighlight: unknown = props.highlightLineId ? props.highlightLineIds ?? props.highlightLineId : null;
    const [releasedHighlight, setReleasedHighlight] = React.useState<unknown>(null);
    const highlightReleased = landedHighlight !== null && releasedHighlight === landedHighlight;
    const releaseLandedHighlight = useEventCallback(() => {
        if (landedHighlight !== null && releasedHighlight !== landedHighlight) setReleasedHighlight(landedHighlight);
    });
    const isHighlighted = React.useCallback((lineId: string) => {
        if (highlightReleased) return false;
        return props.highlightLineId === lineId || props.highlightLineIds?.has(lineId) === true;
    }, [highlightReleased, props.highlightLineId, props.highlightLineIds]);

    const resolveRange = useEventCallback((startLineId: string, endLineId: string): readonly CodeLine[] => {
        return resolveCodeLineRangeSelection({
            lines: props.lines,
            startLineId,
            endLineId,
            includeLine: (line) => !line.renderIsHeaderLine,
        });
    });

    const completeRange = React.useCallback((startLineId: string, endLineId: string) => {
        const range = resolveRange(startLineId, endLineId);
        if (range.length === 0) return;
        onPressLineRange?.(range);
    }, [onPressLineRange, resolveRange]);

    const handlePressLine = useEventCallback((line: CodeLine, event?: CodeLinePressEvent) => {
        releaseLandedHighlight();
        const touch = pendingTouchToken.current;
        pendingTouchToken.current = null;
        // RN-web presses can carry either a React event or the DOM event itself (keyboard release).
        const pressEvent = event?.nativeEvent ?? event;
        const via = pressEvent ? resolveCodeTokenPress(pressEvent, touch?.lineId === line.id, rangeSelectionActive === true) : null;
        const token = via === 'touch' ? touch : via === 'modifier' && event && pressEvent && intelligenceLines
            ? resolvePointerToken({ target: event.target, nativeEvent: pressEvent }, intelligenceLines) : null;
        if (via && token && onActivateToken?.(token.lineId, token.offset16, { via, rect: token.rect }, token.newLine) === true) {
            return;
        }
        if (!rangeGesturesEnabled) {
            lastPressedLineIdRef.current = line.id;
            onPressLine?.(line, event);
            return;
        }

        if (interactionMode === 'selectRange') {
            const anchorLineId = selectAnchorLineIdRef.current;
            if (!anchorLineId || selected.size === 0) return;
            if (anchorLineId === line.id && selected.size === 1) {
                selectAnchorLineIdRef.current = null;
                onPressLineRange?.([]);
                return;
            }
            completeRange(anchorLineId, line.id);
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
    });

    const handleLongPressLine = React.useCallback((line: CodeLine) => {
        pendingTouchToken.current = null;
        if (interactionMode === 'selectRange') {
            selectAnchorLineIdRef.current = line.id;
            completeRange(line.id, line.id);
            return;
        }
        handlePressLine(line);
    }, [completeRange, handlePressLine, interactionMode]);

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
            // A text selection inside the row reads its line from here (Ask about a selection, web).
            {...(Platform.OS === 'web' ? { dataSet: codeLineDomDataSet(item) } : {})}
            onLayout={props.externalScrollView || item.id === props.scrollToLineId ? () => {
                measureExternalRow(item.id);
                if (item.id === props.scrollToLineId) pendingTargetLanding.current?.();
            } : undefined}
            ref={(node) => {
                if (node) lineRefs.current.set(item.id, node);
                else lineRefs.current.delete(item.id);
            }}
        >
            {/* A blanked header (a review separator with no hidden lines) keeps only its slot below. */}
            {item.renderIsHeaderLine && item.renderCodeText === '' ? null : <MemoizedCodeLineRow
                line={item}
                lineNumberDigits={lineNumberDigits}
                reviewLaneWidth={reviewLaneWidth}
                leadingLane={props.renderLeadingLane?.(item)}
                selected={selected.has(item.id)}
                highlighted={isHighlighted(item.id)}
                reviewed={props.reviewedLineIds?.has(item.id) === true}
                liveTintOpacity={props.liveTint?.lineIds.has(item.id) ? props.liveTint.opacity : undefined}
                agentWash={agentPresenceCovers(agentPresence, item) ? agentPresence?.washColor : undefined}
                agentCaret={agentPresence && agentPresenceCovers(agentPresence, item) && item.newLine === agentPresence.endLine ? agentPresence.caret : undefined}
                findRanges={props.findRangesByLineId?.get(item.id)}
                diagnostics={item.kind !== 'remove' && typeof item.newLine === 'number' ? diagnosticsByNewLine?.get(item.newLine) : undefined}
                semanticTokens={item.kind === 'file' && item.newLine !== null ? semantic.tokens?.get(item.newLine) : undefined}
                onActivateToken={onActivateToken ? onRowActivateToken : undefined}
                onPressLine={handlePressLine}
                onLongPressLine={rangeGesturesEnabled ? handleLongPressLine : undefined}
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
            />}
            {props.renderAfterLine ? renderPinnedAfterLine(props.renderAfterLine(item), paddingHorizontal * 2) : null}
        </View>
    ), [
        lineNumberDigits,
        reviewLaneWidth,
        lineNativeIdPrefix,
        measureExternalRow,
        props.externalScrollView,
        props.scrollToLineId,
        props.findRangesByLineId,
        diagnosticsByNewLine,
        semantic.tokens,
        onActivateToken,
        onRowActivateToken,
        effectiveSyntaxHighlighting,
        handleHoverLine,
        handleLongPressLine,
        handlePressInLine,
        handlePressLine,
        handlePressOutLine,
        isHighlighted,
        props.reviewedLineIds,
        props.liveTint,
        agentPresence,
        props.getAdvancedTokens,
        props.isCommentActive,
        props.onPressAddComment,
        props.pressLineWhenNotSelectable,
        props.renderAfterLine,
        paddingHorizontal,
        props.renderLeadingLane,
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
        paddingTop,
        paddingBottom,
    }), [paddingHorizontal, paddingTop, paddingBottom]);

    const listFooterComponent = React.useMemo(() => <View style={LIST_FOOTER_STYLE} />, []);

    const listRef = React.useRef<VirtualizedListRef | null>(null);

    const scrollIndex = React.useMemo(() => {
        const id = props.scrollToLineId;
        if (!id) return -1;
        return props.lines.findIndex((l) => l.id === id);
    }, [props.lines, props.scrollToLineId]);

    const estimatedRowHeight = CODE_LINE_BASE_HEIGHT;
    // Two occurrences can share a line. Their range is the navigation identity, while equivalent
    // decoration refreshes retain the completed target and leave manual reading scroll untouched.
    const scrollTargetKey = codeLineScrollTargetKey(props.scrollToLineId, props.scrollToLineId ? props.findRangesByLineId?.get(props.scrollToLineId) : undefined, props.scrollToLineRequestId);

    const hasListHeader = props.listHeader !== undefined && props.listHeader !== null;
    const listHeaderComponent = React.useMemo(() => hasListHeader ? (
        <View>
            {props.listHeader}
        </View>
    ) : null, [hasListHeader, props.listHeader]);

    React.useEffect(() => () => {
        stopRetainedLanding.current?.();
        stopRetainedLanding.current = null;
    }, [scrollTargetKey, scrollIndex < 0]);

    React.useEffect(() => {
        const targetId = props.scrollToLineId;
        if (!targetId) {
            completedScrollTarget.current = null;
            return;
        }
        if (scrollIndex < 0 || completedScrollTarget.current === scrollTargetKey) return;

        let cancelled = false;

        const tryScrollIntoView = (): boolean => {
            if (typeof document === 'undefined') return false;
            // React Native Web maps `nativeID` to DOM `id`.
            const el = document.getElementById(`${lineNativeIdPrefix}-${targetId}`);
            try {
                // A sheet over the bottom of the page (`contentPaddingBottom`) is not a place to land: the row
                // lands in the upper third of the part still visible.
                const landed = scrollCodeLineIntoView(el, props.scrollToLineAlignment === 'start' ? 'start' : 'reading', props.contentPaddingBottom, findBandPx);
                if (landed && el && (props.scrollToLineAlignment !== 'start' || props.findRangesByLineId?.get(targetId)?.some(range => range.current))) {
                    stopRetainedLanding.current?.();
                    stopRetainedLanding.current = retainCodeLineLanding(el, props.scrollToLineAlignment === 'start' ? 'start' : 'reading', props.contentPaddingBottom, findBandPx);
                }
                return landed;
            } catch {
                return false;
            }
        };

        let bootstrapped = false;
        const attemptScroll = (retryBootstrap = false) => {
            if (cancelled || completedScrollTarget.current === scrollTargetKey) return;
            // The first web estimate can be clamped before the list has a measured viewport/content
            // extent. A real layout change reopens that bootstrap; target-row layout still finishes it.
            if (retryBootstrap) bootstrapped = false;
            if (!virtualized && typeof document === 'undefined') {
                const row = lineRefs.current.get(targetId);
                const owner = props.externalScrollView;
                if (row && owner) {
                    measureExternalLayout(owner, row, (_x, y) => {
                        if (cancelled) return;
                        const scrollY = Math.max(0, y);
                        completedScrollTarget.current = scrollTargetKey;
                        owner.offsetRef.current = scrollY;
                        owner.scrollRef.current?.scrollTo({ y: scrollY, animated: props.scrollToLineAlignment !== 'start' });
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
            // A measured/mounted row is authoritative. Estimates only bring an unmounted target into
            // the render window; its layout event completes the landing, however late the fold opens.
            if (tryScrollIntoView()) {
                completedScrollTarget.current = scrollTargetKey;
                return;
            }
            if (!virtualized || bootstrapped) return;
            bootstrapped = true;
            try {
                if (listRef.current) {
                    fireAndForget(Promise.resolve(listRef.current.scrollToIndex({ index: scrollIndex, viewPosition: props.scrollToLineAlignment === 'start' ? 0 : 0.25, animated: props.scrollToLineAlignment !== 'start' })));
                    if (typeof document === 'undefined') completedScrollTarget.current = scrollTargetKey;
                }
            } catch {
                // ignore
            }
        };

        pendingTargetLanding.current = attemptScroll;
        attemptScroll();
        return () => {
            cancelled = true;
            if (pendingTargetLanding.current === attemptScroll) pendingTargetLanding.current = null;
        };
    }, [estimatedRowHeight, lineNativeIdPrefix, props.lines, props.externalScrollView, props.onScrollToLine, props.scrollToLineId, props.scrollToLineAlignment, props.contentPaddingBottom, findBandPx, scrollTargetKey, scrollIndex, virtualized]);

    // The bar's band arriving or leaving shifts the content by its height. Scrolled content keeps what the
    // reader sees in place; only a view at its top lets line 1 move out from under the bar.
    const appliedFindBand = React.useRef(findBandPx);
    React.useLayoutEffect(() => {
        const delta = Math.max(paddingVertical, findBandPx) - Math.max(paddingVertical, appliedFindBand.current);
        appliedFindBand.current = findBandPx;
        if (delta === 0 || Platform.OS !== 'web') return;
        const node = (virtualized ? listRef.current?.getScrollableNode?.() : contentRef.current) as HTMLElement | null;
        const scroller = node instanceof HTMLElement ? findVerticalScroller(node) : null;
        if (scroller && scroller.scrollTop > 0) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
    }, [findBandPx, paddingVertical, virtualized]);

    // Web: the landed band ends when the reader presses into the code or scrolls the banded line out of view.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || landedHighlight === null || highlightReleased || typeof document === 'undefined') return;
        const targetId = props.highlightLineId;
        const root = (virtualized ? listRef.current?.getScrollableNode?.() : contentRef.current) as HTMLElement | null;
        if (!targetId || !(root instanceof HTMLElement)) return;
        let seen = false;
        let frame = 0;
        const check = () => {
            frame = 0;
            const row = document.getElementById(`${lineNativeIdPrefix}-${targetId}`);
            const scroller = row ? findVerticalScroller(row) : null;
            const visible = Boolean(row && scroller && (() => {
                const box = row.getBoundingClientRect();
                const view = scroller.getBoundingClientRect();
                return box.bottom > view.top + findBandPx && box.top < view.bottom;
            })());
            if (visible) seen = true;
            else if (seen) releaseLandedHighlight();
        };
        const onScroll = () => { if (!frame) frame = requestAnimationFrame(check); };
        const scroller = findVerticalScroller(root);
        const scrollTarget: HTMLElement | Document = scroller ?? document;
        scrollTarget.addEventListener('scroll', onScroll, { passive: true, capture: true });
        root.addEventListener('pointerdown', releaseLandedHighlight, { passive: true });
        check();
        return () => {
            if (frame) cancelAnimationFrame(frame);
            scrollTarget.removeEventListener('scroll', onScroll, { capture: true });
            root.removeEventListener('pointerdown', releaseLandedHighlight);
        };
    }, [findBandPx, highlightReleased, landedHighlight, lineNativeIdPrefix, props.highlightLineId, releaseLandedHighlight, virtualized]);

    const onListLayout = useEventCallback((event: LayoutChangeEvent) => {
        props.onLayout?.(event);
        if (Platform.OS === 'web') {
            pendingTargetLanding.current?.(true);
            stopRetainedLanding.current?.refresh();
        }
    });
    const onListContentSizeChange = useEventCallback((width: number, height: number) => {
        props.onContentSizeChange?.(width, height);
        if (Platform.OS === 'web') {
            pendingTargetLanding.current?.(true);
            stopRetainedLanding.current?.refresh();
        }
    });
    const onListLoad = useEventCallback(() => {
        if (Platform.OS !== 'web') return;
        const node = listRef.current?.getScrollableNode?.();
        // The web recycler publishes readiness instead of native content-size events. Keep
        // initial edge fades and pending landings fed from its actual scroll extent.
        if (node instanceof HTMLElement) onListContentSizeChange(node.scrollWidth, node.scrollHeight);
    });

    // Recycled cells need non-item behavior projected through `extraData`
    // to ensure rows get re-rendered. This matters for "selected" state and inline review-comment composers.
    const listExtraData = React.useMemo(() => ({
        lineNumberDigits,
        reviewLaneWidth,
        scrollToLineId: props.scrollToLineId,
        selectedLineIds: props.selectedLineIds,
        renderAfterLine: props.renderAfterLine,
        renderLeadingLane: props.renderLeadingLane,
        onPressLine: handlePressLine,
        onPressInLine: rangeGesturesEnabled && Platform.OS === 'web' ? handlePressInLine : undefined,
        onLongPressLine: rangeGesturesEnabled ? handleLongPressLine : undefined,
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
        reviewedLineIds: props.reviewedLineIds,
        liveTint: props.liveTint,
        agentPresence,
        findRangesByLineId: props.findRangesByLineId,
        diagnosticsByNewLine,
        advancedTokensRevision,
        semanticTokens: semantic.tokens,
    } as const), [
        lineNumberDigits,
        reviewLaneWidth,
        effectiveSyntaxHighlighting,
        advancedTokensRevision,
        handleHoverLine,
        handleLongPressLine,
        handlePressInLine,
        handlePressLine,
        handlePressOutLine,
        interactionMode,
        rangeGesturesEnabled,
        props.highlightLineId,
        props.highlightLineIds,
        props.reviewedLineIds,
        props.liveTint,
        agentPresence,
        props.findRangesByLineId,
        diagnosticsByNewLine,
        semantic.tokens,
        props.isCommentActive,
        props.onPressAddComment,
        props.onPressLineRange,
        props.pressLineWhenNotSelectable,
        props.showInactiveCommentAffordance,
        props.rangeSelectionActive,
        props.renderAfterLine,
        props.renderLeadingLane,
        props.selectedLineIds,
        props.scrollToLineId,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    const preserveReadingAnchor = (children: React.ReactNode) => (
        <CodeLinesReadingAnchor
            onRememberReadingLine={props.onRememberReadingLine}
            lines={props.lines}
            viewId={lineNativeIdPrefix}
            scrollToLineId={props.scrollToLineId}
            getRoot={() => virtualized ? listRef.current?.getScrollableNode?.() : contentRef.current}
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
                const lines = props.lines;
                const target = lines[index];
                const row = target ? lineRefs.current.get(target.id) : null;
                const scrollView = listRef.current?.getNativeScrollRef?.() as View | null | undefined;
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
                    fireAndForget(Promise.resolve(listRef.current?.scrollToIndex({ index, viewOffset: offset, animated: false })));
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
            <>
            {listHeaderComponent}
            <View ref={contentRef} style={{ paddingHorizontal, paddingTop, paddingBottom }} {...intelligenceEvents}>
                {props.lines.map((line, index) => (
                    <React.Fragment key={line.id}>
                        {renderLine(line, index)}
                    </React.Fragment>
                ))}
                <View style={{ height: 16 }} />
            </View>
            </>
        );
    }

    return preserveReadingAnchor(
        <VirtualizedList
            webScrollHandlers={intelligenceEvents}
            ref={listRef}
            data={props.lines}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            extraData={listExtraData}
            testID={props.testID}
            style={VIRTUALIZED_LIST_STYLE}
            // Unlike FlatList's measured-only tail, the recycler estimates unmounted rows and
            // scrolls to their index. Row layout still owns the final wrapped-line landing.
            estimatedItemSize={estimatedRowHeight}
            recycleItems={false}
            contentContainerStyle={contentContainerStyle}
            ListHeaderComponent={listHeaderComponent}
            ListFooterComponent={listFooterComponent}
            onLayout={onListLayout}
            onLoad={onListLoad}
            onContentSizeChange={onListContentSizeChange}
            onViewableItemsChanged={onViewableItemsChanged}
            onScroll={(event) => {
                nativeScrollOffset.current = event.nativeEvent.contentOffset.y;
                measureNativeReadingAnchor();
                props.onScroll?.(event);
            }}
            scrollEventThrottle={props.scrollEventThrottle}
        />
    );
}
