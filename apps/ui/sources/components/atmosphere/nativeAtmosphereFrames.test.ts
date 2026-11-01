import { expect, it } from 'vitest';
import { createAtmosphereWorkletCore } from './backdropWorkletCore.generated';
import { atmosphereRipple, createAtmosphereTransition } from '@happier-dev/brand/atmosphere';

it('paints the same resettle, reduced crossfade and glyph ring pixels as web', () => {
    const core = createAtmosphereWorkletCore();
    const w = 32, h = 24;
    const input = { from: { rgba: new Uint8ClampedArray(w * h * 4).fill(40), w, h },
        to: { rgba: new Uint8ClampedArray(w * h * 4).fill(190), w, h }, page: [245, 245, 245] as const, theme: 'light' as const, dpr: 2 };
    for (const kind of ['resettle', 'crossfade'] as const) {
        const native = core.createAtmosphereTransition(kind, input), web = createAtmosphereTransition(kind, input);
        for (const t of [0, 0.3, 0.55, 0.8, 1]) expect(native.frame(t)).toEqual(web.frame(t));
    }
    for (const theme of ['light', 'dark'] as const) for (const t of [0, 0.25, 0.5, 1]) {
        const options = { w, h, theme, page: input.page, dpr: 2, x: 12, y: 6, glyphs: { cw: 3, ch: 5, chars: '0123456789', masks: new Uint8Array(150).fill(255) } };
        expect(core.atmosphereRipple(t, options).rgba).toEqual(atmosphereRipple(t, options).rgba);
    }
});
