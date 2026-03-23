import React from 'react';

import { AgentInputPopoverSurface } from '@/components/sessions/agentInput/components/AgentInputPopoverSurface';

import {
    AgentInputChipPickerPanel,
    type AgentInputChipPickerOption,
} from './AgentInputChipPickerPanel';
import { agentInputChipPickerHasDetailPane } from './AgentInputChipPickerTypes';

export type AgentInputChipPickerSurfaceProps = Readonly<{
    title: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
    onRequestClose: () => void;
    applyLabel?: string;
    maxHeight?: number | null;
    testID?: string;
}>;

export function AgentInputChipPickerSurface(props: AgentInputChipPickerSurfaceProps) {
    const hasDetailPane = React.useMemo(
        () => agentInputChipPickerHasDetailPane(props.options),
        [props.options],
    );

    const panel = (
        <AgentInputChipPickerPanel
            title={props.title}
            options={props.options}
            selectedOptionId={props.selectedOptionId}
            onSelect={props.onSelect}
            onRequestClose={props.onRequestClose}
            applyLabel={props.applyLabel}
        />
    );

    if (typeof props.maxHeight !== 'number') {
        return panel;
    }

    return (
        <AgentInputPopoverSurface
            testID={props.testID}
            maxHeight={props.maxHeight}
            scrollEnabled={hasDetailPane}
            keyboardShouldPersistTaps="handled"
        >
            {panel}
        </AgentInputPopoverSurface>
    );
}
