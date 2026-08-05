import type { FeatureImage } from './features';

/** Swap a `.png`/`.jpg` source for its optimized `.webp` sibling. The image
 *  pipeline (`scripts/optimize-feature-images.mjs`) guarantees a `.webp` exists
 *  wherever the referenced raster does, so this derivation is what lets a
 *  `<picture>` serve webp with a png fallback. */
export function toWebp(src: string): string {
    return src.replace(/\.(png|jpe?g)$/i, '.webp');
}

/**
 * The `srcSet` pair for a piece of feature art.
 *
 * `png` is undefined when there is no @2x source, because a single-candidate
 * `srcSet` tells the browser nothing the `src` attribute did not already say.
 * `webp` is always present — it is the whole point of the `<source>` element.
 */
export function featureImageSrcSets(image: FeatureImage): { png?: string; webp: string } {
    if (!image.src2x) {
        return { webp: toWebp(image.src) };
    }
    return {
        png: `${image.src} 1x, ${image.src2x} 2x`,
        webp: `${toWebp(image.src)} 1x, ${toWebp(image.src2x)} 2x`,
    };
}
