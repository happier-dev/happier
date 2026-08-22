import { describe, expect, it } from 'vitest';

import {
    DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
    MAX_AUTOMATION_INTERVAL_MINUTES,
    sanitizeNewSessionAutomationDraft,
} from './automationDraft';

describe('automationDraft', () => {
    it('defaults new-session automation names to an empty value so the placeholder can render', () => {
        expect(DEFAULT_NEW_SESSION_AUTOMATION_DRAFT.name).toBe('');
        expect(sanitizeNewSessionAutomationDraft(null).name).toBe('');
    });

    it('preserves a multi-day cadence so reopening an automation cannot narrow it', () => {
        // The sanitizer sits on both sides of the editor round trip: the edit
        // screen seeds through it (buildAutomationEditTemplateSeed) and the new
        // session screen re-runs it on every interval-picker change
        // (useNewSessionAgentInputPresentation.handleAutomationSettingsChange).
        // A ceiling here narrower than the picker's silently rewrites a stored
        // weekly cadence to a daily one on open.
        expect(sanitizeNewSessionAutomationDraft({
            scheduleKind: 'interval',
            everyMinutes: 7 * 24 * 60,
        }).everyMinutes).toBe(7 * 24 * 60);

        expect(sanitizeNewSessionAutomationDraft({
            scheduleKind: 'interval',
            everyMinutes: MAX_AUTOMATION_INTERVAL_MINUTES + 1,
        }).everyMinutes).toBe(MAX_AUTOMATION_INTERVAL_MINUTES);
    });
});
