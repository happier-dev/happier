import type { AtmospherePixels, AtmosphereRgb } from '@happier-dev/brand/atmosphere';
import type { GlassAtmosphereTone } from '@/components/ui/glass/glassMaterial';

/** Fractions of the rendered picture (0–1 on each axis). */
export type PictureToneRegion = Readonly<{ x0: number; x1: number; y0: number; y1: number }>;

/** About this many samples describe a region; the picture is smooth at that scale, and the read stays cheap. */
const SAMPLES = 4096;

const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** Visits about `SAMPLES` pixels of a region as linear RGB, each seen over the page colour (a dissolved foot reads as page). */
function sampleRegion(pixels: AtmospherePixels, page: AtmosphereRgb, region: PictureToneRegion, visit: (r: number, g: number, b: number) => void): void {
    const clampFraction = (value: number) => Math.min(1, Math.max(0, value));
    const x0 = Math.floor(clampFraction(region.x0) * pixels.w);
    const x1 = Math.ceil(clampFraction(region.x1) * pixels.w);
    const y0 = Math.floor(clampFraction(region.y0) * pixels.h);
    const y1 = Math.ceil(clampFraction(region.y1) * pixels.h);
    if (x1 <= x0 || y1 <= y0) return;
    const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / SAMPLES)));
    for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
            const at = (y * pixels.w + x) * 4;
            const alpha = pixels.rgba[at + 3]! / 255;
            const channel = (index: number) => linear(pixels.rgba[at + index]! * alpha + page[index]! * (1 - alpha));
            visit(channel(0), channel(1), channel(2));
        }
    }
}

/** Sorted relative luminances of a region. */
function sampleLuminance(pixels: AtmospherePixels, page: AtmosphereRgb, region: PictureToneRegion): number[] {
    const values: number[] = [];
    sampleRegion(pixels, page, region, (r, g, b) => values.push(0.2126 * r + 0.7152 * g + 0.0722 * b));
    return values.sort((a, b) => a - b);
}

/**
 * A card can stand anywhere in the column, so its glass answers to the picture's near-extremes (a sunset's
 * glow, a dark ridge), not its average; the outermost few percent are specks the blur already softens.
 */
const EXTREME = 0.02;

const quantile = (values: readonly number[], fraction: number) =>
    Math.round(values[Math.min(values.length - 1, Math.floor(fraction * values.length))]! * 1000) / 1000;

/**
 * The tone of a rendered picture where content sits: the near-darkest and near-lightest of the content `column`,
 * and the middle of the `focus` region around its centre, where head lines stand. Glass and ink derive their
 * defaults from it.
 */
export function measurePictureTone(pixels: AtmospherePixels, page: AtmosphereRgb, column: PictureToneRegion, focus: PictureToneRegion = column): GlassAtmosphereTone | undefined {
    const values = sampleLuminance(pixels, page, column);
    const centre = sampleLuminance(pixels, page, focus);
    if (values.length === 0 || centre.length === 0) return undefined;
    return { dark: quantile(values, EXTREME), light: quantile(values, 1 - EXTREME), focus: quantile(centre, 0.5) };
}

/**
 * The mean colour of a region (in linear light, each pixel seen over the page colour), as an sRGB string: the hue
 * the Wallpaper haze's veil keeps when it deepens the picture under the head lines (`resolveWallpaperHaze`).
 */
export function measurePictureColor(pixels: AtmospherePixels, page: AtmosphereRgb, region: PictureToneRegion): string | undefined {
    const sum = [0, 0, 0];
    let count = 0;
    sampleRegion(pixels, page, region, (r, g, b) => { sum[0]! += r; sum[1]! += g; sum[2]! += b; count++; });
    if (count === 0) return undefined;
    const encode = (value: number) => Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055));
    return `rgb(${sum.map(value => encode(value / count)).join(', ')})`;
}

/** Luminance steps below this are measurement jitter (re-render dither); glass presents no difference. */
const TONE_EPSILON = 0.01;

/** A tone is republished only when it moves past the last published one, so every glass surface re-solves on real change only. */
export function samePictureTone(a: GlassAtmosphereTone | undefined, b: GlassAtmosphereTone | undefined): boolean {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    return a.ink === b.ink && Math.abs(a.dark - b.dark) < TONE_EPSILON && Math.abs(a.light - b.light) < TONE_EPSILON && Math.abs(a.focus - b.focus) < TONE_EPSILON;
}
