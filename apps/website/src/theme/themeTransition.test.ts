import { describe, expect, it, vi } from 'vitest';

import { applyThemeWithTransition, shouldAnimateThemeTransition } from './themeTransition';

describe('website theme transitions', () => {
    it('does not animate when the visual theme is unchanged', () => {
        expect(
            shouldAnimateThemeTransition({
                currentTheme: 'dark',
                nextTheme: 'dark',
                reduceMotion: false,
                supportsViewTransition: true,
            }),
        ).toBe(false);
    });

    it('uses a view transition clip-path reveal for theme changes', async () => {
        const animate = vi.fn();
        const startViewTransition = vi.fn((update: () => void) => {
            update();
            return { ready: Promise.resolve() };
        });
        const documentLike = {
            documentElement: {
                animate,
                setAttribute: vi.fn(),
            },
            startViewTransition,
        } as unknown as Document;

        await applyThemeWithTransition({
            currentTheme: 'dark',
            document: documentLike,
            nextTheme: 'light',
            reduceMotion: false,
        });

        expect(startViewTransition).toHaveBeenCalledOnce();
        expect(animate).toHaveBeenCalledWith(
            { clipPath: ['inset(0 0 100% 0)', 'inset(0)'] },
            expect.objectContaining({
                duration: 600,
                easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
                fill: 'both',
                pseudoElement: '::view-transition-new(root)',
            }),
        );
    });

    it('applies immediately when reduced motion is preferred', async () => {
        const animate = vi.fn();
        const startViewTransition = vi.fn();
        const documentLike = {
            documentElement: {
                animate,
                setAttribute: vi.fn(),
            },
            startViewTransition,
        } as unknown as Document;

        await applyThemeWithTransition({
            currentTheme: 'dark',
            document: documentLike,
            nextTheme: 'light',
            reduceMotion: true,
        });

        expect(documentLike.documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
        expect(startViewTransition).not.toHaveBeenCalled();
        expect(animate).not.toHaveBeenCalled();
    });
});
