import { describe, expect, it } from 'vitest';

import { isEscapeEventHandled, markEscapeEventHandled, registerEscapeKeyBlocker } from './escapeKeyHandling';

describe('panel escape key handling', () => {
    it('shares handled-event state with the canonical escape module', async () => {
        const canonical = await import('@/keyboard/escape');
        const event = {};

        markEscapeEventHandled(event);

        expect(canonical.isEscapeEventHandled(event)).toBe(true);
        expect(isEscapeEventHandled(event)).toBe(true);
    });

    it('shares blocker priority state with the canonical escape module', async () => {
        const canonical = await import('@/keyboard/escape');
        const unregister = registerEscapeKeyBlocker(123);

        try {
            expect(canonical.getMaxEscapeKeyBlockerPriority()).toBeGreaterThanOrEqual(123);
        } finally {
            unregister();
        }
    });
});
