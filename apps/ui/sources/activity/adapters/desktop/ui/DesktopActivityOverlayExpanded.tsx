import * as React from 'react';
import { HAPPIER_ICON_BUTTON_SIZE } from '@happier-dev/plugin-ui/presentation';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveDesktopActivityOverlayPanelInsets } from './desktopActivityOverlayPanelInsets';

import { DesktopActivityOverlayPanelRoomContext, type DesktopActivityOverlayPanelRoom } from './panelRoom';
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
import type { DesktopActivityOverlayFocusTargetRef } from './resolveDesktopActivityOverlayInitialFocusTarget';
import type {
    DesktopActivityOverlayActionHandler,
    DesktopActivityOverlayUiModel,
} from './shared/desktopActivityOverlayUiModel';

export function DesktopActivityOverlayExpanded(props: Readonly<{
    model: Pick<DesktopActivityOverlayUiModel, 'expanded'>;
    visualMode: DesktopActivityOverlayVisualMode;
    /** The status row stands just above the panel (Top, Floating opening down): the panel tucks under it. */
    underStatusRow?: boolean;
    /** The tallest the panel may be: the window native clamped to the visible frame. */
    maxHeight?: number;
    /** The panel's natural height, insets included, for the extent native frames. */
    onNaturalHeight?: (height: number) => void;
    surfaceRef?: React.Ref<View>;
    initialFocusRef?: DesktopActivityOverlayFocusTargetRef;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    onFocusWithinChange?: (focusWithin: boolean) => void;
    onDismissKey?: () => void;
    onOpenSession: (sessionId: string, serverId?: string | null) => void;
    conversationHandlers?: React.ComponentProps<typeof DesktopActivityOverlayExpandedCards>['conversationHandlers'];
    onAction?: DesktopActivityOverlayActionHandler;
    /** The opened list's Bot section (faces' members, each with its ask). */
    bots?: React.ComponentProps<typeof DesktopActivityOverlayExpandedCards>['bots'];
    /** A pinned Bot conversation in place of the list; the shell (insets, scroll, keys) is the same. */
    content?: React.ReactNode;
    /**
     * The list's pin: keeps the island open until Esc, the pin or a click outside. It sits at the end of a status
     * row standing above the panel, and otherwise stands over the panel's top-right corner (lab `ntshape` O).
     */
    pin?: Readonly<{ pinned: boolean; onToggle: () => void }> | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const viewport = useWindowDimensions();
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
    const contentHeightRef = React.useRef(0);
    const overflowRef = React.useRef(0);
    const { onNaturalHeight } = props;
    const reportNaturalHeight = React.useCallback(() => {
        onNaturalHeight?.(insetTop + contentHeightRef.current + overflowRef.current + insetBottom);
    }, [insetBottom, insetTop, onNaturalHeight]);
    const reportOverflow = React.useCallback((overflow: number) => {
        if (overflowRef.current === overflow) return;
        overflowRef.current = overflow;
        reportNaturalHeight();
    }, [reportNaturalHeight]);
    const room = React.useMemo<DesktopActivityOverlayPanelRoom>(() => ({
        available: props.maxHeight === undefined ? null : Math.max(0, props.maxHeight - insetTop - insetBottom),
        reportOverflow,
    }), [insetBottom, insetTop, props.maxHeight, reportOverflow]);
    const onScrollContentSizeChange = scrollFades.onContentSizeChange;
    const handleContentSizeChange = React.useCallback((width: number, height: number) => {
        contentHeightRef.current = height;
        reportNaturalHeight();
        onScrollContentSizeChange(width, height);
    }, [onScrollContentSizeChange, reportNaturalHeight]);
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
    const pinButton = props.pin && !props.content ? (
        <DesktopActivityOverlayPinButton
            testID="desktop-activity-overlay-pin"
            pinned={props.pin.pinned}
            onPress={props.pin.onToggle}
        />
    ) : null;

    // The first row's trailing end clears the corner pin by a step: the pin's inset and width, less the panel's own inset.
    const cornerPinClearance = theme.space.s8 + HAPPIER_ICON_BUTTON_SIZE + theme.space.s4 - resolveDesktopActivityOverlayPanelInsets(theme).panel;

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
            {pinButton ? (
                // Under a status row standing on its edge, the pin sits at that row's trailing end; with no row
                // above, it stands over the panel's top-right corner and the content starts at the top inset.
                <View style={props.underStatusRow ? styles.pinInStatusRow : styles.pinInCorner}>{pinButton}</View>
            ) : null}
            {props.content != null ? (
                <ScrollView testID="desktop-activity-overlay-expanded-scroll" style={[styles.scroll, scrollMaskStyle]}
                    contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} scrollEventThrottle={16}
                    onLayout={scrollFades.onViewportLayout} onContentSizeChange={handleContentSizeChange}
                    onScroll={scrollFades.onScroll} onMomentumScrollEnd={scrollFades.onMomentumScrollEnd}>
                    <DesktopActivityOverlayPanelRoomContext.Provider value={room}>{props.content}</DesktopActivityOverlayPanelRoomContext.Provider>
                </ScrollView>
            ) : (
                <DesktopActivityOverlayExpandedCards bots={props.bots} model={props.model} visualMode={props.visualMode}
                    onOpenSession={props.onOpenSession} conversationHandlers={props.conversationHandlers} onAction={props.onAction}
                    completionAutoDismissPaused={completionAutoDismissPaused}
                    initialFocusRef={props.initialFocusRef} onDismissKey={props.onDismissKey}
                    leadRowClearance={pinButton && !props.underStatusRow ? cornerPinClearance : 0}
                    scroll={{
                        testID: 'desktop-activity-overlay-expanded-scroll',
                        maxHeight: Math.max(0, (props.maxHeight ?? viewport.height) - insetTop - insetBottom),
                        style: [styles.scroll, scrollMaskStyle], showsVerticalScrollIndicator: false, scrollEventThrottle: 16,
                        onLayout: scrollFades.onViewportLayout, onContentSizeChange: handleContentSizeChange,
                        onScroll: scrollFades.onScroll, onMomentumScrollEnd: scrollFades.onMomentumScrollEnd,
                    }} />
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The panel content inside the island: lab `.nt-p` (s12 inset; s8 under a status row on its edge).
    container: {
        width: '100%',
        position: 'relative',
        // The panel's own inset: rows' hover plates start here, everything else one content step in.
        paddingHorizontal: resolveDesktopActivityOverlayPanelInsets(theme).panel,
    },
    pinInStatusRow: {
        position: 'absolute',
        top: -PAGE_LIST_METRICS.controlHeightPx,
        right: theme.space.s8,
        height: PAGE_LIST_METRICS.controlHeightPx,
        justifyContent: 'center',
    },
    pinInCorner: {
        position: 'absolute',
        top: theme.space.s12,
        right: theme.space.s8,
        zIndex: 1,
    },
    scroll: {
        flexGrow: 0,
        flexShrink: 1,
    },
    scrollContent: {
        gap: theme.space.s12,
    },
}));
