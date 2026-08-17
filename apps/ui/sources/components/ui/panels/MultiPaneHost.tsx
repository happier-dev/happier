import * as React from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ResolvedPaneLayout } from './paneBreakpoints';
import { ResizableDockedPane } from './ResizableDockedPane';
import { PaneAnimatedScrimPressable } from './motion/PaneAnimatedScrimPressable';
import {
    ModalPaneBoundaryView,
    useModalPaneBoundary,
    useModalPanePresentation,
} from './ModalPaneBoundary';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { FocusReturnMutableRef } from '@/keyboard/focusReturn';
import { ESCAPE_LAYER_PRIORITIES } from '@/keyboard/escape';
import { t } from '@/text';
import { shadowLevelStyle } from '@/shadowElevation';

// One radius wherever a pane meets the header. The header spans above these columns and is not
// part of them, so a square top-left corner reads as a slab wedged underneath; rounding it lets
// the pane sit into the header instead. Matches the content sheet's seam radius.
const PANE_TOP_CORNER_RADIUS_PX = 16;
// The pre-boundary Escape owner closes Details before Right when both docked
// columns are present. Keep that user-visible precedence inside the one pane
// layer rather than relying on hook registration order.
const DOCKED_DETAILS_ESCAPE_PRIORITY = ESCAPE_LAYER_PRIORITIES.pane + 1;

export type MultiPaneHostProps = Readonly<{
    main: React.ReactNode;
    hideMain?: boolean;
    rightPane: React.ReactNode | null;
    detailsPane: React.ReactNode | null;
    layout: ResolvedPaneLayout;
    rightDockWidthPx: number;
    detailsDockWidthPx: number;
    rightDockMinWidthPx?: number;
    rightDockMaxWidthPx?: number;
    detailsDockMinWidthPx?: number;
    detailsDockMaxWidthPx?: number;
    onCloseRight: () => void;
    onCloseDetails: () => void;
    onCommitRightDockWidthPx: (widthPx: number) => void;
    onCommitDetailsDockWidthPx: (widthPx: number) => void;
    onDragRightDockWidthPx?: (widthPx: number | null) => void;
    onDragDetailsDockWidthPx?: (widthPx: number | null) => void;
    rightOverlayFocusReturnRef?: FocusReturnMutableRef;
    detailsOverlayFocusReturnRef?: FocusReturnMutableRef;
}>;

