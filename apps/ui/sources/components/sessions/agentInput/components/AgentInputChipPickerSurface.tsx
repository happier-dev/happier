import React from 'react';

import { AgentInputPopoverSurface } from '@/components/sessions/agentInput/components/AgentInputPopoverSurface';

import {
    AgentInputChipPickerPanel,
    type AgentInputChipPickerOption,
} from './AgentInputChipPickerPanel';

export type AgentInputChipPickerSurfaceProps = Readonly<{
    title: string;
    showCloseButton?: boolean;
    options: ReadonlyArray<AgentInputChipPickerOption>;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
    onRequestClose: () => void;
    applyLabel?: string;
    railWidth?: number;
    railMaxWidth?: number | `${number}%`;
    detailPaneHeaderAccessory?: React.ReactNode;
    maxHeight?: number | null;
    testID?: string;
}>;

export function AgentInputChipPickerSurface(props: AgentInputChipPickerSurfaceProps) {
    const panel = (
        <AgentInputChipPickerPanel
            title={props.title}
            showCloseButton={props.showCloseButton}
            options={props.options}
            selectedOptionId={props.selectedOptionId}
            onSelect={props.onSelect}
            onRequestClose={props.onRequestClose}
            applyLabel={props.applyLabel}
            railWidth={props.railWidth}
            railMaxWidth={props.railMaxWidth}
            detailPaneHeaderAccessory={props.detailPaneHeaderAccessory}
            maxHeight={props.maxHeight}
        />
    );

    if (typeof props.maxHeight !== 'number') {
        return panel;
    }

    // `scrollEnabled` is unconditional ON PURPOSE. The successor tree passes a
    // `detailContentOwnsScroll` flag here to hand scrolling to a bounded detail
    // pane, but that only works because its panel chain has a
    // `fillAvailableSpace` host that gives the detail content a bounded box to
    // scroll inside. This tree has no such host anywhere in `apps/ui`, so the
    // surface is the ONLY scroll owner: porting the flag turns scrolling off
    // and leaves the Agent picker and the New Session popover with content
    // taller than the box and no way to reach it. That port was made here once
    // and reverted. Add the layout host first, or leave this alone.
    return (
        <AgentInputPopoverSurface
            testID={props.testID}
            maxHeight={props.maxHeight}
            scrollEnabled
            keyboardShouldPersistTaps="handled"
        >
            {panel}
        </AgentInputPopoverSurface>
    );
}
