/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createBackdropWebStyle, createFloatingBackdropPictureWebStyle, createModalScrimWebStyle, createScrimBandWebLayers } from './createBackdropLayerStyle';

describe('floating New backdrop strength', () => {
    const overlay = { scrim: 'black', scrimWizard: 'gray', scrimStrong: 'white' };
    const picture = { kind: 'picture', uri: '/backdrop.jpg' } as const;

    it('changes both frost and picture through the selected strength, defaulting to soft', () => {
        const scrim = (strength: 'subtle' | 'soft' | 'medium' | 'rich') => createModalScrimWebStyle({
            overlay, enableBlur: true, frost: 'floating', strength,
        });
        expect(scrim('subtle')).not.toEqual(scrim('rich'));
        const subtlePicture = createFloatingBackdropPictureWebStyle(picture, 'subtle');
        const richPicture = createFloatingBackdropPictureWebStyle(picture, 'rich');
        expect(Number(subtlePicture.opacity)).toBeLessThan(Number(richPicture.opacity));
        expect(subtlePicture.filter).not.toEqual(richPicture.filter);
        expect(createModalScrimWebStyle({ overlay, enableBlur: true, frost: 'floating' })).toEqual(scrim('soft'));
        expect(createFloatingBackdropPictureWebStyle(picture)).toEqual(createFloatingBackdropPictureWebStyle(picture, 'soft'));
    });

    it('keeps ordinary dialogs and reduced-transparency veils independent of New strength', () => {
        const scrim = (strength: 'subtle' | 'rich', enableBlur: boolean, frost?: 'floating') =>
            createModalScrimWebStyle({ overlay, enableBlur, frost, strength });
        expect(scrim('subtle', true)).toEqual(scrim('rich', true));
        expect(scrim('subtle', false, 'floating')).toEqual(scrim('rich', false, 'floating'));
    });
});

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
        expect(style.WebkitBackdropFilter).toBe('blur(min(var(--happier-glass-floating-blur, 4px), 4px))');
        expect(style.backdropFilter).toBe('blur(min(var(--happier-glass-floating-blur, 4px), 4px))');
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

    it('lets a material surface take its group blur, while a scrim only switches off with it', () => {
        // A scrim keeps the page behind a popover legible: the strong floating blur belongs to the
        // popover itself, so a scrim is capped at its own radius and only follows glass being off.
        const surface = createBackdropWebStyle({ backgroundColor: '#fff', blurPx: 24, surfaceGroup: 'floating' });
        const scrim = createBackdropWebStyle({ backgroundColor: 'rgba(0,0,0,0.1)', blurPx: 2 });
        expect(surface.backdropFilter).toBe('blur(var(--happier-glass-floating-blur, 24px))');
        expect(scrim.backdropFilter).toBe('blur(min(var(--happier-glass-floating-blur, 2px), 2px))');
    });

    it('follows the live material variable rather than capturing the retired device preference', () => {
        document.documentElement.dataset.happyBackdropBlur = 'off';

        const style = createBackdropWebStyle({
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            fallbackBackgroundColorWhenBlurDisabled: 'rgba(0, 0, 0, 0.58)',
        });

        expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0.45)');
        expect(style.WebkitBackdropFilter).toBe('blur(min(var(--happier-glass-floating-blur, 12px), 12px))');
        expect(style.backdropFilter).toBe('blur(min(var(--happier-glass-floating-blur, 12px), 12px))');
    });
});

describe('band behind a seated header (phone and centred desktop)', () => {
    /** The veil's mask strength at `px` from the band's top edge, read from its vertical CSS gradient. */
    function maskAlphaAt(mask: string, px: number): number {
        const vertical = mask.split(', linear-gradient(to right')[0]!;
        const stops = [...vertical.matchAll(/rgba\(0,0,0,([\d.]+)\) ([\d.]+)px/g)].map(match => ({ alpha: Number(match[1]), at: Number(match[2]) }));
        const after = stops.findIndex(stop => stop.at >= px);
        if (after <= 0) return after === 0 ? stops[0]!.alpha : stops.at(-1)!.alpha;
        const [a, b] = [stops[after - 1]!, stops[after]!];
        return a.alpha + (b.alpha - a.alpha) * ((px - a.at) / (b.at - a.at));
    }

    it.each([true, false])('holds a centred desktop band solid from the surface down and dissolves only above it (blur %s)', (enableBlur) => {
        const rampPx = 200;
        const layers = createScrimBandWebLayers({
            ground: 'rgb(24, 20, 20)', enableBlur, strength: 'soft', rampPx, axes: 'centre', sidePx: 100,
        });
        expect(layers.veil.backgroundColor).toBe('rgb(24, 20, 20)');
        const mask = String(layers.veil.maskImage);
        // The surface's top edge sits the ramp's underlap above the band's bottom of the ramp: solid from there down,
        // where the header row is seated.
        for (const belowSurfaceTop of [0, 14, 28]) expect(maskAlphaAt(mask, rampPx - 28 + belowSurfaceTop)).toBe(1);
        // Above it the band only dissolves, so the frost and picture show there.
        expect(maskAlphaAt(mask, (rampPx - 28) / 2)).toBeLessThan(0.5);
        expect(maskAlphaAt(mask, 0)).toBe(0);
        // Sideways it is whole at the surface's edges, the room beside it in.
        const sideways = mask.split(', linear-gradient(to right')[1]!;
        expect(sideways).toContain('rgba(0,0,0,1.000) 100.0px');
        expect(sideways).toContain('rgba(0,0,0,1.000) calc(100% - 100.0px)');
    });

    it.each([true, false])('hides the page behind the status line and header in every tier (blur %s)', (enableBlur) => {
        const rampPx = 128;
        const layers = createScrimBandWebLayers({
            ground: 'rgb(24, 20, 20)', enableBlur, strength: 'soft', rampPx, axes: 'top',
        });
        // The ground is the page colour, opaque: blur alone leaves dense list text readable.
        expect(layers.veil.backgroundColor).toBe('rgb(24, 20, 20)');
        const mask = String(layers.veil.maskImage);
        // From the card up past the status line (~60px above the card, the ramp's top 100px above it).
        for (const aboveCard of [0, 30, 62]) expect(maskAlphaAt(mask, rampPx - 28 - aboveCard)).toBeGreaterThanOrEqual(0.9);
        // Still a band: the top of the ramp is clear.
        expect(maskAlphaAt(mask, 0)).toBe(0);
    });
});
