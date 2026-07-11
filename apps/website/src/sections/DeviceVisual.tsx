import { useEffect, useRef, useState } from 'react';
import type { FeatureImage } from '../data/features';

type AccentName = 'sun' | 'coral' | 'rose' | 'magenta' | 'blue' | 'indigo';

type DeviceVisualProps = {
    kind: 'mobile' | 'desktop' | 'mobileAndDesktop';
    accent: AccentName;
    side: 'left' | 'right';
    image?: FeatureImage;
    /** Accessible label for feature art — announced when real art loads,
     *  consistent with the meaningful alt on the device-mockup fallback. */
    alt?: string;
};

/**
 * Each accent is a 2-stop gradient sampled from adjacent bands of the hero
 * planet image. Both stops are kept intentionally faint so the glow reads
 * as ambient atmosphere — like a soft tint of the planet's light bleeding
 * into the page — rather than a defined colored blob. The 32px container
 * blur further diffuses the falloff so there's no visible "edge".
 *
 *   Planet bands referenced: yellow → orange → red → pink → magenta →
 *   blue → indigo. Each accent's secondary is the adjacent band.
 */
type AccentStops = { primary: string; secondary: string };

const ACCENT_PALETTE: Record<AccentName, AccentStops> = {
    sun: {
        primary: 'rgba(245, 181, 71, 0.14)', // #F5B547 yellow-orange
        secondary: 'rgba(241, 137, 71, 0.06)', // peach toward coral
    },
    coral: {
        primary: 'rgba(231, 111, 74, 0.13)', // #E76F4A red-orange
        secondary: 'rgba(199, 61, 91, 0.06)', // toward rose
    },
    rose: {
        primary: 'rgba(199, 61, 91, 0.12)', // #C73D5B rose
        secondary: 'rgba(162, 59, 140, 0.06)', // toward magenta
    },
    magenta: {
        primary: 'rgba(162, 59, 140, 0.12)', // #A23B8C magenta
        secondary: 'rgba(91, 77, 175, 0.06)', // toward blue-purple
    },
    blue: {
        primary: 'rgba(81, 135, 255, 0.12)', // #5187FF bright blue
        secondary: 'rgba(68, 88, 201, 0.06)', // toward indigo
    },
    indigo: {
        primary: 'rgba(68, 88, 201, 0.12)', // #4458C9 indigo
        secondary: 'rgba(91, 77, 175, 0.05)', // toward purple (closes the loop)
    },
};

type DeviceImgLayout = {
    /** Absolute positioning rules. */
    position: { left?: string; right?: string; top?: string; bottom?: string };
    /** Sizing rule (e.g. height or width). */
    size: { height?: string; width?: string };
    /** Anchor for the translate baseline (drives the centering offset). */
    anchor: 'center' | 'leftCenter' | 'rightCenter';
    rotate: number;
    delay?: number;
};

const ANCHOR_TRANSFORMS: Record<DeviceImgLayout['anchor'], string> = {
    center: 'translate(-50%, -50%)',
    leftCenter: 'translate(-58%, -50%)',
    rightCenter: 'translate(0, -50%)',
};

/**
 * Renders a device or pair of devices (mobile.png / desktop.png) floating
 * over a soft accent glow. Animated in-view with a gentle rise.
 *
 * The container is `aspect-square` with `overflow-visible` so the device
 * can bleed slightly past its box for a more confident, premium look.
 */
