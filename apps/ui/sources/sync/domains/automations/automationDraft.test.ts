import { describe, expect, it } from 'vitest';

import { DEFAULT_NEW_SESSION_AUTOMATION_DRAFT, sanitizeNewSessionAutomationDraft } from './automationDraft';

describe('automationDraft', () => {
    it('defaults new-session automation names to an empty value so the placeholder can render', () => {
        expect(DEFAULT_NEW_SESSION_AUTOMATION_DRAFT.name).toBe('');
        expect(sanitizeNewSessionAutomationDraft(null).name).toBe('');
    });
});
