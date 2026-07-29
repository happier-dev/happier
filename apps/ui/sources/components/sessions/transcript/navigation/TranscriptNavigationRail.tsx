import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
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
    scrollTopPx?: number;
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

const WebRovingView = View as unknown as React.ComponentType<WebRovingViewProps>;
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
    const { theme } = useUnistyles();
    const [scrollTopPx, setScrollTopPx] = React.useState(() => (
        typeof props.scrollTopPx === 'number' && Number.isFinite(props.scrollTopPx) && props.scrollTopPx >= 0
            ? props.scrollTopPx
            : 0
    ));
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
    const pointerInsideRailRef = React.useRef(false);

    React.useEffect(() => {
        if (typeof props.scrollTopPx !== 'number' || !Number.isFinite(props.scrollTopPx) || props.scrollTopPx < 0) return;
        setScrollTopPx(props.scrollTopPx);
    }, [props.scrollTopPx]);

    React.useEffect(() => {
        if (layout.scrollTopPx !== scrollTopPx) {
            setScrollTopPx(layout.scrollTopPx);
        }
    }, [layout.scrollTopPx, scrollTopPx]);

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

    const moveKeyboardFocus = (delta: number) => {
        const baseIndex = focusedIndex ?? (activeIndex >= 0 ? activeIndex : keyboardIndexRef.current);
        const nextIndex = Math.max(0, Math.min(props.entries.length - 1, baseIndex + delta));
        keyboardIndexRef.current = nextIndex;
        updateFocusedIndex(nextIndex);
    };

    const dismissPreview = React.useCallback(() => {
        pointerInsidePreviewRef.current = false;
        pointerInsideRailRef.current = false;
        updateFocusedIndex(null);
    }, [updateFocusedIndex]);

    // WCAG 1.4.13: the hover preview must be dismissible without moving the
    // pointer, even when keyboard focus is not on the rail (web only).
    const previewOpen = focusedIndex !== null;
    const reducedMotion = props.reducedMotion === true;
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
            keyboardIndexRef.current = 0;
            updateFocusedIndex(0);
            return;
        }
        if (key === 'End') {
            event?.preventDefault?.();
            const lastIndex = props.entries.length - 1;
            keyboardIndexRef.current = lastIndex;
            updateFocusedIndex(lastIndex);
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
        pointerInsideRailRef.current = true;
        keyboardIndexRef.current = index;
        updateFocusedIndex(index);
    }, [updateFocusedIndex]);

    const handleRailPointerEnter = React.useCallback((event: unknown) => {
        if (readPointerType(event) === 'touch') return;
        pointerInsideRailRef.current = true;
    }, []);

    const handleRailPointerLeave = React.useCallback((event: unknown) => {
        if (readPointerType(event) === 'touch') return;
        pointerInsideRailRef.current = false;
        if (!pointerInsidePreviewRef.current) {
            updateFocusedIndex(null);
        }
    }, [updateFocusedIndex]);

    const handlePreviewPointerEnter = React.useCallback((event: unknown) => {
        if (readPointerType(event) === 'touch') return;
        pointerInsidePreviewRef.current = true;
    }, []);

    const handlePreviewPointerLeave = React.useCallback((event: unknown) => {
        if (readPointerType(event) === 'touch') return;
        pointerInsidePreviewRef.current = false;
        if (!pointerInsideRailRef.current) {
            updateFocusedIndex(null);
        }
    }, [updateFocusedIndex]);

    const handleRailScroll = React.useCallback((event: unknown) => {
        setScrollTopPx(readScrollTop(event));
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
                    <View pointerEvents="none" testID="transcript-navigation-rail.fade.top" style={[styles.fade, styles.fadeTop]}>
                        <ScrollEdgeFades color={theme.colors.surface.base} size={18} edges={{ top: true }} />
                    </View>
                ) : null}
                {layout.showBottomFade ? (
                    <View pointerEvents="none" testID="transcript-navigation-rail.fade.bottom" style={[styles.fade, styles.fadeBottom]}>
                        <ScrollEdgeFades color={theme.colors.surface.base} size={18} edges={{ bottom: true }} />
                    </View>
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
    fade: {
        left: 0,
        position: 'absolute',
        width: 32,
        height: 18,
        overflow: 'hidden',
    },
    fadeTop: {
        top: 0,
    },
    fadeBottom: {
        bottom: 0,
    },
}));
