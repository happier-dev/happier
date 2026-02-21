import { describe, expect, it } from 'vitest';

import { resolveCodeEditorFontMetrics } from './codeEditorFontMetrics';

describe('resolveCodeEditorFontMetrics', () => {
    it('applies uiFontScale and osFontScale', () => {
        const m = resolveCodeEditorFontMetrics({ uiFontScale: 2, osFontScale: 1.25 });
        expect(m.fontSize).toBe(33);
        expect(m.lineHeight).toBe(50);
        expect(m.scale).toBeCloseTo(2.5, 5);
    });
});

