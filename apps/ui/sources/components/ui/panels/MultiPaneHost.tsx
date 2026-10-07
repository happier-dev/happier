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

// A pane floating over the main content (overlay presentation) rounds the one edge that shows.
const PANE_OVERLAY_CORNER_RADIUS_PX = 16;
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
    /**
     * `soft` when Details is a drawer opened from the side column's list: the list beside it stays
     * the context, so main is only quieted, not shaded (details lab 2, Q1).
     */
    detailsScrim?: 'standard' | 'soft';
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

    const detailsDocked = layout.details === 'docked' && detailsPresence.present;
    const rightDocked = layout.right === 'docked' && rightPresence.present;
    const shouldHideDockedMainRegion = hideMain === true
        && layout.details !== 'overlay'
        && layout.right !== 'overlay';

    return (
        <View style={{ flex: 1, flexDirection: 'row', position: 'relative' }}>
            {shouldHideDockedMainRegion ? null : (
                <View key="main" style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
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
                        <PaneAnimatedScrimPressable
                            testID="multi-pane-details-scrim"
                            accessibilityRole="button"
                            accessibilityLabel={t('ui.modalPane.dismiss', { pane: detailsModalLabel })}
                            onPress={detailsPresence.requestClose}
                            animatedStyle={{
                                position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
                                zIndex: overlayZIndexBase,
                                backgroundColor: props.detailsScrim === 'soft'
                                    ? (theme.dark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.07)')
                                    : (theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)'),
                                opacity: detailsPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                            }}
                        />
                    ) : null}
                    {rightModalActive ? (
                        <PaneAnimatedScrimPressable
                            testID="multi-pane-right-scrim"
                            accessibilityRole="button"
                            accessibilityLabel={t('ui.modalPane.dismiss', { pane: rightModalLabel })}
                            onPress={rightPresence.requestClose}
                            animatedStyle={{
                                position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
                                zIndex: overlayZIndexBase + 2,
                                backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
                                opacity: rightPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                            }}
                        />
                    ) : null}
                </View>
            )}
            {detailsPresence.present ? (
                <PaneColumn
                    key="details"
                    name="details"
                    presentation={layout.details}
                    modalActive={detailsModalActive}
                    progress={detailsPresence.progress}
                    widthPx={detailsDockWidthPx}
                    minWidthPx={props.detailsDockMinWidthPx ?? 320}
                    maxWidthPx={props.detailsDockMaxWidthPx ?? 900}
                    onCommitWidthPx={props.onCommitDetailsDockWidthPx}
                    onDragWidthPx={props.onDragDetailsDockWidthPx}
                    overlayRightInsetPx={rightDocked ? rightDockWidthPx : 0}
                    overlayZIndex={overlayZIndexBase + 1}
                    overlayFocusRef={detailsModalBoundary.setOverlayFocusRef}
                    overlayProps={detailsModalOverlayProps}
                    underlayProps={rightModalActive ? rightModalBoundary.underlayProps : undefined}
                    nativeAccessibilityFocusAnchor={detailsNativeAccessibilityFocusAnchor}
                    nativeBackLayer={detailsNativeBackLayer}
                    focusEligible={layout.details === 'docked' ? !rightModalActive : detailsOverlayFocusEligible}
                >
                    {detailsPresence.node}
                </PaneColumn>
            ) : null}
            {rightPresence.present ? (
                <PaneColumn
                    key="right"
                    name="right"
                    presentation={layout.right}
                    modalActive={rightModalActive}
                    progress={rightPresence.progress}
                    widthPx={rightDockWidthPx}
                    minWidthPx={props.rightDockMinWidthPx ?? 260}
                    maxWidthPx={props.rightDockMaxWidthPx ?? 720}
                    onCommitWidthPx={props.onCommitRightDockWidthPx}
                    onDragWidthPx={props.onDragRightDockWidthPx}
                    overlayRightInsetPx={detailsDocked ? detailsDockWidthPx : 0}
                    overlayZIndex={overlayZIndexBase + 3}
                    overlayFocusRef={rightModalBoundary.setOverlayFocusRef}
                    overlayProps={rightModalOverlayProps}
                    underlayProps={detailsModalActive ? detailsModalBoundary.underlayProps : undefined}
                    nativeAccessibilityFocusAnchor={rightNativeAccessibilityFocusAnchor}
                    nativeBackLayer={rightNativeBackLayer}
                    focusEligible={layout.right === 'docked' ? !detailsModalActive : rightOverlayFocusEligible}
                >
                    {rightPresence.node}
                </PaneColumn>
            ) : null}
        </View>
    );
});

