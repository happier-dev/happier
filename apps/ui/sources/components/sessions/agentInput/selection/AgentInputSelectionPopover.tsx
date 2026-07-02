import * as React from 'react';

import { Platform } from 'react-native';
import { Popover } from '@/components/ui/popover';
import { useAgentInputPopoverLayout } from './useAgentInputPopoverLayout';

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
    const popoverLayout = useAgentInputPopoverLayout({
        open: props.open,
        maxHeightCap: props.maxHeightCap,
        portalTopBottomLayout: props.portalTopBottomLayout,
    });
    // On web, agent-input popovers should be constrained to the viewport (not to an in-modal boundary
    // provider), so they can extend outside sheet-like modal cards.
    const boundaryRef =
        Platform.OS === 'web' && props.boundaryRef === undefined
            ? null
            : props.boundaryRef;
    return (
        <Popover
            open={props.open}
            anchorRef={props.anchorRef}
            // IMPORTANT:
            // Forward `undefined` so Popover can fall back to PopoverBoundaryProvider context.
            // Passing `null` explicitly disables boundary clamping/measurement, which breaks
            // new-session popover anchoring on native where we rely on a scroll boundary.
            boundaryRef={boundaryRef}
            placement={popoverLayout.placement}
            gap={popoverLayout.gap}
            maxHeightCap={popoverLayout.maxHeightCap}
            maxWidthCap={props.maxWidthCap}
            edgePadding={popoverLayout.edgePadding}
            closeOnAnchorPress={false}
            // IMPORTANT:
            // Do not force portaling to `document.body`. In Expo Router web modals, Radix focus/pointer
            // management will block interaction with inputs rendered outside the modal subtree.
            // Let Popover pick the best target (screen-local modal host from PopoverPortalTargetProvider).
            portal={popoverLayout.portal}
            onRequestClose={props.onRequestClose}
            consumeOutsidePointerDown={false}
            // On web, agent input popovers must NOT block outside pointer events: users should be
            // able to switch between chips in one click (no "click outside to close first").
            // Click-through prevention is handled at the selection layer by deferring popover
            // closure until after the click event completes.
            backdrop={{
                style: { backgroundColor: 'transparent' },
                blockOutsidePointerEvents: Platform.OS === 'web' ? false : 'above-anchor',
            }}
            containerStyle={{ paddingHorizontal: 0 }}
            keyboardBottomInset={popoverLayout.keyboardBottomInset}
        >
            {({ maxHeight }) => (
                props.children({ maxHeight })
            )}
        </Popover>
    );
}
