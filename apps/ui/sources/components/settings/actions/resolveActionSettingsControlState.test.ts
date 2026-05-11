import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1, type ActionId, type ActionSurfaces, type ActionsSettingsV1 } from '@happier-dev/protocol';

import * as actionSettingsTargets from './actionSettingsTargets';

type ActionSettingsApprovalControlValue = 'off' | 'ask_first' | 'allowed';
type ActionSettingsBooleanControlValue = 'off' | 'on';
type ActionSettingsTargetControlKind = 'approval' | 'switch' | 'unavailable';
type ActionSettingsTargetControlState =
    | Readonly<{ kind: 'approval'; value: ActionSettingsApprovalControlValue; approvalSurface: keyof ActionSurfaces }>
    | Readonly<{ kind: 'switch'; value: ActionSettingsBooleanControlValue }>
    | Readonly<{ kind: 'unavailable'; value: 'off' }>;

type ResolveActionSettingsTargetControlState = (params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: actionSettingsTargets.ActionSettingsTargetId;
    available?: boolean;
}>) => ActionSettingsTargetControlState;

type ApplyActionSettingsTargetControlState = (params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: actionSettingsTargets.ActionSettingsTargetId;
    value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue;
}>) => ActionsSettingsV1;

function expectResolveControlStateExport(): ResolveActionSettingsTargetControlState {
    const candidate = (
        actionSettingsTargets as typeof actionSettingsTargets & {
            resolveActionSettingsTargetControlState?: ResolveActionSettingsTargetControlState;
        }
    ).resolveActionSettingsTargetControlState;
    expect(typeof candidate).toBe('function');
    return candidate ?? (() => ({ kind: 'unavailable', value: 'off' }));
}

function expectApplyControlStateExport(): ApplyActionSettingsTargetControlState {
    const candidate = (
        actionSettingsTargets as typeof actionSettingsTargets & {
            applyActionSettingsTargetControlState?: ApplyActionSettingsTargetControlState;
        }
    ).applyActionSettingsTargetControlState;
    expect(typeof candidate).toBe('function');
    return candidate ?? ((params) => params.settings);
}

describe('resolveActionSettingsTargetControlState', () => {
    it('resolves approval-capable targets to allowed by default', () => {
        const resolveControlState = expectResolveControlStateExport();

        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toEqual({
            kind: 'approval',
            value: 'allowed',
            approvalSurface: 'mcp',
        });
    });

    it('resolves approval-required surfaces to ask first', () => {
        const resolveControlState = expectResolveControlStateExport();
        const settings = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        expect(resolveControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toMatchObject({
            kind: 'approval',
            value: 'ask_first',
        });
    });

    it('resolves opt-in placements to simple off and on states', () => {
        const resolveControlState = expectResolveControlStateExport();
        const enabledSettings = actionSettingsTargets.setActionTargetSelected({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
            selected: true,
        });

        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
        })).toEqual({
            kind: 'switch',
            value: 'off',
        });
        expect(resolveControlState({
            settings: enabledSettings,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
        })).toEqual({
            kind: 'switch',
            value: 'on',
        });
    });

    it('does not expose approval controls for approval actions', () => {
        const resolveControlState = expectResolveControlStateExport();

        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'approval.request.create',
            targetId: 'mcp',
        })).toEqual({
            kind: 'switch',
            value: 'on',
        });
    });

    it('preserves target preferences while resolving a globally disabled action', () => {
        const resolveControlState = expectResolveControlStateExport();
        const settings = actionSettingsTargets.setActionEnabled({
            settings: actionSettingsTargets.setActionTargetApprovalRequired({
                settings: DEFAULT_ACTIONS_SETTINGS_V1,
                actionId: 'review.start',
                targetId: 'mcp',
                approvalRequired: true,
            }),
            actionId: 'review.start',
            enabled: false,
        });

        expect(resolveControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toMatchObject({
            kind: 'approval',
            value: 'ask_first',
        });
    });

    it('applies off by disabling the target and clearing matching approval state', () => {
        const applyControlState = expectApplyControlStateExport();
        const settings = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        const next = applyControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'off',
        });

        expect(next.actions['review.start']).toEqual({
            enabledPlacements: [],
            disabledSurfaces: ['mcp'],
            disabledPlacements: [],
            approvalRequiredSurfaces: [],
        });
    });

    it('applies allowed by enabling the target and clearing matching approval state', () => {
        const applyControlState = expectApplyControlStateExport();
        const settings = actionSettingsTargets.setActionTargetSelected({
            settings: actionSettingsTargets.setActionTargetApprovalRequired({
                settings: DEFAULT_ACTIONS_SETTINGS_V1,
                actionId: 'review.start',
                targetId: 'mcp',
                approvalRequired: true,
            }),
            actionId: 'review.start',
            targetId: 'mcp',
            selected: false,
        });

        const next = applyControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'allowed',
        });

        expect(next.actions['review.start']).toBeUndefined();
    });

    it('applies simple off without clearing unrelated approval surfaces', () => {
        const applyControlState = expectApplyControlStateExport();
        const settings = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        const next = applyControlState({
            settings,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
            value: 'off',
        });

        expect(next.actions['review.start']).toEqual({
            enabledPlacements: [],
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['mcp'],
        });
    });
});
