import { describe, expect, it } from 'vitest';

import { resolveQuotaToneColor, type QuotaToneColorTheme } from './resolveQuotaToneColor';

const theme: QuotaToneColorTheme = {
    colors: {
        state: {
            success: { foreground: '#success' },
            warning: { foreground: '#warning' },
            danger: { foreground: '#danger' },
            neutral: { foreground: '#neutral' },
        },
    },
};

describe('resolveQuotaToneColor', () => {
    it('maps each tone to its state foreground token', () => {
        expect(resolveQuotaToneColor(theme, 'success')).toBe('#success');
        expect(resolveQuotaToneColor(theme, 'warning')).toBe('#warning');
        expect(resolveQuotaToneColor(theme, 'danger')).toBe('#danger');
        expect(resolveQuotaToneColor(theme, 'neutral')).toBe('#neutral');
    });
});
