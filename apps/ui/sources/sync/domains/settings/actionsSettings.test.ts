import { describe, expect, it } from 'vitest';

describe('actionsSettings', () => {
    it('treats per-action overrides as disabled and supports per-surface gating', async () => {
        const { isActionEnabledInState } = await import('./actionsSettings');

        const state: any = {
            settings: {
                experiments: true,
                featureToggles: { 'execution.runs': true },
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'review.start': { enabled: false },
                        'subagents.plan.start': { disabledSurfaces: ['mcp'] },
                    },
                },
            },
        };

        expect(isActionEnabledInState(state, 'review.start' as any, { surface: 'ui', placement: 'command_palette' } as any)).toBe(false);
        expect(isActionEnabledInState(state, 'subagents.plan.start' as any, { surface: 'ui', placement: 'command_palette' } as any)).toBe(true);
        expect(isActionEnabledInState(state, 'subagents.plan.start' as any, { surface: 'mcp' } as any)).toBe(false);
    });

    it('preserves valid sibling policy when one Action row is malformed', async () => {
        const { isActionEnabledInState } = await import('./actionsSettings');
        const state: any = {
            settings: {
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'session.message.send': { enabled: false },
                        'session.stop': { disabledSurfaces: 'api' },
                    },
                },
            },
        };

        expect(isActionEnabledInState(state, 'session.message.send', { surface: 'ui' } as any)).toBe(false);
        expect(isActionEnabledInState(state, 'session.stop', { surface: 'cli' } as any)).toBe(false);
    });

    it('treats review.start as an execution-runs-gated action', async () => {
        const { isActionEnabledInState } = await import('./actionsSettings');

        const disabledState: any = {
            settings: {
                experiments: false,
                featureToggles: {},
                actionsSettingsV1: { v: 1, actions: {} },
            },
        };
        const enabledState: any = {
            settings: {
                experiments: true,
                featureToggles: { 'execution.runs': true },
                actionsSettingsV1: { v: 1, actions: {} },
            },
        };

        expect(isActionEnabledInState(disabledState, 'review.start' as any, { surface: 'ui', placement: 'command_palette' } as any)).toBe(false);
        expect(isActionEnabledInState(enabledState, 'review.start' as any, { surface: 'ui', placement: 'command_palette' } as any)).toBe(true);
    });
});
