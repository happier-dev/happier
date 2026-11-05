import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { resolveVerticalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';

import {
    resolveDesktopActivityOverlaySurfaceTestID,
} from './shared/desktopActivityOverlaySelectors.mjs';
import { DesktopActivityOverlayPinButton } from './DesktopActivityOverlayPinButton';
import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from './shared/desktopActivityOverlaySelectors';
import { DesktopActivityOverlayExpandedCards } from './cards/DesktopActivityOverlayExpandedCards';
import {
    isDesktopActivityOverlayDismissKey,
    readDesktopActivityOverlayEventKey,
    type DesktopActivityOverlayKeyEvent,
} from './desktopActivityOverlayKeyboard';
import {
    resolveDesktopActivityOverlayInitialFocusTarget,
    type DesktopActivityOverlayFocusTargetRef,
} from './resolveDesktopActivityOverlayInitialFocusTarget';
import type {
    DesktopActivityOverlayActionHandler,
    DesktopActivityOverlayUiModel,
} from './shared/desktopActivityOverlayUiModel';

export function DesktopActivityOverlayExpanded(props: Readonly<{
    model: Pick<DesktopActivityOverlayUiModel, 'expanded'>;
    visualMode: DesktopActivityOverlayVisualMode;
    /** The status row heading the panel, when it is not already standing above it (side docks, Floating opening up). */
    header?: React.ReactNode;
    /** The status row stands just above the panel (Top, Floating opening down): the panel tucks under it. */
    underStatusRow?: boolean;
    /** The tallest the panel may be: the window native clamped to the visible frame. */
    maxHeight?: number;
    /** The panel's natural height, header and insets included, for the extent native frames. */
    onNaturalHeight?: (height: number) => void;
    surfaceRef?: React.Ref<View>;
    initialFocusRef?: DesktopActivityOverlayFocusTargetRef;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    onFocusWithinChange?: (focusWithin: boolean) => void;
    onDismissKey?: () => void;
    onOpenSession: (sessionId: string, serverId?: string | null) => void;
    onAction?: DesktopActivityOverlayActionHandler;
    /** The opened list's Bot section (faces' members, each with its ask). */
    bots?: React.ComponentProps<typeof DesktopActivityOverlayExpandedCards>['bots'];
    /** A pinned Bot conversation in place of the list; the shell (insets, header, scroll, keys) is the same. */
    content?: React.ReactNode;
    /** The list's pin, at the status row's trailing end: keeps the island open until Esc, the pin or a click outside. */
    pin?: Readonly<{ pinned: boolean; onToggle: () => void }> | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const surfaceTestID = resolveDesktopActivityOverlaySurfaceTestID('desktop-activity-overlay-expanded', props.visualMode);
    const [completionAutoDismissPaused, setCompletionAutoDismissPaused] = React.useState(false);
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
    });
    const scrollMaskStyle = React.useMemo(
        () => resolveVerticalScrollEdgeMaskStyle(scrollFades.visibility, { fadeSize: theme.space.s16 }),
        [scrollFades.visibility, theme.space.s16],
    );
    const insetTop = props.underStatusRow ? theme.space.s8 : theme.space.s12;
    const insetBottom = theme.space.s12;
    const headerHeightRef = React.useRef(0);
    const contentHeightRef = React.useRef(0);
    const { onNaturalHeight } = props;
    // A header measured earlier no longer counts once the panel has none (a dock change from a side to the top).
    const hasHeader = Boolean(props.header);
    const reportNaturalHeight = React.useCallback(() => {
        const headerHeight = hasHeader ? headerHeightRef.current : 0;
        const gap = headerHeight > 0 ? theme.space.s10 : 0;
        onNaturalHeight?.(insetTop + headerHeight + gap + contentHeightRef.current + insetBottom);
    }, [hasHeader, insetBottom, insetTop, onNaturalHeight, theme.space.s10]);
    const hadHeaderRef = React.useRef(hasHeader);
    React.useEffect(() => {
        if (hadHeaderRef.current === hasHeader) return;
        hadHeaderRef.current = hasHeader;
        reportNaturalHeight();
    }, [hasHeader, reportNaturalHeight]);
    const onScrollContentSizeChange = scrollFades.onContentSizeChange;
    const handleContentSizeChange = React.useCallback((width: number, height: number) => {
        contentHeightRef.current = height;
        reportNaturalHeight();
        onScrollContentSizeChange(width, height);
    }, [onScrollContentSizeChange, reportNaturalHeight]);
    const handleHeaderLayout = React.useCallback((event: LayoutChangeEvent) => {
        headerHeightRef.current = event.nativeEvent.layout.height;
        reportNaturalHeight();
    }, [reportNaturalHeight]);
    const handleHoverIn = React.useCallback(() => {
        setCompletionAutoDismissPaused(true);
        props.onHoverIn?.();
    }, [props.onHoverIn]);
    const handleHoverOut = React.useCallback(() => {
        setCompletionAutoDismissPaused(false);
        props.onHoverOut?.();
    }, [props.onHoverOut]);
    const { onDismissKey, onFocusWithinChange } = props;
    const handleFocusIn = React.useCallback(() => onFocusWithinChange?.(true), [onFocusWithinChange]);
    const handleFocusOut = React.useCallback(() => onFocusWithinChange?.(false), [onFocusWithinChange]);
    const handleKeyDown = React.useCallback((event: DesktopActivityOverlayKeyEvent) => {
        if (!isDesktopActivityOverlayDismissKey(readDesktopActivityOverlayEventKey(event))) {
            return;
        }
        onDismissKey?.();
    }, [onDismissKey]);
    const initialFocusTarget = React.useMemo(
        () => resolveDesktopActivityOverlayInitialFocusTarget(props.model),
        [props.model],
    );

    const pinButton = props.pin && !props.content ? (
        <DesktopActivityOverlayPinButton
            testID="desktop-activity-overlay-pin"
            pinned={props.pin.pinned}
            onPress={props.pin.onToggle}
        />
    ) : null;

    return (
        // The shell only tracks hover to pause completion auto-dismiss. A `Pressable` would make it
        // a react-native-web focus stop with no action, so hover rides on pointer events instead.
        //
        // React delivers `onFocus`/`onBlur` as delegated `focusin`/`focusout`, and `keydown` bubbles,
        // so the shell sees descendant focus and keys without a focus manager. `tabIndex={-1}` keeps
        // it programmatically focusable — the last-resort Escape owner — without adding a tab stop.
        <View
            ref={props.surfaceRef}
            testID="desktop-activity-overlay-expanded"
            tabIndex={-1}
            onPointerEnter={handleHoverIn}
            onPointerLeave={handleHoverOut}
            onFocus={handleFocusIn}
            onBlur={handleFocusOut}
            {...({ onKeyDown: handleKeyDown } as Record<string, unknown>)}
            style={[
                styles.container,
                { paddingTop: insetTop, paddingBottom: insetBottom, maxHeight: props.maxHeight },
            ]}
        >
            <View pointerEvents="none" testID={surfaceTestID} style={StyleSheet.absoluteFill} />
            {props.header ? (
                <View testID="desktop-activity-overlay-expanded-header" style={styles.header} onLayout={handleHeaderLayout}>
                    <View style={styles.headerContent}>{props.header}</View>
                    {pinButton}
                </View>
            ) : pinButton ? (
                // Under a status row standing on its edge, the pin sits at that row's trailing end.
                <View style={styles.pinInStatusRow}>{pinButton}</View>
            ) : null}
            <ScrollView
                testID="desktop-activity-overlay-expanded-scroll"
                style={[styles.scroll, scrollMaskStyle]}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                scrollEventThrottle={16}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={handleContentSizeChange}
                onScroll={scrollFades.onScroll}
                onMomentumScrollEnd={scrollFades.onMomentumScrollEnd}
            >
                {props.content ?? (
                    <DesktopActivityOverlayExpandedCards
                        bots={props.bots}
                        model={props.model}
                        visualMode={props.visualMode}
                        onOpenSession={props.onOpenSession}
                        onAction={props.onAction}
                        completionAutoDismissPaused={completionAutoDismissPaused}
                        initialFocusTarget={initialFocusTarget}
                        initialFocusRef={props.initialFocusRef}
                        onDismissKey={props.onDismissKey}
                    />
                )}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The panel content inside the island: lab `.nt-p` (s12 inset; s8 under a status row on its edge).
    container: {
        width: '100%',
        position: 'relative',
        paddingHorizontal: theme.space.s12,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        marginBottom: theme.space.s10,
    },
    headerContent: {
        flex: 1,
        minWidth: 0,
    },
    pinInStatusRow: {
        position: 'absolute',
        top: -PAGE_LIST_METRICS.controlHeightPx,
        right: theme.space.s8,
        height: PAGE_LIST_METRICS.controlHeightPx,
        justifyContent: 'center',
    },
    scroll: {
        flexGrow: 0,
        flexShrink: 1,
    },
    scrollContent: {
        gap: theme.space.s12,
    },
}));
