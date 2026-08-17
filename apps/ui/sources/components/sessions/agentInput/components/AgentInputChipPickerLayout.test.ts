import { describe, expect, it } from 'vitest';

import {
    AGENT_INPUT_CHIP_PICKER_STACKED_WIDTH,
    shouldShowAgentInputChipPickerRail,
} from './AgentInputChipPickerLayout';

function detailedOption(id: string) {
    return {
        id,
        label: id,
        detailDescription: 'Configured ACP backend',
    } as any;
}

describe('shouldShowAgentInputChipPickerRail', () => {
    it('keeps the rail visible for a single detailed option on wide layouts', () => {
        // The detail pane also hosts model selection, so a single agent option must
        // still open the two-pane layout.
        expect(shouldShowAgentInputChipPickerRail(
            [detailedOption('acpBackend:ui-acp-stub-backend')],
            1024,
        )).toBe(true);
    });

    it('keeps the rail visible for several detailed options on wide layouts', () => {
        expect(shouldShowAgentInputChipPickerRail(
            [detailedOption('one'), detailedOption('two')],
            1024,
        )).toBe(true);
    });

    it('stacks detailed options below the stacked width', () => {
        expect(shouldShowAgentInputChipPickerRail(
            [detailedOption('one'), detailedOption('two')],
            AGENT_INPUT_CHIP_PICKER_STACKED_WIDTH - 1,
        )).toBe(false);
    });
});
