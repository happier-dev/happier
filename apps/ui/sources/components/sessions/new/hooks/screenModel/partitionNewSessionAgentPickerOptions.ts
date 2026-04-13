import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';

export type NewSessionAgentPickerOptionPartitions = Readonly<{
    available: ReadonlyArray<AgentInputChipPickerOption>;
    muted: ReadonlyArray<AgentInputChipPickerOption>;
    disabled: ReadonlyArray<AgentInputChipPickerOption>;
}>;

export function partitionNewSessionAgentPickerOptions(
    options: ReadonlyArray<AgentInputChipPickerOption>,
): NewSessionAgentPickerOptionPartitions {
    const available: AgentInputChipPickerOption[] = [];
    const muted: AgentInputChipPickerOption[] = [];
    const disabled: AgentInputChipPickerOption[] = [];

    for (const option of options) {
        if (option.disabled) {
            disabled.push(option);
            continue;
        }

        if (option.muted) {
            muted.push(option);
            continue;
        }

        available.push(option);
    }

    return {
        available,
        muted,
        disabled,
    };
}
