import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1 } from '@happier-dev/protocol';

import {
    applyActionSettingsTargetControlState,
    resolveActionSettingsTargetControlState,
    setActionEnabled,
    setActionTargetApprovalRequired,
    setActionTargetSelected,
} from './actionSettingsTargets';

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

    it('stores approval required surfaces for slash_command targets as ui', () => {
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
            approvalRequiredSurfaces: ['ui'],
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
            targetId: 'agent',
            selected: false,
        });

        expect(next.actions['session.message.send']).toEqual({
            enabledPlacements: [],
            disabledSurfaces: ['agent'],
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

    it('retains API and trusted-plugin overrides for a qualified contributed Action id', () => {
        const actionId = 'com.acme.review/actions/review/start';
        const apiDisabled = setActionTargetSelected({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId,
            targetId: 'api',
            selected: false,
        });
        const pluginApprovalRequired = setActionTargetApprovalRequired({
            settings: apiDisabled,
            actionId,
            targetId: 'plugin',
            approvalRequired: true,
        });

        expect(pluginApprovalRequired.actions[actionId]).toEqual({
            enabledPlacements: [],
            disabledSurfaces: ['api'],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['plugin'],
        });
    });

    it.each(['api', 'plugin'] as const)('offers off, ask-first, and allowed states for contributed %s', (targetId) => {
        const actionId = 'com.acme.review/actions/review/start';
        const initial = resolveActionSettingsTargetControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId,
            targetId,
        });
        expect(initial).toMatchObject({ kind: 'approval', value: 'allowed' });

        const off = applyActionSettingsTargetControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId,
            targetId,
            value: 'off',
        });
        expect(resolveActionSettingsTargetControlState({ settings: off, actionId, targetId }))
            .toMatchObject({ kind: 'approval', value: 'off' });

        const askFirst = applyActionSettingsTargetControlState({
            settings: off,
            actionId,
            targetId,
            value: 'ask_first',
        });
        expect(resolveActionSettingsTargetControlState({ settings: askFirst, actionId, targetId }))
            .toMatchObject({ kind: 'approval', value: 'ask_first' });

        const allowed = applyActionSettingsTargetControlState({
            settings: askFirst,
            actionId,
            targetId,
            value: 'allowed',
        });
        expect(resolveActionSettingsTargetControlState({ settings: allowed, actionId, targetId }))
            .toMatchObject({ kind: 'approval', value: 'allowed' });
    });
});
