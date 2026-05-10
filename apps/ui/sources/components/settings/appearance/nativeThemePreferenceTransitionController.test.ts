import { describe, expect, it, vi } from 'vitest';

import { createNativeThemePreferenceTransitionController } from './nativeThemePreferenceTransitionController';

describe('native theme preference transition controller', () => {
    it('captures the current surface before applying the theme and revealing the new surface', async () => {
        const events: string[] = [];
        const controller = createNativeThemePreferenceTransitionController({
            animateOverlay: vi.fn(async () => {
                events.push('animate');
            }),
            captureSurface: vi.fn(async () => {
                events.push('capture');
                return 'file://theme-before.png';
            }),
            hideOverlay: vi.fn(() => {
                events.push('hide');
            }),
            showOverlay: vi.fn((uri) => {
                events.push(`show:${uri}`);
            }),
            waitForFrame: vi.fn(async () => {
                events.push('frame');
            }),
        });

        await controller.run(() => {
            events.push('mutate');
        });

        expect(events).toEqual([
            'capture',
            'show:file://theme-before.png',
            'mutate',
            'frame',
            'animate',
            'hide',
        ]);
    });

    it('applies the theme immediately when capture fails', async () => {
        const mutation = vi.fn();
        const showOverlay = vi.fn();
        const controller = createNativeThemePreferenceTransitionController({
            animateOverlay: vi.fn(),
            captureSurface: vi.fn(async () => null),
            hideOverlay: vi.fn(),
            showOverlay,
            waitForFrame: vi.fn(),
        });

        await controller.run(mutation);

        expect(mutation).toHaveBeenCalledOnce();
        expect(showOverlay).not.toHaveBeenCalled();
    });
});
