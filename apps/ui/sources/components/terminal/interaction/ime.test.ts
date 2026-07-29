import { describe, expect, it } from 'vitest';

import { resolveTerminalImeInput } from './ime';

describe('resolveTerminalImeInput', () => {
    it('emits committed IME text only', () => {
        expect(resolveTerminalImeInput({ phase: 'start', text: 'a' })).toBe('');
        expect(resolveTerminalImeInput({ phase: 'update', text: 'ab' })).toBe('');
        expect(resolveTerminalImeInput({ phase: 'cancel', text: 'ab' })).toBe('');
        expect(resolveTerminalImeInput({ phase: 'commit', text: '文' })).toBe('文');
    });

    it('treats empty commit text as no input', () => {
        expect(resolveTerminalImeInput({ phase: 'commit' })).toBe('');
    });
});
