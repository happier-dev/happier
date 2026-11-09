import { describe, expect, it } from 'vitest';
import { settingsParse } from './settings';
import { isActionEnabledInState, isActionApprovalRequiredByAccountSettings, isActionApprovalRequiredInState, resolveActionsSettingsV1FromState } from './actionsSettings';

describe('actionsSettings', () => {
    it('resolves admitted UI confirmation defaults against the current Account waiver and Ask-first policy', () => {
        const actionId = 'widgets.item.move';
        const context = { surface: 'ui', authority: 'present_user' } as const;
        const defaults = { defaultUiConfirmation: true };
        expect(isActionApprovalRequiredByAccountSettings(actionId, {}, context, defaults)).toBe(true);
        const waived = settingsParse({ actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } } });
        expect(isActionApprovalRequiredByAccountSettings(actionId, waived, context, defaults)).toBe(false);
        const ask = settingsParse({ actionsSettingsV1: { ...waived.actionsSettingsV1,
            actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } } });
        expect(isActionApprovalRequiredByAccountSettings(actionId, ask, context, defaults)).toBe(true);
    });

    it('reuses admitted policy across checks and immediately reads a replacement revision', () => {
        const state = {
            settings: settingsParse({
                actionsSettingsV1: {
                    v: 1,
                    actions: { 'session.stop': { enabled: false, approvalRequiredSurfaces: ['ui'] } },
                },
            }),
        };
        const initial = resolveActionsSettingsV1FromState(state);
        expect(isActionEnabledInState(state, 'session.stop', { surface: 'ui' })).toBe(false);
        expect(isActionApprovalRequiredInState(state, 'session.stop', { surface: 'ui', authority: 'present_user' })).toBe(true);
        expect(resolveActionsSettingsV1FromState({ settings: { ...state.settings } })).toBe(initial);

        const changed = {
            settings: settingsParse({
                actionsSettingsV1: {
                    v: 1,
                    actions: { 'session.stop': { enabled: true } },
                    approvalWaivedSurfaces: { 'session.stop': ['ui'] },
                },
            }),
        };
        expect(isActionEnabledInState(changed, 'session.stop', { surface: 'ui' })).toBe(true);
        expect(isActionApprovalRequiredInState(changed, 'session.stop', { surface: 'ui', authority: 'present_user' })).toBe(false);
        expect(resolveActionsSettingsV1FromState(changed)).not.toBe(initial);
        expect(resolveActionsSettingsV1FromState(state)).toBe(initial);
    });

    it('treats per-action overrides as disabled and supports per-surface gating', () => {
        const state: any = {
            settings: settingsParse({
                experiments: true,
                featureToggles: { 'execution.runs': true },
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'review.start': { enabled: false },
                        'subagents.plan.start': { disabledSurfaces: ['mcp'] },
                    },
                },
            }),
        };

        expect(isActionEnabledInState(state, 'review.start' as any, { surface: 'ui', placement: 'command_palette' } as any)).toBe(false);
        expect(isActionEnabledInState(state, 'subagents.plan.start' as any, { surface: 'ui', placement: 'command_palette' } as any)).toBe(true);
        expect(isActionEnabledInState(state, 'subagents.plan.start' as any, { surface: 'mcp' } as any)).toBe(false);
    });

    it('preserves valid sibling policy when one Action row is malformed', () => {
        const state: any = {
            settings: settingsParse({
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'session.message.send': { enabled: false },
                        'session.stop': { disabledSurfaces: 'api' },
                    },
                },
            }),
        };

        expect(isActionEnabledInState(state, 'session.message.send', { surface: 'ui' } as any)).toBe(false);
        expect(isActionEnabledInState(state, 'session.stop', { surface: 'cli' } as any)).toBe(false);
    });

    it('treats review.start as an execution-runs-gated action', () => {
        const disabledState: any = {
            settings: settingsParse({
                experiments: false,
                featureToggles: {},
                actionsSettingsV1: { v: 1, actions: {} },
            }),
        };
        const enabledState: any = {
            settings: settingsParse({
                experiments: true,
                featureToggles: { 'execution.runs': true },
                actionsSettingsV1: { v: 1, actions: {} },
            }),
        };

        expect(isActionEnabledInState(disabledState, 'review.start' as any, { surface: 'ui', placement: 'command_palette' } as any)).toBe(false);
        expect(isActionEnabledInState(enabledState, 'review.start' as any, { surface: 'ui', placement: 'command_palette' } as any)).toBe(true);
    });
});
