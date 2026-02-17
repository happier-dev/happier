import { describe, expect, it } from 'vitest';

import { listAgentInputActionChipActionIds } from '@/components/sessions/agentInput/actionChips/listAgentInputActionChipActionIds';

describe('listAgentInputActionChipActionIds', () => {
    it('returns no action chips by default (opt-in placement)', () => {
        const state: any = { settings: { actionsSettingsV1: { v: 1, actions: {} } } };
        expect(listAgentInputActionChipActionIds(state)).toEqual([]);
    });

    it('includes action ids explicitly enabled for agent_input_chips placement', () => {
        const state: any = {
            settings: {
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'review.start': { enabledPlacements: ['agent_input_chips'] },
                    },
                },
            },
        };
        expect(listAgentInputActionChipActionIds(state)).toContain('review.start');
    });
});

