import { describe, expect, it } from 'vitest';

describe('actionsSettings', () => {
    it('treats listed actions as disabled', async () => {
        const { isActionEnabledInState } = await import('./actionsSettings');

        const state: any = {
            settings: {
                actionsSettingsV1: { v: 1, disabledActionIds: ['review.start'] },
            },
        };

        expect(isActionEnabledInState(state, 'review.start' as any)).toBe(false);
        expect(isActionEnabledInState(state, 'plan.start' as any)).toBe(true);
    });
});

