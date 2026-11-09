import { describe, expect, it } from 'vitest';

import { resolveNewSessionAfterSend } from './newSessionAfterSend';

describe('resolveNewSessionAfterSend', () => {
    it('stays in a Docked composer and opens everywhere else until the person chooses', () => {
        expect(resolveNewSessionAfterSend({ configured: null, backgroundable: true, docked: true })).toBe('startAnother');
        expect(resolveNewSessionAfterSend({ configured: null, backgroundable: true })).toBe('open');
    });

    it('lets the setting, then this Send, override that default', () => {
        expect(resolveNewSessionAfterSend({ configured: 'open', backgroundable: true, docked: true })).toBe('open');
        expect(resolveNewSessionAfterSend({ configured: 'open', requested: 'startAnother', backgroundable: true })).toBe('startAnother');
    });

    it('keeps a launch that cannot outlive its surface on its own flow', () => {
        expect(resolveNewSessionAfterSend({ configured: 'startAnother', requested: 'startAnother', backgroundable: false })).toBe('open');
    });
});
