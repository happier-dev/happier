import { describe, expect, it } from 'vitest';

import {
    applyEmbeddedTerminalBellPolicy,
    applyEmbeddedTerminalTitlePolicy,
    sanitizeTerminalBell,
    sanitizeTerminalTitle,
} from './title';

describe('terminal title and bell policy', () => {
    it('strips control characters and bounds terminal-controlled titles', () => {
        const title = sanitizeTerminalTitle(`hello\u001b]0;${'x'.repeat(400)}`, 20);

        expect(title).toBe(`hello]0;${'x'.repeat(12)}`);
        expect(title.length).toBe(20);
    });

    it('sanitizes bell labels without preserving control payloads', () => {
        expect(sanitizeTerminalBell('ding\u0007\u001b[31m')).toBe('ding[31m');
    });

    it('bounds terminal-controlled title and bell events at the embedded-terminal host policy', () => {
        expect(applyEmbeddedTerminalTitlePolicy('build title')).toBe('ignored');
        expect(applyEmbeddedTerminalBellPolicy('ding')).toBe('ignored');
    });
});
