import { IMAGES, type ImageId } from '../data/generatedImages';

type PictureProps = {
    /** Key into the generated manifest. Typed, so a renamed source is a build error. */
    id: ImageId;
    alt: string;
    className?: string;
    imgClassName?: string;
    style?: React.CSSProperties;
    /**
     * `true` on the ONE image that is (or races to be) the LCP element. It sets
     * fetchpriority=high and eager loading. Everything else defaults to lazy +
     * async decode. More than one high-priority image is the same as none.
     */
    priority?: boolean;
    /** Override the manifest `sizes` when a call site renders at a different width. */
    sizes?: string;
    draggable?: boolean;
    imgRef?: React.Ref<HTMLImageElement>;
    onLoad?: React.ReactEventHandler<HTMLImageElement>;
    'aria-hidden'?: boolean;
    onError?: React.ReactEventHandler<HTMLImageElement>;
};

/**
 * The only way this site renders a raster.
 *
 * Three things it guarantees that hand-written <img> tags did not:
 *
 *   1. AVIF first, WebP second, one small fallback last — with a real `srcSet`
 *      and `sizes`, so a 390px phone downloads a 390px image instead of the
 *      2560px one a desktop needs. The hero backdrop alone goes from 953 KB to
 *      1.3 KB at phone width.
 *   2. `width`/`height` from the SOURCE's intrinsic size. The aspect ratio is
 *      therefore known before any bytes arrive, the box is reserved, and the
 *      image cannot shift the layout. This is not a "nice to have": the page
 *      renders images inside absolutely-positioned wrappers where a missing
 *      box silently becomes zero height.
 *   3. lazy + async decode by default, with exactly one opt-out (`priority`).
 *
 * <img> attributes win over <source> ones for width/height, so both are set on
 * the <img> and every <source> inherits the same box.
 */
export function Picture({
    id,
    alt,
    className,
    imgClassName,
    style,
    priority = false,
    sizes,
    draggable,
    imgRef,
    onLoad,
    onError,
    'aria-hidden': ariaHidden,
}: PictureProps) {
    const img = IMAGES[id];
    const resolvedSizes = sizes ?? img.sizes;

    return (
        <picture className={className}>
            <source type="image/avif" srcSet={img.avif} sizes={resolvedSizes} />
            <source type="image/webp" srcSet={img.webp} sizes={resolvedSizes} />
            <img
                ref={imgRef}
                src={img.fallback}
                alt={alt}
                width={img.width}
                height={img.height}
                sizes={resolvedSizes}
                className={imgClassName}
                style={style}
                loading={priority ? 'eager' : 'lazy'}
                fetchPriority={priority ? 'high' : 'auto'}
                decoding={priority ? 'sync' : 'async'}
                draggable={draggable}
                aria-hidden={ariaHidden}
                onError={onError}
                onLoad={onLoad}
            />
        </picture>
    );
}

/**
 * The `<link rel="preload">` tags for the LCP image, emitted into the
 * prerendered <head> by scripts/prerender.mjs.
 *
 * A preload for a responsive image MUST repeat imagesrcset + imagesizes, or the
 * browser preloads a candidate the renderer then rejects and downloads twice.
 * `type` narrows it to AVIF so non-AVIF browsers skip the preload entirely
 * rather than fetching a format they cannot decode.
 */
export function preloadTagsFor(id: ImageId): string {
    const img = IMAGES[id];
    return (
        `<link rel="preload" as="image" type="image/avif"` +
        ` imagesrcset="${img.avif.replace(/"/g, '&quot;')}"` +
        ` imagesizes="${img.sizes.replace(/"/g, '&quot;')}" fetchpriority="high">`
    );
}
