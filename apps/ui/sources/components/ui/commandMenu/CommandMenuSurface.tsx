import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import {
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
    Popover,
    type PopoverBackdropOptions,
    type PopoverPlacement,
    type PopoverPortalOptions,
} from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import type { CommandMenuAnchor } from './commandMenuTypes';

const DEFAULT_MAX_HEIGHT = 280;
const DEFAULT_MAX_WIDTH = 400;
const DEFAULT_GAP = 4;
let anchorWidthPortalOptions: PopoverPortalOptions | null = null;
/** The modal-aware portal, sized to the anchor; built once, on first use, so its identity is stable. */
function resolveAnchorWidthPortalOptions(): PopoverPortalOptions {
    anchorWidthPortalOptions ??= { ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, matchAnchorWidth: true };
    return anchorWidthPortalOptions;
}
const fillStyles = {
    frame: { flexDirection: 'column', minHeight: 0 },
    body: { flex: 1, minHeight: 0 },
} as const satisfies Record<string, ViewStyle>;

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
    header?: React.ReactNode;
    footer?: React.ReactNode;
    maxHeight?: number;
    maxWidth?: number;
    placement?: PopoverPlacement;
    flip?: boolean;
    gap?: number;
    boundaryRef?: React.RefObject<any> | null;
    keyboardBottomInset?: number;
    edgePadding?: number | Readonly<{ horizontal?: number; vertical?: number }>;
    backdrop?: PopoverBackdropOptions;
    consumeOutsidePointerDown?: boolean;
    containerStyle?: StyleProp<ViewStyle>;
    onRequestClose: () => void;
    preserveHostFocus?: boolean;
    /** Size to the composer (anchor) width instead of the content-capped menu width. */
    matchAnchorWidth?: boolean;
    /** Hold the full available height, so filtering never resizes the surface. */
    fillHeight?: boolean;
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
            flip={props.flip}
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
            portal={props.matchAnchorWidth ? resolveAnchorWidthPortalOptions() : MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
        >
            {({ maxHeight: resolvedMaxHeight }) => (
                <View testID={testID} collapsable={false} {...(props.preserveHostFocus !== false ? preserveHostFocusOnWebPointerDown : {})}>
                    {props.fillHeight ? (
                        // One fixed frame: header and footer keep their place, the body takes the rest.
                        <FloatingOverlay maxHeight={resolvedMaxHeight} scrollEnabled={false} surfaceChrome="theme">
                            <View style={[fillStyles.frame, { height: resolvedMaxHeight }]}>
                                {props.header}
                                <View style={fillStyles.body}>{children}</View>
                                {props.footer}
                            </View>
                        </FloatingOverlay>
                    ) : (
                        <FloatingOverlay
                            header={props.header}
                            footer={props.footer}
                            maxHeight={resolvedMaxHeight}
                            scrollEnabled={false}
                            scrollViewStyle={props.header || props.footer ? { flexShrink: 1, minHeight: 0 } : undefined}
                            edgeFades={{ top: true, bottom: true, size: 18 }}
                            edgeIndicators
                            surfaceChrome="theme"
                        >
                            {children}
                        </FloatingOverlay>
                    )}
                </View>
            )}
        </Popover>
    );
});
