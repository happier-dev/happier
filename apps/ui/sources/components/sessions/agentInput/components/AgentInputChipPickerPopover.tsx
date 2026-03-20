import React from 'react';

import { Popover } from '@/components/ui/popover';

import { AgentInputChipPickerSurface } from './AgentInputChipPickerSurface';
import type { AgentInputChipPickerOption } from './AgentInputChipPickerPanel';

export type AgentInputChipPickerPopoverProps = Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    title: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
    onRequestClose: () => void;
    applyLabel?: string;
    maxHeightCap?: number;
    maxWidthCap?: number;
}>;

export function AgentInputChipPickerPopover(props: AgentInputChipPickerPopoverProps) {
    return (
        <Popover
            open={props.open}
            anchorRef={props.anchorRef}
            boundaryRef={null}
            placement="top"
            gap={8}
            maxHeightCap={props.maxHeightCap ?? 420}
            maxWidthCap={props.maxWidthCap ?? 720}
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
            {({ maxHeight }) => (
                <AgentInputChipPickerSurface
                    testID="agent-input-chip-picker-popover"
                    title={props.title}
                    options={props.options}
                    selectedOptionId={props.selectedOptionId}
                    onSelect={props.onSelect}
                    onRequestClose={props.onRequestClose}
                    applyLabel={props.applyLabel}
                    maxHeight={maxHeight}
                />
            )}
        </Popover>
    );
}