/**
 * One mounted column per pane. Docking, overlaying and parking change its layout and modal
 * attributes, never its parents: a pane's editor draft, focus and scroll belong to this instance.
 */
function PaneColumn(props: Readonly<{
    name: 'right' | 'details';
    presentation: ResolvedPaneLayout['details'];
    modalActive: boolean;
    progress: Animated.Value;
    widthPx: number;
    minWidthPx: number;
    maxWidthPx: number;
    onCommitWidthPx: (widthPx: number) => void;
    onDragWidthPx?: (widthPx: number | null) => void;
    overlayRightInsetPx: number;
    overlayZIndex: number;
    overlayFocusRef: ReturnType<typeof useModalPaneBoundary>['setOverlayFocusRef'];
    overlayProps: Omit<ReturnType<typeof useModalPaneBoundary>['overlayProps'], 'nativeAccessibilityFocusAnchor' | 'nativeBackLayer'>;
    underlayProps?: Readonly<Record<string, unknown>>;
    nativeAccessibilityFocusAnchor: ReturnType<typeof useModalPaneBoundary>['overlayProps']['nativeAccessibilityFocusAnchor'];
    nativeBackLayer: ReturnType<typeof useModalPaneBoundary>['overlayProps']['nativeBackLayer'];
    focusEligible: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const docked = props.presentation === 'docked';
    const overlay = props.presentation === 'overlay';
    const hidden = props.presentation === 'hidden';
    const boundaryProps = props.modalActive ? props.overlayProps : (props.underlayProps ?? {});
    return (
        <Animated.View
            style={docked ? {
                position: 'relative',
                width: props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, props.widthPx] }),
                overflow: 'hidden',
                flexShrink: 0,
                alignSelf: 'stretch',
                height: '100%',
                opacity: props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                transform: [{ translateX: props.progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
            } : {
                position: 'absolute',
                top: 0,
                right: props.overlayRightInsetPx,
                bottom: 0,
                zIndex: overlay ? props.overlayZIndex : -1,
                backgroundColor: theme.colors.surface.base,
                opacity: overlay ? props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) : 0,
                ...(overlay ? {
                    borderTopLeftRadius: PANE_OVERLAY_CORNER_RADIUS_PX,
                    borderBottomLeftRadius: PANE_OVERLAY_CORNER_RADIUS_PX,
                    overflow: 'hidden',
                    ...shadowLevelStyle(theme.colors.shadowLevels[6]),
                } : {}),
                transform: [{ translateX: overlay
                    ? props.progress.interpolate({ inputRange: [0, 1], outputRange: [props.widthPx, 0] })
                    : props.widthPx }],
            }}
        >
            <ModalPaneBoundaryView
                ref={props.modalActive ? props.overlayFocusRef : undefined}
                testID={hidden ? `multi-pane-${props.name}-parked`
                    : props.modalActive ? `multi-pane-${props.name}-modal` : undefined}
                {...boundaryProps}
                suppressDescendantPaneBoundaries={hidden || (!props.modalActive && props.underlayProps?.suppressDescendantPaneBoundaries === true)}
                {...(hidden ? {
                    pointerEvents: 'none' as const,
                    ...(Platform.OS === 'web'
                        ? { inert: true, 'aria-hidden': true as const }
                        : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const }),
                } : {})}
                style={{ flex: 1, minHeight: 0, minWidth: 0, zIndex: overlay ? props.overlayZIndex : undefined }}
            >
                <ResizableDockedPane
                    testID={`multi-pane-${props.name}-${docked ? 'docked' : 'overlay'}`}
                    widthPx={props.widthPx}
                    minWidthPx={props.minWidthPx}
                    maxWidthPx={props.maxWidthPx}
                    onCommitWidthPx={props.onCommitWidthPx}
                    onDragWidthPx={props.onDragWidthPx}
                >
                    <ModalPaneBoundaryView
                        nativeAccessibilityFocusAnchor={props.nativeAccessibilityFocusAnchor}
                        nativeBackLayer={props.nativeBackLayer}
                        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                    >
                        <View style={{
                            flex: 1, minHeight: 0, minWidth: 0,
                            borderLeftWidth: docked ? StyleSheet.hairlineWidth : 0,
                            borderLeftColor: theme.colors.border.subtle,
                            backgroundColor: theme.colors.surface.base,
                            overflow: 'hidden',
                        }}>
                            <PluginSurfaceFocusEligibilityProvider active={props.focusEligible}>
                                {props.children}
                            </PluginSurfaceFocusEligibilityProvider>
                        </View>
                    </ModalPaneBoundaryView>
                </ResizableDockedPane>
            </ModalPaneBoundaryView>
        </Animated.View>
    );
}
