import * as React from 'react';

import { Popover } from '@/components/ui/popover';

export type AgentInputSelectionPopoverProps = Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    onRequestClose: () => void;
    maxHeightCap?: number;
    maxWidthCap?: number;
    children: (args: Readonly<{ maxHeight: number }>) => React.ReactNode;
}>;

export function AgentInputSelectionPopover(props: AgentInputSelectionPopoverProps) {
    return (
        <Popover
            open={props.open}
            anchorRef={props.anchorRef}
            boundaryRef={props.boundaryRef ?? null}
            placement="top"
            gap={8}
            maxHeightCap={props.maxHeightCap}
            maxWidthCap={props.maxWidthCap}
            edgePadding={{ horizontal: 16 }}
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
            }}
            onRequestClose={props.onRequestClose}
            backdrop={{ style: { backgroundColor: 'transparent' }, blockOutsidePointerEvents: true }}
            containerStyle={{ paddingHorizontal: 0 }}
        >
            {props.children}
        </Popover>
    );
}
