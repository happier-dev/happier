import { describe, expect, it } from 'vitest';

import { DEFAULT_TERMINAL_INTERACTION_POLICY, resolveTerminalPasteAction } from './paste';

describe('terminal paste policy', () => {
    it('marks paste input as bracketed without pre-encoding terminal escape sequences', () => {
        const action = resolveTerminalPasteAction('hello', {
            ...DEFAULT_TERMINAL_INTERACTION_POLICY,
            bracketedPaste: 'force-wrap',
        });

        expect(action).toEqual({
            kind: 'send',
            input: 'hello',
            bracketed: true,
        });
    });

    it('requires confirmation for large paste payloads before terminal input', () => {
        const action = resolveTerminalPasteAction('abcdef', {
            ...DEFAULT_TERMINAL_INTERACTION_POLICY,
            largePasteBytes: 5,
        });

        expect(action).toEqual(expect.objectContaining({
            kind: 'confirm',
            byteLength: 6,
        }));
    });
});
