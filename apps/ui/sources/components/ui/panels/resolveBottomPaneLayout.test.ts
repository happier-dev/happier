import { describe, expect, it } from 'vitest';

import { resolveBottomPaneLayout } from './resolveBottomPaneLayout';

describe('resolveBottomPaneLayout', () => {
    it('uses a docked presentation when the container can fit main + bottom minimum heights', () => {
        const resolved = resolveBottomPaneLayout({
            containerHeightPx: 1000,
            mainMinHeightPx: 420,
            bottomMinHeightPx: 220,
        });

        expect(resolved.presentation).toBe('docked');
        expect(resolved.dockMaxHeightPx).toBe(580);
    });

    it('uses an overlay presentation when the container cannot fit main + bottom minimum heights', () => {
        const resolved = resolveBottomPaneLayout({
            containerHeightPx: 600,
            mainMinHeightPx: 420,
            bottomMinHeightPx: 220,
        });

        expect(resolved.presentation).toBe('overlay');
        expect(resolved.overlayMaxHeightPx).toBe(600);
    });

    it('uses an overlay presentation when the preferred bottom height exceeds the dock budget', () => {
        const resolved = resolveBottomPaneLayout({
            containerHeightPx: 900,
            mainMinHeightPx: 420,
            bottomMinHeightPx: 220,
            preferredHeightPx: 560,
        });

        expect(resolved.presentation).toBe('overlay');
        expect(resolved.dockMaxHeightPx).toBe(480);
        expect(resolved.overlayMaxHeightPx).toBe(900);
    });
});
