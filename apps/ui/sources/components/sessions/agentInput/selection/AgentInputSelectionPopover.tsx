import * as React from 'react';

import { Platform, useWindowDimensions } from 'react-native';
import { Popover } from '@/components/ui/popover';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';

const MOBILE_AGENT_INPUT_POPOVER_EDGE_PADDING = 12;
const DEFAULT_AGENT_INPUT_POPOVER_EDGE_PADDING = 16;

export type AgentInputSelectionPopoverProps = Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    onRequestClose: () => void;
    maxHeightCap?: number;
    maxWidthCap?: number;
    portalTopBottomLayout?: 'anchored' | 'boundary';
    children: (args: Readonly<{ maxHeight: number }>) => React.ReactNode;
}>;

export function AgentInputSelectionPopover(props: AgentInputSelectionPopoverProps) {
    const keyboardHeight = useKeyboardHeight();
    const { width: windowWidth } = useWindowDimensions();
    // On web, agent-input popovers should be constrained to the viewport (not to an in-modal boundary
    // provider), so they can extend outside sheet-like modal cards.
    const boundaryRef =
        Platform.OS === 'web' && props.boundaryRef === undefined
            ? null
            : props.boundaryRef;
    const edgePadding = React.useMemo(() => ({
        horizontal:
            Platform.OS === 'web' && isMobileLayoutWidth(windowWidth)
                ? MOBILE_AGENT_INPUT_POPOVER_EDGE_PADDING
                : DEFAULT_AGENT_INPUT_POPOVER_EDGE_PADDING,
    }), [windowWidth]);

    // AgentInput popovers default to appearing above the chips. When the keyboard is visible on native,
    // forcing `top` can push the popover off-screen (especially in sheet/drawer presentations). Let
    // Popover resolve the best placement within the reduced keyboard-safe boundary.
    const placement =
        Platform.OS === 'web'
            ? 'top'
            : keyboardHeight > 0
                ? 'auto-vertical'
                : 'top';

    return (
        <Popover
            open={props.open}
            anchorRef={props.anchorRef}
            // IMPORTANT:
            // Forward `undefined` so Popover can fall back to PopoverBoundaryProvider context.
            // Passing `null` explicitly disables boundary clamping/measurement, which breaks
            // new-session popover anchoring on native where we rely on a scroll boundary.
            boundaryRef={boundaryRef}
            placement={placement}
            keyboardBottomInset={Platform.OS === 'web' ? 0 : keyboardHeight}
            gap={8}
            maxHeightCap={props.maxHeightCap}
            maxWidthCap={props.maxWidthCap}
            edgePadding={edgePadding}
            closeOnAnchorPress={false}
            portal={{
                // IMPORTANT:
                // Do not force portaling to `document.body`. In Expo Router web modals, Radix focus/pointer
                // management will block interaction with inputs rendered outside the modal subtree.
                // Let Popover pick the best target (screen-local modal host from PopoverPortalTargetProvider).
                web: true,
                native: true,
                matchAnchorWidth: false,
                anchorAlign: 'start',
                topBottomLayout: props.portalTopBottomLayout,
            }}
            onRequestClose={props.onRequestClose}
            consumeOutsidePointerDown={false}
            // On web, agent input popovers must NOT block outside pointer events: users should be
            // able to switch between chips in one click (no "click outside to close first").
            // Click-through prevention is handled at the selection layer by deferring popover
            // closure until after the click event completes.
            backdrop={{ style: { backgroundColor: 'transparent' }, blockOutsidePointerEvents: false }}
            containerStyle={{ paddingHorizontal: 0 }}
        >
            {({ maxHeight }) => (
                props.children({ maxHeight })
            )}
        </Popover>
    );
}
