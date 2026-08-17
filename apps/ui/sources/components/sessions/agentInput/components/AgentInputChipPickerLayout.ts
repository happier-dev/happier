import { agentInputChipPickerHasDetailPane, type AgentInputChipPickerOption } from './AgentInputChipPickerTypes';

export const AGENT_INPUT_CHIP_PICKER_STACKED_WIDTH = 560;

export function shouldShowAgentInputChipPickerRail(
    options: ReadonlyArray<AgentInputChipPickerOption>,
    windowWidth: number,
): boolean {
    // Deliberately NOT gated on `options.length > 1`: in-session there is exactly one
    // agent option, but the detail pane is also where the model is picked, so hiding it
    // at a single option would make in-session model selection unreachable.
    return agentInputChipPickerHasDetailPane(options) && windowWidth >= AGENT_INPUT_CHIP_PICKER_STACKED_WIDTH;
}