export const MultiPaneHost = React.memo((props: MultiPaneHostProps) => {
    const {
        main,
        hideMain,
        rightPane,
        detailsPane,
        layout,
        rightDockWidthPx,
        detailsDockWidthPx,
        onCloseRight,
        onCloseDetails,
    } = props;

    const { theme } = useUnistyles();
    const overlayZIndexBase = 50;

    // One surface for both docked panes. Details and right are separate columns wearing identical
    // chrome; while this lived inline in each of them the two copies had to be edited in lockstep,
    // which is exactly the shape that lets one quietly fall behind the other.
    const dockedPaneSurfaceStyle = React.useMemo(() => ({
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        // Both edges that face the app get the line. The pane is inset from the top as well as the
        // left — the header runs above it — so stopping at the left edge left the rounded corner
        // trailing off into nothing where the arc turned horizontal.
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderTopWidth: StyleSheet.hairlineWidth,
        // Half the weight of border.default on purpose: the wrapper's cast carries the separation,
        // so this line only has to define the edge. Alpha, not a flat hex, so it composites over
        // whatever is behind.
        borderLeftColor: theme.colors.border.subtle,
        borderTopColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
        borderTopLeftRadius: PANE_TOP_CORNER_RADIUS_PX,
        // Required for the radius to be visible at all: the pane's children paint their own
        // backgrounds (the tab strip's inset fill) straight into the corner otherwise. An element's
        // own `overflow` clips its DESCENDANTS, not the shadow it casts itself, so the seam on the
        // animated wrapper above survives this.
        overflow: 'hidden' as const,
    }), [theme]);

    // Pane *presence* is the logical open signal. Layout controls whether it's docked/overlay/hidden.
    // This lets us keep a pane mounted (state preserved) even when the layout temporarily hides it
    // (e.g. overlayStack where details overlays and right is hidden).
    const detailsPresence = useModalPanePresentation({
        targetOpen: Boolean(detailsPane),
        node: detailsPane,
        overlay: layout.details === 'overlay',
        onClose: onCloseDetails,
    });
    const rightPresence = useModalPanePresentation({
        targetOpen: Boolean(rightPane),
        node: rightPane,
        overlay: layout.right === 'overlay',
        onClose: onCloseRight,
    });
    const rightModalActive = layout.right === 'overlay' && rightPresence.present;
    const detailsModalActive = layout.details === 'overlay' && detailsPresence.present && !rightModalActive;
    const rightModalLabel = t('ui.modalPane.right');
    const detailsModalLabel = t('ui.modalPane.details');
    const detailsModalBoundary = useModalPaneBoundary({
        active: detailsModalActive,
        label: detailsModalLabel,
        onRequestClose: detailsPresence.requestClose,
        focusReturnRef: props.detailsOverlayFocusReturnRef,
        discardPendingFocusReturn: Boolean(detailsPane) && layout.details !== 'overlay',
        escapeEnabled: detailsModalActive || (layout.details === 'docked' && detailsPresence.present),
        escapePriority: detailsModalActive
            ? ESCAPE_LAYER_PRIORITIES.overlay
            : DOCKED_DETAILS_ESCAPE_PRIORITY,
        allowEditableEscape: detailsModalActive,
    });
    const rightModalBoundary = useModalPaneBoundary({
        active: rightModalActive,
        label: rightModalLabel,
        onRequestClose: rightPresence.requestClose,
        focusReturnRef: props.rightOverlayFocusReturnRef,
        discardPendingFocusReturn: Boolean(rightPane) && layout.right !== 'overlay',
        escapeEnabled: rightModalActive || (layout.right === 'docked' && rightPresence.present),
        escapePriority: rightModalActive
            ? ESCAPE_LAYER_PRIORITIES.overlay
            : ESCAPE_LAYER_PRIORITIES.pane,
        allowEditableEscape: rightModalActive,
    });
    const {
        nativeAccessibilityFocusAnchor: detailsNativeAccessibilityFocusAnchor,
        nativeBackLayer: detailsNativeBackLayer,
        ...detailsModalOverlayProps
    } = detailsModalBoundary.overlayProps;
    const {
        nativeAccessibilityFocusAnchor: rightNativeAccessibilityFocusAnchor,
        nativeBackLayer: rightNativeBackLayer,
        ...rightModalOverlayProps
    } = rightModalBoundary.overlayProps;
    const activeMainBoundary = rightModalActive
        ? rightModalBoundary
        : detailsModalActive
            ? detailsModalBoundary
            : null;
    const setMainUnderlayFocusRef = React.useCallback<React.RefCallback<HTMLElement>>((node) => {
        detailsModalBoundary.setUnderlayFocusRef(node);
        rightModalBoundary.setUnderlayFocusRef(node);
    }, [detailsModalBoundary, rightModalBoundary]);
    // The pane host already owns these visible/covered facts. Feed them into
    // the private focus boundary instead of asking plugin surfaces to infer
    // their own presentation state.
    const mainFocusEligible = activeMainBoundary === null;
    const detailsOverlayFocusEligible = detailsModalActive && !detailsPresence.closing;
    const rightOverlayFocusEligible = rightModalActive && !rightPresence.closing;

    const mainRegion = (
        <View style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
            <ModalPaneBoundaryView
                ref={setMainUnderlayFocusRef}
                testID="multi-pane-main-underlay"
                style={{ flex: 1, minWidth: 0, minHeight: 0 }}
                {...(activeMainBoundary?.underlayProps ?? {})}
            >
                <PluginSurfaceFocusEligibilityProvider active={mainFocusEligible}>
                    {main}
                </PluginSurfaceFocusEligibilityProvider>
            </ModalPaneBoundaryView>

            {detailsModalActive ? (
                <>
                    <PaneAnimatedScrimPressable
                        testID="multi-pane-details-scrim"
                        accessibilityRole="button"
                        accessibilityLabel={t('ui.modalPane.dismiss', { pane: detailsModalLabel })}
                        onPress={detailsPresence.requestClose}
                        animatedStyle={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            left: 0,
                            zIndex: overlayZIndexBase,
                            backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
                            opacity: detailsPresence.progress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [0, 1],
                            }),
                        }}
                    />
                    <Animated.View
                        ref={detailsModalBoundary.setOverlayFocusRef}
                        testID="multi-pane-details-modal"
                        {...detailsModalOverlayProps}
                        style={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            zIndex: overlayZIndexBase + 1,
                            backgroundColor: theme.colors.surface.base,
                            // Overlay only. Docked, this pane is part of the layout and its seam is
                            // the hairline border; floating above the content it is a modal surface,
                            // so it takes the modal elevation and rounds the one edge that shows.
                            // Its own `overflow` clips the content, not the shadow it casts.
                            borderTopLeftRadius: PANE_TOP_CORNER_RADIUS_PX,
                            borderBottomLeftRadius: PANE_TOP_CORNER_RADIUS_PX,
                            overflow: 'hidden',
                            ...shadowLevelStyle(theme.colors.shadowLevels[6]),
                            transform: [
                                {
                                    translateX: detailsPresence.progress.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [detailsDockWidthPx, 0],
                                    }),
                                },
                            ],
                        }}
                    >
                        <ResizableDockedPane
                            testID="multi-pane-details-overlay"
                            widthPx={detailsDockWidthPx}
                            minWidthPx={props.detailsDockMinWidthPx ?? 320}
                            maxWidthPx={props.detailsDockMaxWidthPx ?? 900}
                            onCommitWidthPx={props.onCommitDetailsDockWidthPx}
                            onDragWidthPx={props.onDragDetailsDockWidthPx}
                        >
                            <ModalPaneBoundaryView
                                nativeAccessibilityFocusAnchor={detailsNativeAccessibilityFocusAnchor}
                                nativeBackLayer={detailsNativeBackLayer}
                                style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                            >
                                <PluginSurfaceFocusEligibilityProvider active={detailsOverlayFocusEligible}>
                                    {detailsPresence.node}
                                </PluginSurfaceFocusEligibilityProvider>
                            </ModalPaneBoundaryView>
                        </ResizableDockedPane>
                    </Animated.View>
                </>
            ) : null}

            {layout.kind === 'overlayStack' && rightPresence.present && (layout.right === 'overlay' || layout.right === 'hidden') ? (
                <>
                    {rightModalActive ? (
                        <PaneAnimatedScrimPressable
                            testID="multi-pane-right-scrim"
                            accessibilityRole="button"
                            accessibilityLabel={t('ui.modalPane.dismiss', { pane: rightModalLabel })}
                            onPress={rightPresence.requestClose}
                            animatedStyle={{
                                position: 'absolute',
                                top: 0,
                                right: 0,
                                bottom: 0,
                                left: 0,
                                zIndex: overlayZIndexBase + 2,
                                backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
                                opacity: rightPresence.progress.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, 1],
                                }),
                            }}
                        />
                    ) : null}
                    <Animated.View
                        ref={rightModalActive ? rightModalBoundary.setOverlayFocusRef : undefined}
                        testID={rightModalActive ? 'multi-pane-right-modal' : undefined}
                        {...(rightModalActive ? rightModalOverlayProps : {})}
                        style={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            zIndex: layout.right === 'overlay' ? overlayZIndexBase + 3 : overlayZIndexBase - 1,
                            backgroundColor: theme.colors.surface.base,
                            opacity: layout.right === 'overlay' ? 1 : 0,
                            // Same rule as the details overlay: a floating pane is a modal surface,
                            // a hidden/parked one is not.
                            ...(layout.right === 'overlay'
                                ? {
                                    borderTopLeftRadius: PANE_TOP_CORNER_RADIUS_PX,
                                    borderBottomLeftRadius: PANE_TOP_CORNER_RADIUS_PX,
                                    overflow: 'hidden' as const,
                                    ...shadowLevelStyle(theme.colors.shadowLevels[6]),
                                }
                                : null),
                            transform: [
                                {
                                    translateX: layout.right === 'overlay'
                                        ? rightPresence.progress.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [rightDockWidthPx, 0],
                                        })
                                        : rightDockWidthPx,
                                },
                            ],
                        }}
                    >
                        <ModalPaneBoundaryView
                            testID={layout.right === 'hidden' ? 'multi-pane-right-parked' : undefined}
                            nativeAccessibilityFocusAnchor={rightNativeAccessibilityFocusAnchor}
                            nativeBackLayer={rightNativeBackLayer}
                            suppressDescendantPaneBoundaries={layout.right === 'hidden'}
                            style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                            pointerEvents={layout.right === 'hidden' ? 'none' : 'auto'}
                            inert={Platform.OS === 'web' && layout.right === 'hidden' ? true : undefined}
                            aria-hidden={Platform.OS === 'web' && layout.right === 'hidden' ? true : undefined}
                            accessibilityElementsHidden={Platform.OS === 'web' ? undefined : layout.right === 'hidden'}
                            importantForAccessibility={Platform.OS === 'web'
                                ? undefined
                                : layout.right === 'hidden' ? 'no-hide-descendants' : 'auto'}
                        >
                            <ResizableDockedPane
                                testID="multi-pane-right-overlay"
                                widthPx={rightDockWidthPx}
                                minWidthPx={props.rightDockMinWidthPx ?? 260}
                                maxWidthPx={props.rightDockMaxWidthPx ?? 720}
                                onCommitWidthPx={props.onCommitRightDockWidthPx}
                                onDragWidthPx={props.onDragRightDockWidthPx}
                            >
                                <PluginSurfaceFocusEligibilityProvider active={rightOverlayFocusEligible}>
                                    {rightPresence.node}
                                </PluginSurfaceFocusEligibilityProvider>
                            </ResizableDockedPane>
                        </ModalPaneBoundaryView>
                    </Animated.View>
                </>
            ) : null}
        </View>
    );

    const detailsDocked =
        layout.details === 'docked' && detailsPresence.present ? (
            <Animated.View
                style={{
                    width: detailsPresence.progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, detailsDockWidthPx],
                    }),
                    overflow: 'hidden',
                    flexShrink: 0,
                    alignSelf: 'stretch',
                    height: '100%',
                    // The seam cast lives on this element, not the inner surface: overflow:'hidden'
                    // above clips any shadow a child tries to throw past the pane edge. An element's
                    // own shadow is not clipped by its own overflow, so this is the only owner that
                    // can reach the main content. x-offset only, no spread, web-only.
                    ...(Platform.OS === 'web'
                        ? { boxShadow: theme.colors.shadowSeamCastBoxShadow }
                        : {}),
                    opacity: detailsPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                    transform: [
                        {
                            translateX: detailsPresence.progress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [12, 0],
                            }),
                        },
                    ],
                }}
            >
                <ModalPaneBoundaryView
                    style={{ flex: 1, minWidth: 0, minHeight: 0 }}
                    {...(rightModalActive ? rightModalBoundary.underlayProps : {})}
                >
                    <ResizableDockedPane
                        testID="multi-pane-details-docked"
                        widthPx={detailsDockWidthPx}
                        minWidthPx={props.detailsDockMinWidthPx ?? 320}
                        maxWidthPx={props.detailsDockMaxWidthPx ?? 900}
                        onCommitWidthPx={props.onCommitDetailsDockWidthPx}
                        onDragWidthPx={props.onDragDetailsDockWidthPx}
                    >
                        <View style={dockedPaneSurfaceStyle}>
                            <PluginSurfaceFocusEligibilityProvider active={!rightModalActive}>
                                {detailsPresence.node}
                            </PluginSurfaceFocusEligibilityProvider>
                        </View>
                    </ResizableDockedPane>
                </ModalPaneBoundaryView>
            </Animated.View>
        ) : null;

    const rightDocked =
        layout.right === 'docked' && rightPresence.present ? (
            <Animated.View
                style={{
                    width: rightPresence.progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, rightDockWidthPx],
                    }),
                    overflow: 'hidden',
                    flexShrink: 0,
                    alignSelf: 'stretch',
                    height: '100%',
                    // The seam cast lives on this element, not the inner surface: overflow:'hidden'
                    // above clips any shadow a child tries to throw past the pane edge. An element's
                    // own shadow is not clipped by its own overflow, so this is the only owner that
                    // can reach the main content. x-offset only, no spread, web-only.
                    ...(Platform.OS === 'web'
                        ? { boxShadow: theme.colors.shadowSeamCastBoxShadow }
                        : {}),
                    opacity: rightPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                    transform: [
                        {
                            translateX: rightPresence.progress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [12, 0],
                            }),
                        },
                    ],
                }}
            >
                <ModalPaneBoundaryView
                    style={{ flex: 1, minWidth: 0, minHeight: 0 }}
                    {...(detailsModalActive ? detailsModalBoundary.underlayProps : {})}
                >
                    <ResizableDockedPane
                        testID="multi-pane-right-docked"
                        widthPx={rightDockWidthPx}
                        minWidthPx={props.rightDockMinWidthPx ?? 260}
                        maxWidthPx={props.rightDockMaxWidthPx ?? 720}
                        onCommitWidthPx={props.onCommitRightDockWidthPx}
                        onDragWidthPx={props.onDragRightDockWidthPx}
                    >
                        <View style={dockedPaneSurfaceStyle}>
                            <PluginSurfaceFocusEligibilityProvider active={!detailsModalActive}>
                                {rightPresence.node}
                            </PluginSurfaceFocusEligibilityProvider>
                        </View>
                    </ResizableDockedPane>
                </ModalPaneBoundaryView>
            </Animated.View>
        ) : null;

    const shouldHideDockedMainRegion = hideMain === true
        && layout.details !== 'overlay'
        && layout.right !== 'overlay';

    return (
        <View style={{ flex: 1, flexDirection: 'row' }}>
            {[
                // Keep the main region under the same keyed parent for single and multi-pane
                // layouts so opening or closing a docked pane does not remount the transcript.
                shouldHideDockedMainRegion ? null : <React.Fragment key="main">{mainRegion}</React.Fragment>,
                detailsDocked ? <React.Fragment key="details">{detailsDocked}</React.Fragment> : null,
                rightDocked ? <React.Fragment key="right">{rightDocked}</React.Fragment> : null,
            ]}
        </View>
    );
});
