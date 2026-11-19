import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';
import { createWorkletRuntime, runOnRuntimeAsync, type WorkletRuntime } from 'react-native-worklets';
import type { AtmosphereGlyphAtlas } from '@happier-dev/brand/atmosphere';

let runtime: WorkletRuntime | undefined;
let fontBytes: Promise<string> | undefined;

/** Same atlas layout as web, rasterized on a native worker runtime rather than the UI thread. */
export async function glyphAtlas(spec: { w: number; h: number; chars: string }, dpr: number): Promise<AtmosphereGlyphAtlas> {
    fontBytes ??= (async () => {
        const asset = Asset.fromModule(require('@/assets/fonts/IBMPlexMono-Regular.ttf'));
        await asset.downloadAsync();
        return new File(asset.localUri ?? asset.uri).base64();
    })();
    runtime ??= createWorkletRuntime({ name: 'happier-atmosphere-glyphs' });
    const api = Skia, colorType = ColorType.RGBA_8888, alphaType = AlphaType.Unpremul;
    return runOnRuntimeAsync(runtime, (input: typeof spec, ratio: number, bytes: string) => {
        'worklet';
        const cw = Math.max(3, Math.round(input.w * ratio)), ch = Math.max(5, Math.round(input.h * ratio)), gh = input.h * ratio;
        const list = Array.from(input.chars), width = cw * list.length;
        const data = api.Data.fromBase64(bytes);
        try {
            const typeface = api.Typeface.MakeFreeTypeFaceFromData(data);
            if (!typeface) throw new Error('Atmosphere mono typeface is unavailable');
            try {
                const font = api.Font(typeface, Math.round(gh * 0.94));
                const paint = api.Paint(); paint.setAntiAlias(true); paint.setColor(new Float32Array([1, 1, 1, 1]));
                const surface = api.Surface.Make(width, ch);
                if (!surface) { font.dispose(); paint.dispose(); throw new Error('Atmosphere glyph surface is unavailable'); }
                try {
                    const metrics = font.getMetrics();
                    list.forEach((character, index) => surface.getCanvas().drawText(character,
                        index * cw + cw / 2 - font.getGlyphWidths(font.getGlyphIDs(character))[0] / 2,
                        ch / 2 + gh * 0.04 - (metrics.ascent + metrics.descent) / 2, paint, font));
                    surface.flush();
                    const image = surface.makeImageSnapshot();
                    try {
                        const pixels = image.readPixels(0, 0, { width, height: ch, colorType, alphaType });
                        if (!pixels) throw new Error('Atmosphere glyph pixels are unavailable');
                        const masks = new Uint8Array(cw * ch * list.length);
                        list.forEach((_character, index) => {
                            for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) masks[index * cw * ch + y * cw + x] = pixels[(y * width + index * cw + x) * 4 + 3];
                        });
                        return { cw, ch, chars: input.chars, masks };
                    } finally { image.dispose(); }
                } finally { surface.dispose(); font.dispose(); paint.dispose(); }
            } finally { typeface.dispose(); }
        } finally { data.dispose(); }
    }, spec, dpr, await fontBytes);
}
