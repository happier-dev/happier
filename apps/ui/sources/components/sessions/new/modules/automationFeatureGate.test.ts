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
            scheduleKind: 'interval' as const,
            everyMinutes: 30,
            cronExpr: '0 * * * *',
            timezone: null,
        };

        expect(resolveEffectiveAutomationDraft({ draft, automationsEnabled: false })).toEqual({
            ...draft,
            enabled: false,
        });
    });

    it('keeps automation draft unchanged when support is available', () => {
        const draft = {
            enabled: true,
            name: 'Nightly',
            description: '',
            scheduleKind: 'interval' as const,
            everyMinutes: 30,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        expect(resolveEffectiveAutomationDraft({ draft, automationsEnabled: true })).toEqual(draft);
        expect(shouldShowAutomationActionChips({ automationsEnabled: true })).toBe(true);
        expect(shouldShowAutomationActionChips({ automationsEnabled: false })).toBe(false);
    });
});
