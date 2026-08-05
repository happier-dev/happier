import { describe, expect, it } from 'vitest';
import { featureImageSrcSets, toWebp } from './featureImageSources';

// The <picture> webp source is derived from the png src via toWebp; the image
// pipeline emits a .webp wherever it emits the raster, so this mapping must stay
// exact (basename + @2x suffix preserved, extension swapped).
describe('toWebp', () => {
    it('swaps png / jpg / jpeg for webp, preserving the @2x suffix', () => {
        expect(toWebp('/images/features/voice.png')).toBe('/images/features/voice.webp');
        expect(toWebp('/images/features/voice@2x.png')).toBe('/images/features/voice@2x.webp');
        expect(toWebp('/images/features/subscriptions.jpg')).toBe('/images/features/subscriptions.webp');
        expect(toWebp('/a/b.jpeg')).toBe('/a/b.webp');
    });

    it('is case-insensitive on the extension', () => {
        expect(toWebp('/x/Y.PNG')).toBe('/x/Y.webp');
        expect(toWebp('/x/Y.JPG')).toBe('/x/Y.webp');
    });

    it('leaves non-raster paths unchanged', () => {
        expect(toWebp('/x/y.webp')).toBe('/x/y.webp');
        expect(toWebp('/x/y')).toBe('/x/y');
    });
});

describe('featureImageSrcSets', () => {
    it('pairs 1x and 2x candidates in both formats when @2x art exists', () => {
        expect(
            featureImageSrcSets({
                src: '/images/features/mcp.png',
                src2x: '/images/features/mcp@2x.png',
            }),
        ).toEqual({
            png: '/images/features/mcp.png 1x, /images/features/mcp@2x.png 2x',
            webp: '/images/features/mcp.webp 1x, /images/features/mcp@2x.webp 2x',
        });
    });

    // A one-candidate srcSet duplicates `src`, so it is deliberately omitted —
    // but the webp <source> still has to be emitted or webp is never served.
    it('omits the png srcSet but keeps the webp source when there is no @2x art', () => {
        expect(featureImageSrcSets({ src: '/images/features/mcp.png' })).toEqual({
            png: undefined,
            webp: '/images/features/mcp.webp',
        });
    });
});
