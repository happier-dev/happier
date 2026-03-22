import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1 } from '@happier-dev/protocol';

import { setActionEnabled, setActionTargetSelected } from './actionSettingsTargets';

describe('actionSettingsTargets', () => {
    it('enables opt-in placements through enabledPlacements', () => {
        const next = setActionTargetSelected({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
            selected: true,
        });

        expect(next.actions['review.start']).toEqual({
            enabledPlacements: ['agent_input_chips'],
            disabledSurfaces: [],
            disabledPlacements: [],
        });
    });

    it('disables integration surfaces through disabledSurfaces', () => {
        const next = setActionTargetSelected({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            selected: false,
        });

        expect(next.actions['review.start']).toEqual({
            enabledPlacements: [],
            disabledSurfaces: ['mcp'],
            disabledPlacements: [],
        });
    });

    it('stores global action disablement separately from target overrides', () => {
        const next = setActionEnabled({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            enabled: false,
        });

        expect(next.actions['review.start']).toEqual({
            enabled: false,
            enabledPlacements: [],
            disabledSurfaces: [],
            disabledPlacements: [],
        });
    });
});
