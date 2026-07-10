import { describe, expect, it } from 'vitest';

import { prepareTerminalPromptTextForInjection } from './promptTextSafety.js';

describe('prepareTerminalPromptTextForInjection', () => {
    it('normalizes CR and CRLF line endings to LF', () => {
        expect(prepareTerminalPromptTextForInjection('alpha\r\nbeta\rgamma')).toEqual({
            ok: true,
            text: 'alpha\nbeta\ngamma',
            multiline: true,
        });
    });

    it('allows printable text with tab and LF whitespace', () => {
        expect(prepareTerminalPromptTextForInjection('alpha\tbeta\ngamma')).toEqual({
            ok: true,
            text: 'alpha\tbeta\ngamma',
            multiline: true,
        });
    });

    it('rejects terminal control bytes', () => {
        for (const text of [
            'alpha\x00beta',
            'alpha\x03beta',
            'alpha\x04beta',
            'alpha\x1bbeta',
            'alpha\x1b[31mbeta',
            'alpha\x1b]0;title\x07beta',
            'alpha\x1b[200~beta',
            'alpha\x1b[201~beta',
            'alpha\x7fbeta',
            'alpha\u009bbeta',
        ]) {
            expect(prepareTerminalPromptTextForInjection(text)).toEqual({
                ok: false,
                reason: 'terminal_control_byte',
            });
        }
    });
});
