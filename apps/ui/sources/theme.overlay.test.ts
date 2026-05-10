import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';

describe('overlay theme tokens', () => {
    it('uses stronger no-blur overlay backgrounds tuned per theme', () => {
        expect(lightTheme.colors.overlay.scrimStrong).toBe('rgba(255, 255, 255, 0.68)');
        expect(darkTheme.colors.overlay.scrimStrong).toBe('rgba(0, 0, 0, 0.58)');
    });

    it('keeps the overlay text contract crisp for premium chrome surfaces', () => {
        expect(lightTheme.colors.overlay.text).toBe('#FFFFFF');
        expect(darkTheme.colors.overlay.text).toBe('#FFFFFF');
        expect(lightTheme.colors.overlay.textSecondary).toBe('rgba(255, 255, 255, 0.9)');
        expect(darkTheme.colors.overlay.textSecondary).toBe('rgba(255, 255, 255, 0.9)');
    });
});
