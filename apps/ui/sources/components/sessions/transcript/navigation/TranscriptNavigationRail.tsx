import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    useTranscriptNavigationCurrentAnchorId,
    useTranscriptNavigationVisibleAnchorIds,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import {
    deriveTranscriptNavigationRailLayout,
    type TranscriptNavigationRailPlatformOS,
} from './deriveTranscriptNavigationRailLayout';
import { resolveTranscriptNavigationRailMarkerMotion } from './resolveTranscriptNavigationRailMotion';
import {
    resolveTranscriptNavigationRailSoftFadeStyle,
    useTranscriptNavigationRailSoftPresence,
} from './useTranscriptNavigationRailSoftPresence';
import { resolveTranscriptNavigationRailPreviewPlacement } from './resolveTranscriptNavigationRailPreviewPlacement';
import {
    TRANSCRIPT_NAVIGATION_RAIL_USER_SCROLL_YIELD_MS,
    type TranscriptNavigationRailScrollCommand,
    classifyTranscriptNavigationRailScrollEvent,
    resolveTranscriptNavigationRailPageScroll,
    resolveTranscriptNavigationRailScrollIntoView,
} from './resolveTranscriptNavigationRailScrollTarget';
import { TranscriptNavigationRailEdgeAffordance } from './TranscriptNavigationRailEdgeAffordance';
import { TranscriptNavigationRailMarker } from './TranscriptNavigationRailMarker';
import { TranscriptNavigationRailPreview } from './TranscriptNavigationRailPreview';
import type { TranscriptJumpTarget } from '../viewport/jump/transcriptJumpTargetTypes';
import type { TranscriptNavigationEntry, TranscriptNavigationJumpRequest } from './transcriptNavigationTypes';

export type TranscriptNavigationRailEntry = TranscriptNavigationEntry;

export type TranscriptNavigationRailJumpRequest = TranscriptNavigationJumpRequest & Readonly<{ source: 'rail' }>;

export type TranscriptNavigationRailProps = Readonly<{
    entries: readonly TranscriptNavigationRailEntry[];
    onJumpToEntry: (entry: TranscriptNavigationRailEntry, request: TranscriptNavigationRailJumpRequest) => void;
    paneHeightPx: number;
    paneWidthPx: number;
    platformOS?: TranscriptNavigationRailPlatformOS;
    previewMaxWidthPx?: number;
    reducedMotion?: boolean;
    /** The rail subscribes to this session's navigation visibility itself. */
    sessionId: string;
    transcriptContentWidthPx: number;
    transcriptMaxWidthPx?: number;
}>;

type WebRovingViewProps = React.ComponentPropsWithRef<typeof View> & {
    onKeyDown?: (event: {
        key?: string;
        preventDefault?: () => void;
    }) => void;
    tabIndex?: number;
};

type WebFocusableViewProps = WebRovingViewProps & {
    onBlur?: (event: unknown) => void;
    onFocus?: (event: unknown) => void;
};

const WebRovingView = View as unknown as React.ComponentType<WebFocusableViewProps>;
const WebRailView = View as unknown as React.ComponentType<WebRovingViewProps & {
    onPointerEnter?: (event: unknown) => void;
    onPointerLeave?: (event: unknown) => void;
}>;

function resolvePlatformOS(platformOS: TranscriptNavigationRailProps['platformOS']): TranscriptNavigationRailPlatformOS {
    if (platformOS) return platformOS;
    if (Platform.OS === 'web') return 'web';
    if (Platform.OS === 'ios') return 'ios';
    if (Platform.OS === 'android') return 'android';
    return 'native-other';
}

function isPinnedEntry(entry: TranscriptNavigationRailEntry): boolean {
    return entry.pinned === true || entry.kind.startsWith('pinned-');
}

function resolveJumpAlignment(entry: TranscriptNavigationRailEntry): TranscriptNavigationRailJumpRequest['align'] {
    return entry.kind === 'user-turn' ? 'top' : 'center';
}

