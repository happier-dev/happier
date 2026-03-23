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
            closeOnAnchorPress={false}
            portal={{
                web: { target: 'body' },
                native: true,
                matchAnchorWidth: false,
                anchorAlign: 'start',
            }}
            onRequestClose={props.onRequestClose}
            backdrop={{ style: { backgroundColor: 'transparent' } }}
            containerStyle={{ paddingHorizontal: 0 }}
        >
            {props.children}
        </Popover>
    );
}
