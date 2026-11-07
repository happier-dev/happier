import { describe, expect, it } from 'vitest';

import { resolveNewSessionAfterSend } from './newSessionAfterSend';

describe('resolveNewSessionAfterSend', () => {
    it('uses the configured default until the Send names one', () => {
        expect(resolveNewSessionAfterSend({ configured: 'open' })).toBe('open');
        expect(resolveNewSessionAfterSend({ configured: 'startAnother' })).toBe('startAnother');
        expect(resolveNewSessionAfterSend({ configured: 'open', requested: 'startAnother' })).toBe('startAnother');
        expect(resolveNewSessionAfterSend({ configured: 'startAnother', requested: 'open' })).toBe('open');
    });

    it('keeps an automation draft on its own flow, since its Send creates no Session to leave running', () => {
        expect(resolveNewSessionAfterSend({ configured: 'startAnother', requested: 'startAnother', automationEnabled: true })).toBe('open');
    });
});
