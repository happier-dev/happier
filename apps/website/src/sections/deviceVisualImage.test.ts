import { describe, expect, it } from 'vitest';
import { toWebp } from './DeviceVisual';

// The <picture> webp source is derived from the png src via toWebp; the image
// pipeline emits a .webp wherever it emits the raster, so this mapping must stay
// exact (basename + @2x suffix preserved, extension swapped).
describe('toWebp', () => {
    it('swaps png / jpg / jpeg for webp, preserving the @2x suffix', () => {
        expect(toWebp('/images/features/voice.png')).toBe('/images/features/voice.webp');
        expect(toWebp('/images/features/voice@2x.png')).toBe('/images/features/voice@2x.webp');
        expect(toWebp('/images/features/connected-services.jpg')).toBe('/images/features/connected-services.webp');
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
