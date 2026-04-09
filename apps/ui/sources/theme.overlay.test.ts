import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';

describe('overlay theme tokens', () => {
    it('keeps the strong overlay surface near-black in both themes', () => {
        expect(lightTheme.colors.overlay.scrimStrong).toBe('#050505');
        expect(darkTheme.colors.overlay.scrimStrong).toBe('#050505');
    });

    it('keeps the overlay text contract crisp for premium chrome surfaces', () => {
        expect(lightTheme.colors.overlay.text).toBe('#FFFFFF');
        expect(darkTheme.colors.overlay.text).toBe('#FFFFFF');
        expect(lightTheme.colors.overlay.textSecondary).toBe('rgba(255, 255, 255, 0.9)');
        expect(darkTheme.colors.overlay.textSecondary).toBe('rgba(255, 255, 255, 0.9)');
    });
});
