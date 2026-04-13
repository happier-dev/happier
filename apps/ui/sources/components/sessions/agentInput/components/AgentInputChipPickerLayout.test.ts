import { describe, expect, it } from 'vitest';

import { shouldShowAgentInputChipPickerRail } from './AgentInputChipPickerLayout';

describe('shouldShowAgentInputChipPickerRail', () => {
    it('keeps the rail visible for a single detailed option on wide layouts', () => {
        expect(shouldShowAgentInputChipPickerRail([
            {
                id: 'acpBackend:ui-acp-stub-backend',
                label: 'UI ACP Stub Backend',
                detailDescription: 'Configured ACP backend',
            } as any,
        ], 1024)).toBe(true);
    });
});
