import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import {
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
    Popover,
    type PopoverBackdropOptions,
    type PopoverPlacement,
} from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import type { CommandMenuAnchor } from './commandMenuTypes';

const DEFAULT_MAX_HEIGHT = 280;
const DEFAULT_MAX_WIDTH = 400;
const DEFAULT_GAP = 4;

interface CommandMenuSurfaceProps {
    open: boolean;
    anchor: CommandMenuAnchor;
    children: React.ReactNode;
    maxHeight?: number;
    maxWidth?: number;
    placement?: PopoverPlacement;
    gap?: number;
    boundaryRef?: React.RefObject<any> | null;
    keyboardBottomInset?: number;
    edgePadding?: number | Readonly<{ horizontal?: number; vertical?: number }>;
    backdrop?: PopoverBackdropOptions;
    consumeOutsidePointerDown?: boolean;
    containerStyle?: StyleProp<ViewStyle>;
    onRequestClose: () => void;
    testID?: string;
}

/**
 * Popover (positioner) + FloatingOverlay (themed chrome) wrapper for CommandMenu.
 *
 * D6/D12: Popover owns positioning; FloatingOverlay owns border/shadow/scroll-fades.
 * D29: Animations reuse overlayMotion presets via Popover's built-in motion.
 */
export const CommandMenuSurface = React.memo((props: CommandMenuSurfaceProps) => {
    const {
        open,
        anchor,
        children,
        maxHeight = DEFAULT_MAX_HEIGHT,
        maxWidth = DEFAULT_MAX_WIDTH,
        placement = 'auto-vertical',
        gap = DEFAULT_GAP,
        boundaryRef,
        keyboardBottomInset,
        edgePadding,
        backdrop = { enabled: false },
        consumeOutsidePointerDown,
        containerStyle,
        onRequestClose,
        testID,
    } = props;

    // For view-anchor mode we need a ref; for rect-anchor mode we pass the anchor directly.
    const anchorRef = anchor.kind === 'view' ? anchor.ref : undefined;

    return (
        <Popover
            open={open}
            anchor={anchor}
            anchorRef={anchorRef}
            placement={placement}
            gap={gap}
            maxHeightCap={maxHeight}
            maxWidthCap={maxWidth}
            boundaryRef={boundaryRef}
            keyboardBottomInset={keyboardBottomInset}
            edgePadding={edgePadding}
            containerStyle={containerStyle}
            consumeOutsidePointerDown={consumeOutsidePointerDown}
            onRequestClose={onRequestClose}
            backdrop={backdrop}
            portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
        >
            {({ maxHeight: resolvedMaxHeight }) => (
                <View testID={testID} collapsable={false}>
                    <FloatingOverlay
                        maxHeight={resolvedMaxHeight}
                        scrollEnabled={false}
                        edgeFades={{ top: true, bottom: true, size: 18 }}
                        edgeIndicators
                        surfaceChrome="theme"
                    >
                        {children}
                    </FloatingOverlay>
                </View>
            )}
        </Popover>
    );
});
