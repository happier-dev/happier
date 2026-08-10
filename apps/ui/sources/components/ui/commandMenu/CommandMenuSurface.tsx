import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
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

type WebPointerDownEvent = Readonly<{ preventDefault?: () => void }>;

/**
 * A command menu never takes keyboard focus: the host text field keeps it and
 * drives the menu (`useCommandMenuKeyboard` is wired into the host's own key
 * handler, and the rows carry no tab stop of their own).
 *
 * On web the browser's default action for a pointer press is to move focus to
 * whatever was pressed, which blurs that host field. Hosts close the menu when
 * their field blurs — `AgentInput` gates the whole suggestion query on
 * `isInputFocused` — so the pressed row unmounts between `mousedown` and
 * `mouseup`, the browser then delivers no `click` at all, and the press is
 * silently swallowed. Only the keyboard path (Tab/Enter) survived, because it
 * never moves focus. Cancelling the pointer-down default keeps focus where it
 * is, so the row lives long enough to receive its press.
 *
 * Bubble phase (`onMouseDown`) is deliberate: it is the only mouse-down prop
 * react-native-web forwards to the DOM node, and `preventDefault()` there still
 * runs before the browser performs the focus shift. No consumer renders a
 * focusable control inside the menu, so cancelling for the whole surface is safe.
 */
const preserveHostFocusOnWebPointerDown = Platform.OS === 'web'
    ? {
        onMouseDown: (event: WebPointerDownEvent) => {
            event?.preventDefault?.();
        },
    }
    : {};

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
                <View testID={testID} collapsable={false} {...preserveHostFocusOnWebPointerDown}>
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
