import React from 'react';

import type { CustomModalInjectedProps } from '@/modal';

import {
    AgentInputChipPickerPanel,
    type AgentInputChipPickerOption,
} from './AgentInputChipPickerPanel';

export type AgentInputChipPickerModalOption = AgentInputChipPickerOption;

export type AgentInputChipPickerModalProps = Readonly<CustomModalInjectedProps & {
    title: string;
    options: ReadonlyArray<AgentInputChipPickerModalOption>;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
    applyLabel?: string;
}>;

export function AgentInputChipPickerModal(props: AgentInputChipPickerModalProps) {
    return (
        <AgentInputChipPickerPanel
            title={props.title}
            options={props.options}
            selectedOptionId={props.selectedOptionId}
            onSelect={props.onSelect}
            onRequestClose={props.onClose}
            applyLabel={props.applyLabel}
        />
    );
}
