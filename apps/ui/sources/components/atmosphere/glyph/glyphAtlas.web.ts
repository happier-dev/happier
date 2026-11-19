import type { AtmosphereGlyphAtlas } from '@happier-dev/brand/atmosphere';
import { getHappierFontFamily, themeFontFamilyVariableName } from '@/constants/Typography';
import { releaseCanvasBackingStore } from '@/components/ui/media/canvasBackingStore';

// Canvas text does not resolve CSS var() itself, so read the typography owner's variable.
export function planetCanvasFonts() {
    const family = (weight: 'regular' | 'semiBold') => {
        const value = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(themeFontFamilyVariableName('mono', weight)).trim();
        return value || `"${getHappierFontFamily('mono', weight)}", "IBM Plex Mono", ui-monospace, monospace`;
    };
    return { regular: family('regular'), semiBold: family('semiBold') };
}



/** Lab atlas: contiguous cw × ch alpha masks, with the same glyph size and baseline. */
export async function glyphAtlas(spec: { w: number; h: number; chars: string }, dpr: number): Promise<AtmosphereGlyphAtlas> {
    const font = planetCanvasFonts().regular;
    await document.fonts.load(`12px ${font}`);
    const cw = Math.max(3, Math.round(spec.w * dpr)), ch = Math.max(5, Math.round(spec.h * dpr)), gh = spec.h * dpr;
    const list = Array.from(spec.chars);
    const canvas = document.createElement('canvas'); canvas.width = cw * list.length; canvas.height = ch;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Atmosphere glyph canvas is unavailable');
    context.fillStyle = '#fff'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.font = `${Math.round(gh * 0.94)}px ${font}`;
    list.forEach((character, index) => context.fillText(character, index * cw + cw / 2, ch / 2 + gh * 0.04));
    const pixels = context.getImageData(0, 0, canvas.width, ch).data;
    const masks = new Uint8Array(cw * ch * list.length);
    list.forEach((_character, index) => {
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) masks[index * cw * ch + y * cw + x] = pixels[(y * cw * list.length + index * cw + x) * 4 + 3];
    });
    releaseCanvasBackingStore(canvas);
    return { cw, ch, chars: spec.chars, masks };
}