function resolveJumpTarget(entry: TranscriptNavigationRailEntry): TranscriptJumpTarget | null {
    if (entry.routeMessageId) {
        return {
            kind: 'route-message-id',
            routeMessageId: entry.routeMessageId,
            seqHint: entry.seq,
            transcriptBlockIndex: entry.transcriptBlockIndex,
            role: entry.role,
        };
    }
    if (typeof entry.seq === 'number' && Number.isFinite(entry.seq)) {
        return { kind: 'seq', seq: entry.seq };
    }
    return null;
}

function readPointerType(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null;
    const nativeEvent = (event as { nativeEvent?: { pointerType?: unknown }; pointerType?: unknown }).nativeEvent;
    const pointerType = nativeEvent?.pointerType ?? (event as { pointerType?: unknown }).pointerType;
    return typeof pointerType === 'string' ? pointerType : null;
}

function readScrollTop(event: unknown): number {
    if (!event || typeof event !== 'object') return 0;
    const nativeEvent = (event as { nativeEvent?: { contentOffset?: { y?: unknown } } }).nativeEvent;
    const y = nativeEvent?.contentOffset?.y;
    return typeof y === 'number' && Number.isFinite(y) && y >= 0 ? y : 0;
}

type DocumentKeydownHost = Readonly<{
    addEventListener?: (type: string, listener: (event: unknown) => void) => void;
    removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
}>;

function resolveDocumentKeydownHost(): DocumentKeydownHost | null {
    const doc = (globalThis as { document?: DocumentKeydownHost }).document;
    if (!doc || typeof doc.addEventListener !== 'function' || typeof doc.removeEventListener !== 'function') {
        return null;
    }
    return doc;
}

