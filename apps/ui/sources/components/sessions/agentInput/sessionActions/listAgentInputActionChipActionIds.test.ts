import { describe, expect, it } from 'vitest';

import { listAgentInputActionChipActionIds } from '@/components/sessions/agentInput/sessionActions/listAgentInputActionChipActionIds';

describe('listAgentInputActionChipActionIds', () => {
    it('returns no action chips by default (opt-in placement)', () => {
        const state: any = { settings: { actionsSettingsV1: { v: 1, actions: {} } } };
        expect(listAgentInputActionChipActionIds(state)).toEqual([]);
    });

    it('includes action ids explicitly enabled for agent_input_chips placement', () => {
        const state: any = {
            settings: {
                experiments: true,
                featureToggles: { 'execution.runs': true },
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

    it('omits execution-run chips when the feature is disabled', () => {
        const state: any = {
            settings: {
                experiments: false,
                featureToggles: {},
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'review.start': { enabledPlacements: ['agent_input_chips'] },
                    },
                },
            },
        };
        expect(listAgentInputActionChipActionIds(state)).not.toContain('review.start');
    });
});
