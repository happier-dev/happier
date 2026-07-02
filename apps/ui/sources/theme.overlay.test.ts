import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';

describe('overlay theme tokens', () => {
    it('uses stronger no-blur overlay backgrounds tuned per theme', () => {
        expect(lightTheme.colors.overlay.scrimStrong).toBe('rgba(255, 255, 255, 0.68)');
        expect(darkTheme.colors.overlay.scrimStrong).toBe('rgba(19,17,17,0.86)');
    });

    it('keeps the overlay text contract crisp for premium chrome surfaces', () => {
        expect(lightTheme.colors.overlay.foreground).toBe('#FFFFFF');
        expect(darkTheme.colors.overlay.foreground).toBe('#EFEFEF');
        expect(lightTheme.colors.overlay.secondaryForeground).toBe('rgba(255, 255, 255, 0.9)');
        expect(darkTheme.colors.overlay.secondaryForeground).toBe('#8A817C');
    });
});