export function TranscriptNavigationRail(props: TranscriptNavigationRailProps) {
    const styles = stylesheet;
    // The rail's scroll position has exactly one owner: this state. It holds the
    // last position the rail was either scrolled to (by the reader) or commanded
    // to (by this component), and every geometry consumer reads the CLAMPED
    // `layout.scrollTopPx` derived from it — never the raw state, and never a
    // second copy synced back through an effect.
    const [scrollTopPx, setScrollTopPx] = React.useState(0);
    const layout = deriveTranscriptNavigationRailLayout({
        entryCount: props.entries.length,
        paneHeightPx: props.paneHeightPx,
        paneWidthPx: props.paneWidthPx,
        platformOS: resolvePlatformOS(props.platformOS),
        scrollTopPx,
        transcriptContentWidthPx: props.transcriptContentWidthPx,
        transcriptMaxWidthPx: props.transcriptMaxWidthPx,
    });
    // Two narrow subscriptions off the ONE visibility store: the current anchor
    // changes at turn-boundary rate and the visible set at frame rate. Reading
    // them here (instead of accepting a host-published snapshot) keeps an anchor
    // change inside the rail rather than re-rendering the whole transcript host.
    const currentAnchorId = useTranscriptNavigationCurrentAnchorId(props.sessionId, { enabled: layout.visible });
    const visibleAnchorIdList = useTranscriptNavigationVisibleAnchorIds(props.sessionId, { enabled: layout.visible });
    const entryIndexById = React.useMemo(() => {
        const map = new Map<string, number>();
        props.entries.forEach((entry, index) => map.set(entry.id, index));
        return map;
    }, [props.entries]);
    const activeIndex = currentAnchorId !== null
        ? entryIndexById.get(currentAnchorId) ?? -1
        : -1;
    const visibleAnchorIds = React.useMemo(
        () => new Set(visibleAnchorIdList),
        [visibleAnchorIdList],
    );
    const [focusedIndex, setFocusedIndex] = React.useState<number | null>(null);
    const [previewHeightPx, setPreviewHeightPx] = React.useState<number | null>(null);
    const keyboardIndexRef = React.useRef(activeIndex >= 0 ? activeIndex : 0);
    const pointerInsidePreviewRef = React.useRef(false);
    // Pointer presence drives both the chevron reveal (render) and the
    // auto-scroll yield (an effect), so it is state with a render-synced read
    // handle for callbacks rather than two independently written flags.
    const [railHovered, setRailHovered] = React.useState(false);
    const railHoveredRef = React.useRef(railHovered);
    railHoveredRef.current = railHovered;
    const [railFocusWithin, setRailFocusWithin] = React.useState(false);
    const railScrollRef = React.useRef<ScrollView | null>(null);
    const lastUserScrollAtMsRef = React.useRef(0);
    // The one owner of "is this scroll event mine?": the move this component
    // last commanded, tracked as a fact rather than inferred from a clock. See
    // `classifyTranscriptNavigationRailScrollEvent`.
    const scrollCommandRef = React.useRef<TranscriptNavigationRailScrollCommand | null>(null);
    // Render-synced read handle on the one committed scroll position above, so
    // the decisions below can consult where the rail is without taking a
    // per-frame dependency on it — a decision that depended on the position
    // would re-issue, on every frame of its own animation, the very command
    // those frames came from.
    const committedScrollTopPxRef = React.useRef(layout.scrollTopPx);
    committedScrollTopPxRef.current = layout.scrollTopPx;
    // Bumped when a blocked auto-scroll becomes due again, so the effect below
    // re-evaluates without polling.
    const [autoScrollRetryNonce, setAutoScrollRetryNonce] = React.useState(0);

    /** Where the rail is right now: how far an outstanding move has got, else the committed position. */
    const readRailPositionPx = React.useCallback(
        () => scrollCommandRef.current?.positionPx ?? committedScrollTopPxRef.current,
        [],
    );
    /** Where the rail is headed: an outstanding move's target, else where it already is. */
    const readRailTargetPx = React.useCallback(
        () => scrollCommandRef.current?.targetPx ?? committedScrollTopPxRef.current,
        [],
    );

    const updateFocusedIndex = React.useCallback((nextIndex: number | null) => {
        setFocusedIndex(nextIndex);
    }, []);

    React.useEffect(() => {
        if (focusedIndex !== null && focusedIndex >= props.entries.length) {
            updateFocusedIndex(props.entries.length > 0 ? props.entries.length - 1 : null);
        }
        if (keyboardIndexRef.current >= props.entries.length) {
            keyboardIndexRef.current = Math.max(0, props.entries.length - 1);
        }
    }, [focusedIndex, props.entries.length, updateFocusedIndex]);

    const activateEntry = React.useCallback((entry: TranscriptNavigationRailEntry) => {
        const target = resolveJumpTarget(entry);
        if (!target) return;
        props.onJumpToEntry(entry, {
            align: resolveJumpAlignment(entry),
            scope: { kind: 'main', sessionId: entry.sessionId },
            source: 'rail',
            target,
        });
    }, [props.onJumpToEntry]);

    const activateEntryAtIndex = React.useCallback((index: number) => {
        const entry = props.entries[index];
        if (entry) activateEntry(entry);
    }, [activateEntry, props.entries]);

    const reducedMotion = props.reducedMotion === true;

    /**
     * The single write path to the rail's scroll position: commands the
     * scroller and records the commanded position in the same breath, so the
     * fades, the preview anchor and the next scroll decision all agree without
     * waiting for a scroll event that a smooth scroll only delivers in frames.
     *
     * `userInitiated` marks a move the reader asked for (chevron, arrow keys),
     * which re-arms the yield window so anchor tracking does not immediately
     * drag the rail back off the position they just chose.
     */
    const scrollRailTo = React.useCallback((
        nextScrollTopPx: number,
        options?: Readonly<{ userInitiated?: boolean }>,
    ) => {
        const nowMs = Date.now();
        const userInitiated = options?.userInitiated === true;
        if (userInitiated) lastUserScrollAtMsRef.current = nowMs;
        scrollCommandRef.current = {
            lastEventAtMs: nowMs,
            positionPx: readRailPositionPx(),
            targetPx: nextScrollTopPx,
            userInitiated,
        };
        setScrollTopPx(nextScrollTopPx);
        railScrollRef.current?.scrollTo({ animated: !reducedMotion, y: nextScrollTopPx });
    }, [readRailPositionPx, reducedMotion]);

    /**
     * Stops an in-flight move exactly where it stands. Refusing to issue the
     * *next* command is not enough: one already running would keep sliding
     * markers out from under a cursor that is aiming at them for the rest of its
     * animation. A non-animated command at the current position ends it there.
     *
     * A move the READER asked for is left alone. Their pointer is already on the
     * rail when they press a chevron, and a page that lands against an end
     * unmounts the pressed chevron from under the cursor — the browser then
     * re-delivers `pointerEnter` on remount (the departed node cannot be
     * recognised as a descendant), so cancelling here would abort the reader's
     * own page one frame after it started.
     */
    const cancelRailScroll = React.useCallback(() => {
        const command = scrollCommandRef.current;
        if (!command || command.userInitiated) return;
        scrollCommandRef.current = null;
        setScrollTopPx(command.positionPx);
        railScrollRef.current?.scrollTo({ animated: false, y: command.positionPx });
    }, []);

    const {
        contentHeightPx: railContentHeightPx,
        markerHeightPx: railMarkerHeightPx,
        markerSpacingPx: railMarkerSpacingPx,
        overflow: railOverflow,
        viewportMaxHeightPx: railViewportHeightPx,
        visible: railVisible,
    } = layout;

    // The rail's one "where should this marker put the rail?" owner. It measures
    // from where the rail is headed, not from the animation frame it happens to
    // be on, which is what keeps its identity — and therefore the effect below —
    // stable across a whole scroll.
    const resolveMarkerScrollTopPx = React.useCallback((markerIndex: number) => (
        resolveTranscriptNavigationRailScrollIntoView({
            contentHeightPx: railContentHeightPx,
            markerHeightPx: railMarkerHeightPx,
            markerIndex,
            markerSpacingPx: railMarkerSpacingPx,
            scrollTopPx: readRailTargetPx(),
            viewportHeightPx: railViewportHeightPx,
        })
    ), [railContentHeightPx, railMarkerHeightPx, railMarkerSpacingPx, readRailTargetPx, railViewportHeightPx]);

    // Keep the read anchor inside the rail viewport. Minimum-distance, never
    // centred: the anchor advances at every turn boundary, and re-centring on
    // each one would leave the rail permanently sliding.
    //
    // The anchor moving is what makes this decision, so the rail's own scroll
    // position is deliberately absent from the dependencies: it is read through
    // `resolveMarkerScrollTopPx` instead. That is what stops a move from being
    // re-commanded — and a retry timer from being scheduled and cleared — once
    // per frame of whatever scroll is currently running.
    React.useEffect(() => {
        if (!railVisible || !railOverflow || activeIndex < 0) return;
        // The reader owns the rail while their pointer is on it — moving markers
        // out from under the cursor would break both hover preview and clicking.
        if (railHovered) return;
        const yieldRemainingMs = lastUserScrollAtMsRef.current
            + TRANSCRIPT_NAVIGATION_RAIL_USER_SCROLL_YIELD_MS
            - Date.now();
        if (yieldRemainingMs > 0) {
            const timeout = setTimeout(() => setAutoScrollRetryNonce((nonce) => nonce + 1), yieldRemainingMs);
            return () => clearTimeout(timeout);
        }
        const nextScrollTopPx = resolveMarkerScrollTopPx(activeIndex);
        if (nextScrollTopPx === null) return;
        scrollRailTo(nextScrollTopPx);
    }, [
        activeIndex,
        autoScrollRetryNonce,
        railHovered,
        railOverflow,
        railVisible,
        resolveMarkerScrollTopPx,
        scrollRailTo,
    ]);

    const focusMarkerAtIndex = (nextIndex: number) => {
        keyboardIndexRef.current = nextIndex;
        updateFocusedIndex(nextIndex);
        // Keyboard focus is a direct instruction, so it moves the rail even
        // inside the yield window the reader's own scrolling opened.
        const nextScrollTopPx = resolveMarkerScrollTopPx(nextIndex);
        if (nextScrollTopPx !== null) scrollRailTo(nextScrollTopPx, { userInitiated: true });
    };

    const moveKeyboardFocus = (delta: number) => {
        const baseIndex = focusedIndex ?? (activeIndex >= 0 ? activeIndex : keyboardIndexRef.current);
        focusMarkerAtIndex(Math.max(0, Math.min(props.entries.length - 1, baseIndex + delta)));
    };

    const handleEdgePage = React.useCallback((direction: 'up' | 'down') => {
        const nextScrollTopPx = resolveTranscriptNavigationRailPageScroll({
            contentHeightPx: railContentHeightPx,
            direction,
            scrollTopPx: readRailTargetPx(),
            viewportHeightPx: railViewportHeightPx,
        });
        if (nextScrollTopPx === null) return;
        scrollRailTo(nextScrollTopPx, { userInitiated: true });
    }, [railContentHeightPx, readRailTargetPx, railViewportHeightPx, scrollRailTo]);

    const dismissPreview = React.useCallback(() => {
        // Closes the preview only: pointer presence is a physical fact owned by
        // the rail's enter/leave handlers, and claiming the pointer had left
        // would let the rail auto-scroll out from under a resting cursor.
        pointerInsidePreviewRef.current = false;
        updateFocusedIndex(null);
    }, [updateFocusedIndex]);

    // WCAG 1.4.13: the hover preview must be dismissible without moving the
    // pointer, even when keyboard focus is not on the rail (web only).
    const previewOpen = focusedIndex !== null;
    const previewPresence = useTranscriptNavigationRailSoftPresence(previewOpen, reducedMotion);
    // The last focused index anchors the preview while it fades out after
    // focus clears.
    const lastFocusedIndexRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (focusedIndex !== null) lastFocusedIndexRef.current = focusedIndex;
    }, [focusedIndex]);
    React.useEffect(() => {
        if (!previewOpen) return;
        const doc = resolveDocumentKeydownHost();
        if (!doc) return;
        const handleDocumentKeyDown = (event: unknown) => {
            const key = (event as { key?: unknown } | null | undefined)?.key;
            if (key === 'Escape') dismissPreview();
        };
        doc.addEventListener?.('keydown', handleDocumentKeyDown);
        return () => {
            doc.removeEventListener?.('keydown', handleDocumentKeyDown);
        };
    }, [dismissPreview, previewOpen]);

    const handleKeyDown: WebRovingViewProps['onKeyDown'] = (event) => {
        const key = String(event?.key ?? '');
        if (key === 'ArrowDown') {
            event?.preventDefault?.();
            moveKeyboardFocus(1);
            return;
        }
        if (key === 'ArrowUp') {
            event?.preventDefault?.();
            moveKeyboardFocus(-1);
            return;
        }
        if (key === 'Home') {
            event?.preventDefault?.();
            focusMarkerAtIndex(0);
            return;
        }
        if (key === 'End') {
            event?.preventDefault?.();
            focusMarkerAtIndex(Math.max(0, props.entries.length - 1));
            return;
        }
        if (key === 'Escape') {
            event?.preventDefault?.();
            dismissPreview();
            return;
        }
        if (key === 'Enter' || key === ' ') {
            event?.preventDefault?.();
            const targetIndex = focusedIndex ?? keyboardIndexRef.current;
            const entry = props.entries[targetIndex];
            if (entry) activateEntry(entry);
        }
    };

    const handleMarkerPointerEnter = React.useCallback((index: number, event: unknown) => {
        if (readPointerType(event) === 'touch') return;
        setRailHovered(true);
        keyboardIndexRef.current = index;
        updateFocusedIndex(index);
    }, [updateFocusedIndex]);

    // The rail root is the boundary the pointer must cross to reach any marker,
    // so it is the single place that has to stop the rail moving under it.
    const handleRailPointerEnter = React.useCallback((event: unknown) => {
        if (readPointerType(event) === 'touch') return;
        setRailHovered(true);
        cancelRailScroll();
    }, [cancelRailScroll]);

    const handleRailPointerLeave = React.useCallback((event: unknown) => {
        if (readPointerType(event) === 'touch') return;
        setRailHovered(false);
        if (!pointerInsidePreviewRef.current) {
            updateFocusedIndex(null);
        }
    }, [updateFocusedIndex]);

    const handleRailFocus = React.useCallback(() => {
        setRailFocusWithin(true);
    }, []);

    const handleRailBlur = React.useCallback(() => {
        setRailFocusWithin(false);
    }, []);

    const handlePreviewPointerEnter = React.useCallback((event: unknown) => {
        if (readPointerType(event) === 'touch') return;
        pointerInsidePreviewRef.current = true;
    }, []);

    const handlePreviewPointerLeave = React.useCallback((event: unknown) => {
        if (readPointerType(event) === 'touch') return;
        pointerInsidePreviewRef.current = false;
        if (!railHoveredRef.current) {
            updateFocusedIndex(null);
        }
    }, [updateFocusedIndex]);

    const handleRailScroll = React.useCallback((event: unknown) => {
        const nowMs = Date.now();
        const positionPx = readScrollTop(event);
        const classified = classifyTranscriptNavigationRailScrollEvent({
            atMs: nowMs,
            command: scrollCommandRef.current,
            positionPx,
        });
        scrollCommandRef.current = classified.command;
        // Only the reader moving the rail opens the yield window. Frames of the
        // rail's own move must not yield the rail to the rail — and a reader
        // scroll that lands mid-move must not be swallowed by it.
        if (classified.origin === 'reader') lastUserScrollAtMsRef.current = nowMs;
        setScrollTopPx(positionPx);
    }, []);

    const handlePreviewLayout = React.useCallback((event: unknown) => {
        const height = (event as { nativeEvent?: { layout?: { height?: unknown } } } | null | undefined)
            ?.nativeEvent?.layout?.height;
        if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
        setPreviewHeightPx((current) => (current === height ? current : height));
    }, []);

    // Soft appear/disappear for the rail itself (entries-count and width
    // threshold crossings) — mounted through the exit fade, hidden instantly.
    const railPresence = useTranscriptNavigationRailSoftPresence(layout.visible, reducedMotion);

    const previewIndex = focusedIndex ?? lastFocusedIndexRef.current;
    const previewEntry = previewPresence.mounted && previewIndex !== null
        ? props.entries[previewIndex] ?? null
        : null;
    const previewTopPx = previewIndex !== null
        ? (previewIndex * (layout.markerHeightPx + layout.markerSpacingPx)) - layout.scrollTopPx
        : 0;
    const previewPlacement = resolveTranscriptNavigationRailPreviewPlacement({
        markerTopPx: previewTopPx,
        paneHeightPx: props.paneHeightPx,
        paneWidthPx: props.paneWidthPx,
        previewHeightPx,
        railWidthPx: layout.railWidthPx,
        requestedMaxWidthPx: props.previewMaxWidthPx,
        viewportOffsetTopPx: layout.viewportOffsetTopPx,
    });

    if (!railPresence.mounted) return null;

    // The chevrons are an on-demand affordance: quiet until the reader is
    // actually at the rail, so a resting minimap stays a minimap.
    const edgeAffordanceRevealed = railHovered || railFocusWithin;

    return (
        <WebRailView
            testID="transcript-navigation-rail"
            onKeyDown={handleKeyDown}
            onPointerEnter={handleRailPointerEnter}
            onPointerLeave={handleRailPointerLeave}
            style={[
                styles.rail,
                {
                    top: layout.viewportOffsetTopPx,
                    width: layout.railWidthPx + 8,
                },
                // Note: while the rail root fades (opacity < 1) it groups its
                // subtree, which would defeat an open preview's backdrop blur —
                // transiently acceptable since both fade out together.
                resolveTranscriptNavigationRailSoftFadeStyle(railPresence.shown, reducedMotion),
                railPresence.shown ? null : styles.railHidden,
            ]}
        >
            <WebRovingView
                testID="transcript-navigation-rail.roving-tabstop"
                onBlur={handleRailBlur}
                onFocus={handleRailFocus}
                onKeyDown={handleKeyDown}
                tabIndex={0}
                style={[
                    styles.rovingTabstop,
                    {
                        maxHeight: layout.viewportMaxHeightPx,
                    },
                ]}
            >
                <ScrollView
                    ref={railScrollRef}
                    testID="transcript-navigation-rail.scroll"
                    scrollEnabled={layout.overflow}
                    showsVerticalScrollIndicator={false}
                    onScroll={handleRailScroll}
                    scrollEventThrottle={16}
                    style={[
                        styles.scroll,
                        {
                            maxHeight: layout.viewportMaxHeightPx,
                        },
                    ]}
                >
                    <View
                        testID="transcript-navigation-rail.marker-content"
                        style={[
                            styles.markerContent,
                            {
                                height: layout.contentHeightPx,
                            },
                        ]}
                    >
                        {props.entries.map((entry, index) => (
                            <TranscriptNavigationRailMarker
                                key={entry.id}
                                active={index === activeIndex}
                                anchorId={entry.id}
                                index={index}
                                label={entry.label}
                                markerHeightPx={layout.markerHeightPx}
                                motion={resolveTranscriptNavigationRailMarkerMotion({
                                    activeIndex: activeIndex >= 0 ? activeIndex : null,
                                    focusIndex: focusedIndex,
                                    markerIndex: index,
                                    reducedMotion,
                                    visible: visibleAnchorIds.has(entry.id),
                                })}
                                onFocusFromPointer={handleMarkerPointerEnter}
                                onPress={activateEntryAtIndex}
                                pinned={isPinnedEntry(entry)}
                                reducedMotion={reducedMotion}
                                topPx={index * (layout.markerHeightPx + layout.markerSpacingPx)}
                                visible={visibleAnchorIds.has(entry.id)}
                            />
                        ))}
                    </View>
                </ScrollView>
                {layout.showTopFade ? (
                    <TranscriptNavigationRailEdgeAffordance
                        edge="top"
                        onPage={handleEdgePage}
                        reducedMotion={reducedMotion}
                        revealed={edgeAffordanceRevealed}
                    />
                ) : null}
                {layout.showBottomFade ? (
                    <TranscriptNavigationRailEdgeAffordance
                        edge="bottom"
                        onPage={handleEdgePage}
                        reducedMotion={reducedMotion}
                        revealed={edgeAffordanceRevealed}
                    />
                ) : null}
            </WebRovingView>
            {previewEntry ? (
                <TranscriptNavigationRailPreview
                    entry={previewEntry}
                    leftPx={previewPlacement.leftPx}
                    maxWidthPx={previewPlacement.maxWidthPx}
                    onLayout={handlePreviewLayout}
                    onPointerEnter={handlePreviewPointerEnter}
                    onPointerLeave={handlePreviewPointerLeave}
                    reducedMotion={reducedMotion}
                    shown={previewPresence.shown && previewOpen}
                    topPx={previewPlacement.topPx}
                />
            ) : null}
        </WebRailView>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    rail: {
        bottom: 0,
        left: 0,
        position: 'absolute',
        zIndex: 2,
    },
    railHidden: {
        // A fading-out rail must not intercept pointer or keyboard intent.
        pointerEvents: 'none',
    },
    rovingTabstop: {
        // The edge chevrons deliberately sit in lanes just outside this box, so
        // that no press target is laid over a marker. Stated rather than
        // inherited: clipping here would silently push them back onto the
        // markers instead of visibly breaking.
        overflow: 'visible',
        position: 'relative',
        width: 32,
    },
    scroll: {
        width: 32,
    },
    markerContent: {
        position: 'relative',
        width: 24,
    },
}));
