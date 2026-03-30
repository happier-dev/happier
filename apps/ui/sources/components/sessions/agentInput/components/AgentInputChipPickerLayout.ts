import { agentInputChipPickerHasDetailPane, type AgentInputChipPickerOption } from './AgentInputChipPickerTypes';

export const AGENT_INPUT_CHIP_PICKER_STACKED_WIDTH = 560;

export function shouldShowAgentInputChipPickerRail(
    options: ReadonlyArray<AgentInputChipPickerOption>,
    windowWidth: number,
): boolean {
    return agentInputChipPickerHasDetailPane(options) && options.length > 1 && windowWidth >= AGENT_INPUT_CHIP_PICKER_STACKED_WIDTH;
}
