import React from 'react';

import { AgentInputSelectionPopover } from '@/components/sessions/agentInput/selection/AgentInputSelectionPopover';

import { AgentInputChipPickerSurface } from './AgentInputChipPickerSurface';
import type { AgentInputChipPickerOption } from './AgentInputChipPickerPanel';

export type AgentInputChipPickerPopoverProps = Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
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
    maxHeightCap?: number;
    maxWidthCap?: number;
}>;

export function AgentInputChipPickerPopover(props: AgentInputChipPickerPopoverProps) {
    return (
        <AgentInputSelectionPopover
            open={props.open}
            anchorRef={props.anchorRef}
            maxHeightCap={props.maxHeightCap ?? 420}
            maxWidthCap={props.maxWidthCap ?? 720}
            onRequestClose={props.onRequestClose}
        >
            {({ maxHeight }) => (
                <AgentInputChipPickerSurface
                    testID="agent-input-chip-picker-popover"
                    // Agent-input popovers shouldn't render their own header chrome; the model section
                    // already provides the relevant header (e.g. MODEL) and refresh affordance.
                    title=""
                    // Align with other AgentInput popovers (close by outside press / selecting options).
                    showCloseButton={props.showCloseButton ?? false}
                    options={props.options}
                    selectedOptionId={props.selectedOptionId}
                    onSelect={props.onSelect}
                    onRequestClose={props.onRequestClose}
                    applyLabel={props.applyLabel}
                    railWidth={props.railWidth}
                    railMaxWidth={props.railMaxWidth}
                    detailPaneHeaderAccessory={props.detailPaneHeaderAccessory}
                    maxHeight={maxHeight}
                />
            )}
        </AgentInputSelectionPopover>
    );
}
