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
        />
    );

    if (typeof props.maxHeight !== 'number') {
        return panel;
    }

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
