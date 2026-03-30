import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1 } from '@happier-dev/protocol';

import { setActionEnabled, setActionTargetApprovalRequired, setActionTargetSelected } from './actionSettingsTargets';

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
            approvalRequiredSurfaces: [],
        });
    });

    it('stores approval required surfaces through approvalRequiredSurfaces', () => {
        const next = setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        expect(next.actions['review.start']).toEqual({
            enabledPlacements: [],
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['mcp'],
        });
    });

    it('stores approval required surfaces for slash_command targets as ui_slash_command', () => {
        const next = setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'slash_command',
            approvalRequired: true,
        });

        expect(next.actions['review.start']).toEqual({
            enabledPlacements: [],
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['ui_slash_command'],
        });
    });

    it('preserves approvalRequiredSurfaces when mutating other target settings', () => {
        const seeded = setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        const next = setActionTargetSelected({
            settings: seeded,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
            selected: true,
        });

        expect(next.actions['review.start']).toEqual({
            enabledPlacements: ['agent_input_chips'],
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['mcp'],
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
            approvalRequiredSurfaces: [],
        });
    });

    it('disables the session agent surface through disabledSurfaces', () => {
        const next = setActionTargetSelected({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.message.send',
            targetId: 'session_agent',
            selected: false,
        });

        expect(next.actions['session.message.send']).toEqual({
            enabledPlacements: [],
            disabledSurfaces: ['session_agent'],
            disabledPlacements: [],
            approvalRequiredSurfaces: [],
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
            approvalRequiredSurfaces: [],
        });
    });
});
