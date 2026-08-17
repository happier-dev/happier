import * as React from 'react';
import { Animated, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { MultiPaneHost, type MultiPaneHostProps } from './MultiPaneHost';
import { ResizableDockedPaneVertical } from './resizable/ResizableDockedPaneVertical';
import { PaneAnimatedScrimPressable } from './motion/PaneAnimatedScrimPressable';
import {
    ModalPaneBoundaryView,
    useModalPaneBoundary,
    useModalPanePresentation,
} from './ModalPaneBoundary';
import type { FocusReturnMutableRef } from '@/keyboard/focusReturn';
import { ESCAPE_LAYER_PRIORITIES } from '@/keyboard/escape';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { t } from '@/text';

export type BottomPanePresentation = 'docked' | 'overlay';

export type MultiPaneHostWithBottomProps = MultiPaneHostProps & Readonly<{
    bottomPane: React.ReactNode | null;
    bottomPresentation: BottomPanePresentation;
    bottomDockHeightPx: number;
    bottomDockMinHeightPx: number;
    bottomDockMaxHeightPx: number;
    onCloseBottom: () => void;
    onCommitBottomDockHeightPx: (heightPx: number) => void;
    onDragBottomDockHeightPx?: (heightPx: number | null) => void;
    bottomOverlayFocusReturnRef?: FocusReturnMutableRef;
}>;

export const MultiPaneHostWithBottom = React.memo((props: MultiPaneHostWithBottomProps) => {
    const {
        bottomPane,
        bottomPresentation,
        bottomDockHeightPx,
        bottomDockMinHeightPx,
        bottomDockMaxHeightPx,
        onCloseBottom,
        onCommitBottomDockHeightPx,
        onDragBottomDockHeightPx,
        bottomOverlayFocusReturnRef,
        ...multiPaneProps
    } = props;

    const { theme } = useUnistyles();
    const overlayZIndexBase = 80;
    const bottomPresence = useModalPanePresentation({
        targetOpen: Boolean(bottomPane),
        node: bottomPane,
        overlay: bottomPresentation === 'overlay',
        onClose: onCloseBottom,
    });
    const shouldRenderBottomPane = bottomPresence.present;
    const renderedBottomPane = bottomPresence.node;
    const isBottomOverlayPresented = bottomPresentation === 'overlay' && bottomPresence.present;
    const bottomModalLabel = t('ui.modalPane.bottom');
    const bottomModalBoundary = useModalPaneBoundary({
        active: isBottomOverlayPresented,
        label: bottomModalLabel,
        onRequestClose: bottomPresence.requestClose,
        focusReturnRef: bottomOverlayFocusReturnRef,
        discardPendingFocusReturn: bottomPane != null && bottomPresentation !== 'overlay',
        escapeEnabled: shouldRenderBottomPane,
        escapePriority: isBottomOverlayPresented
            ? ESCAPE_LAYER_PRIORITIES.overlay
            : ESCAPE_LAYER_PRIORITIES.pane,
        allowEditableEscape: isBottomOverlayPresented,
    });
    const {
        nativeAccessibilityFocusAnchor: bottomNativeAccessibilityFocusAnchor,
        nativeBackLayer: bottomNativeBackLayer,
        ...bottomModalOverlayProps
    } = bottomModalBoundary.overlayProps;

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <ModalPaneBoundaryView
                ref={bottomModalBoundary.setUnderlayFocusRef}
                testID={isBottomOverlayPresented ? 'multi-pane-bottom-underlay' : undefined}
                style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}
                {...bottomModalBoundary.underlayProps}
            >
                <PluginSurfaceFocusEligibilityProvider active={!isBottomOverlayPresented}>
                    <MultiPaneHost {...multiPaneProps} />
                </PluginSurfaceFocusEligibilityProvider>
            </ModalPaneBoundaryView>

            {shouldRenderBottomPane ? (
                <Animated.View
                    ref={isBottomOverlayPresented ? bottomModalBoundary.setOverlayFocusRef : undefined}
                    testID={isBottomOverlayPresented ? 'multi-pane-bottom-overlay' : undefined}
                    {...(isBottomOverlayPresented ? bottomModalOverlayProps : {})}
                    style={
                        bottomPresentation === 'overlay'
                            ? {
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                bottom: 0,
                                zIndex: overlayZIndexBase + 1,
                                backgroundColor: theme.colors.surface.base,
                                borderTopWidth: 1,
                                borderTopColor: theme.colors.border.default,
                                overflow: 'hidden',
                                transform: [{
                                    translateY: bottomPresence.progress.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [Math.max(24, bottomDockHeightPx), 0],
                                    }),
                                }],
                                opacity: bottomPresence.progress.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, 1],
                                }),
                            }
                            : {
                                position: 'relative',
                                alignSelf: 'stretch',
                                width: '100%',
                                height: bottomPresence.progress.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, bottomDockHeightPx],
                                }),
                                overflow: 'hidden',
                                opacity: bottomPresence.progress.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, 1],
                                }),
                                transform: [{
                                    translateY: bottomPresence.progress.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [12, 0],
                                    }),
                                }],
                            }
                    }
                    >
                        <ResizableDockedPaneVertical
                        testID={bottomPresentation === 'overlay' ? 'multi-pane-bottom-overlay-pane' : 'multi-pane-bottom-dock'}
                        resizeHandleTestID={
                            bottomPresentation === 'overlay'
                                ? 'multi-pane-bottom-overlay-resize-handle'
                                : 'multi-pane-bottom-dock-resize-handle'
                        }
                        heightPx={bottomDockHeightPx}
                        minHeightPx={bottomDockMinHeightPx}
                        maxHeightPx={bottomDockMaxHeightPx}
                        resizeEdge="top"
                        onCommitHeightPx={onCommitBottomDockHeightPx}
                        onDragHeightPx={onDragBottomDockHeightPx}
                        >
                            <ModalPaneBoundaryView
                                nativeAccessibilityFocusAnchor={bottomNativeAccessibilityFocusAnchor}
                                nativeBackLayer={bottomNativeBackLayer}
                                style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                            >
                                <PluginSurfaceFocusEligibilityProvider
                                    active={bottomPresentation !== 'overlay' || !bottomPresence.closing}
                                >
                                    {renderedBottomPane}
                                </PluginSurfaceFocusEligibilityProvider>
                            </ModalPaneBoundaryView>
                        </ResizableDockedPaneVertical>
                </Animated.View>
            ) : null}

            {isBottomOverlayPresented ? (
                <>
                    <PaneAnimatedScrimPressable
                        testID="multi-pane-bottom-scrim"
                        accessibilityRole="button"
                        accessibilityLabel={t('ui.modalPane.dismiss', { pane: bottomModalLabel })}
                        onPress={bottomPresence.requestClose}
                        animatedStyle={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            left: 0,
                            zIndex: overlayZIndexBase,
                            backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
                            opacity: bottomPresence.progress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [0, 1],
                            }),
                        }}
                    />

                </>
            ) : null}
        </View>
    );
});
