/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createBackdropWebStyle } from './createBackdropLayerStyle';

describe('createBackdropWebStyle', () => {
    afterEach(() => {
        delete document.documentElement.dataset.happyBackdropBlur;
    });

    it('returns blur filters by default', () => {
        const style = createBackdropWebStyle({
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            blurPx: 4,
        });

        expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0.45)');
        expect(style.WebkitBackdropFilter).toBe('blur(var(--happier-glass-floating-blur, 4px))');
        expect(style.backdropFilter).toBe('blur(var(--happier-glass-floating-blur, 4px))');
    });

    it('uses explicit fallback color when blur is disabled', () => {
        const style = createBackdropWebStyle({
            backgroundColor: 'rgba(255, 255, 255, 0.52)',
            fallbackBackgroundColorWhenBlurDisabled: 'rgba(255, 255, 255, 0.68)',
            enableBlur: false,
        });

        expect(style.backgroundColor).toBe('rgba(255, 255, 255, 0.68)');
        expect(style.WebkitBackdropFilter).toBeUndefined();
        expect(style.backdropFilter).toBeUndefined();
    });

    it('uses the requested group blur instead of floating strength for working content', () => {
        const style = createBackdropWebStyle({ backgroundColor: '#fff', blurPx: 0, surfaceGroup: 'content' });
        expect(style.backdropFilter).toBe('blur(var(--happier-glass-content-blur, 0px))');
    });

    it('follows the live material variable rather than capturing the retired device preference', () => {
        document.documentElement.dataset.happyBackdropBlur = 'off';

        const style = createBackdropWebStyle({
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            fallbackBackgroundColorWhenBlurDisabled: 'rgba(0, 0, 0, 0.58)',
        });

        expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0.45)');
        expect(style.WebkitBackdropFilter).toBe('blur(var(--happier-glass-floating-blur, 12px))');
        expect(style.backdropFilter).toBe('blur(var(--happier-glass-floating-blur, 12px))');
    });
});