export function DeviceVisual({ kind, accent, side, image, alt }: DeviceVisualProps) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [visible, setVisible] = useState(false);
    // When feature art is referenced but absent (or fails to load), fall back
    // to the generic device mockup so the page never shows a broken image.
    const [imageFailed, setImageFailed] = useState(false);

    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        setVisible(true);
                        observer.disconnect();
                    }
                }
            },
            { threshold: 0.22, rootMargin: '0px 0px -15% 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    // Give the image another chance to load if its source changes, so a prior
    // failure never permanently pins the mockup fallback.
    useEffect(() => {
        setImageFailed(false);
    }, [image?.src]);

    const stops = ACCENT_PALETTE[accent];
    const center = side === 'left' ? '35%' : '65%';

    return (
        <div ref={ref} className="relative aspect-square w-full overflow-visible">
            <div
                aria-hidden
                className="absolute inset-0"
                style={{
                    background: `radial-gradient(125% 105% at ${center} 50%, ${stops.primary} 0%, ${stops.secondary} 32%, transparent 78%)`,
                    opacity: visible ? 1 : 0,
                    transform: visible ? 'scale(1)' : 'scale(0.94)',
                    transition: 'opacity 900ms cubic-bezier(0.16,1,0.3,1), transform 900ms cubic-bezier(0.16,1,0.3,1)',
                    filter: 'blur(40px)',
                }}
            />

            {image && !imageFailed ? (
                <FeatureImg image={image} visible={visible} alt={alt} onError={() => setImageFailed(true)} />
            ) : (
                <>
                    {kind === 'mobile' && (
                        <DeviceImg
                            src="/images/mobile.png"
                            alt="Happier on a phone"
                            visible={visible}
                            layout={{
                                position: { left: '50%', top: '50%' },
                                size: { height: '112%' },
                                anchor: 'center',
                                rotate: -2,
                            }}
                        />
                    )}

                    {kind === 'desktop' && (
                        <DeviceImg
                            src="/images/desktop.png"
                            alt="Happier on a desktop"
                            visible={visible}
                            layout={{
                                position: { left: '50%', top: '50%' },
                                size: { width: '118%' },
                                anchor: 'center',
                                rotate: -1.2,
                            }}
                        />
                    )}

                    {kind === 'mobileAndDesktop' && (
                        <>
                            <DeviceImg
                                src="/images/desktop.png"
                                alt="Happier on a desktop"
                                visible={visible}
                                layout={{
                                    position: { left: '38%', top: '50%' },
                                    size: { width: '100%' },
                                    anchor: 'leftCenter',
                                    rotate: -1.5,
                                    delay: 120,
                                }}
                            />
                            <DeviceImg
                                src="/images/mobile.png"
                                alt="Happier on a phone"
                                visible={visible}
                                layout={{
                                    position: { right: '-2%', top: '50%' },
                                    size: { height: '100%' },
                                    anchor: 'rightCenter',
                                    rotate: 4,
                                    delay: 260,
                                }}
                            />
                        </>
                    )}
                </>
            )}
        </div>
    );
}

function DeviceImg({
    src,
    alt,
    visible,
    layout,
}: {
    src: string;
    alt: string;
    visible: boolean;
    layout: DeviceImgLayout;
}) {
    const anchor = ANCHOR_TRANSFORMS[layout.anchor];
    const rise = visible ? '0px' : '30px';
    const delay = layout.delay ?? 0;
    return (
        <img
            src={src}
            alt={alt}
            style={{
                position: 'absolute',
                ...layout.position,
                ...layout.size,
                transform: `${anchor} translateY(${rise}) rotate(${layout.rotate}deg)`,
                opacity: visible ? 1 : 0,
                transition: `opacity 900ms cubic-bezier(0.16,1,0.3,1) ${delay}ms, transform 900ms cubic-bezier(0.16,1,0.3,1) ${delay}ms`,
                filter:
                    'drop-shadow(0 60px 80px rgba(0, 0, 0, 0.55)) drop-shadow(0 8px 20px rgba(0, 0, 0, 0.35))',
                // Release the GPU layer once the one-shot reveal has run, so we
                // don't pin a promoted layer per image for the whole session.
                willChange: visible ? 'auto' : 'transform, opacity',
            }}
        />
    );
}

/** Swap a `.png`/`.jpg` source for its optimized `.webp` sibling. The image
 *  pipeline guarantees a `.webp` exists wherever the referenced raster does, so
 *  this derivation is what lets the <picture> serve webp with a png fallback. */
export function toWebp(src: string): string {
    return src.replace(/\.(png|jpe?g)$/i, '.webp');
}

function FeatureImg({
    image,
    visible,
    alt,
    onError,
}: {
    image: FeatureImage;
    visible: boolean;
    alt?: string;
    onError: () => void;
}) {
    const pngSrcSet = image.src2x ? `${image.src} 1x, ${image.src2x} 2x` : undefined;
    const webpSrcSet = image.src2x
        ? `${toWebp(image.src)} 1x, ${toWebp(image.src2x)} 2x`
        : toWebp(image.src);

    // `display: contents` lets the inner <img> position against the
    // DeviceVisual container (the <picture> box itself drops out of layout).
    // The optimize-images script guarantees a .webp exists whenever the .png
    // does, so a failed <source> only happens when there's no art at all —
    // in which case the <img> error bubbles up to the mockup fallback.
    return (
        <picture style={{ display: 'contents' }}>
            <source type="image/webp" srcSet={webpSrcSet} />
            <img
                src={image.src}
                srcSet={pngSrcSet}
                alt={alt ?? ''}
                onError={onError}
                className="rounded-2xl"
                style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: '100%',
                    maxWidth: '720px',
                    transform: `translate(-50%, -50%) translateY(${visible ? '0px' : '30px'})`,
                    opacity: visible ? 1 : 0,
                    transition: 'opacity 900ms cubic-bezier(0.16,1,0.3,1), transform 900ms cubic-bezier(0.16,1,0.3,1)',
                    filter:
                        'drop-shadow(0 40px 60px rgba(0, 0, 0, 0.4)) drop-shadow(0 8px 20px rgba(0, 0, 0, 0.25))',
                    // Release the GPU layer once the one-shot reveal has run, so we
                // don't pin a promoted layer per image for the whole session.
                willChange: visible ? 'auto' : 'transform, opacity',
                }}
            />
        </picture>
    );
}
