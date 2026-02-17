import { describe, expect, it } from 'vitest';

describe('actionsSettings', () => {
    it('treats per-action overrides as disabled and supports per-surface gating', async () => {
        const { isActionEnabledInState } = await import('./actionsSettings');

        const state: any = {
            settings: {
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'review.start': { enabled: false },
                        'plan.start': { disabledSurfaces: ['mcp'] },
                    },
                },
            },
        };

        expect(isActionEnabledInState(state, 'review.start' as any, { surface: 'ui_button', placement: 'command_palette' } as any)).toBe(false);
        expect(isActionEnabledInState(state, 'plan.start' as any, { surface: 'ui_button', placement: 'command_palette' } as any)).toBe(true);
        expect(isActionEnabledInState(state, 'plan.start' as any, { surface: 'mcp' } as any)).toBe(false);
    });
});
