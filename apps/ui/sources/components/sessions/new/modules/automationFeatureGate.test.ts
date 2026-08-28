import { describe, expect, it } from 'vitest';

import {
    resolveEffectiveAutomationDraft,
    shouldShowAutomationActionChips,
} from '@/components/sessions/new/modules/automationFeatureGate';

describe('automationFeatureGate', () => {
    it('disables automation draft execution when server support is unavailable', () => {
        const draft = {
            enabled: true,
            name: 'Nightly',
            description: '',
            triggers: [{
                clientId: 'schedule-half-hourly',
                definition: {
                    kind: 'schedule' as const,
                    enabled: true,
                    schedule: { kind: 'interval' as const, everyMs: 30 * 60_000 },
                },
            }],
        };

        expect(resolveEffectiveAutomationDraft({ draft, automationsEnabled: false })).toEqual({
            ...draft,
            enabled: false,
        });
        expect(resolveEffectiveAutomationDraft({ draft, automationsEnabled: false }).triggers).toEqual(draft.triggers);
    });

    it('keeps automation draft unchanged when support is available', () => {
        const draft = {
            enabled: true,
            name: 'Nightly',
            description: '',
            triggers: [{
                clientId: 'schedule-half-hourly',
                definition: {
                    kind: 'schedule' as const,
                    enabled: true,
                    schedule: { kind: 'interval' as const, everyMs: 30 * 60_000 },
                },
            }],
        };
        expect(resolveEffectiveAutomationDraft({ draft, automationsEnabled: true })).toEqual(draft);
        expect(shouldShowAutomationActionChips({ automationsEnabled: true })).toBe(true);
        expect(shouldShowAutomationActionChips({ automationsEnabled: false })).toBe(false);
    });
});
