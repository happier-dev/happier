import { useEffect, useRef, useState } from 'react';
import { useTheme, type ThemeName } from '../islands/themeStore';
import { IMAGES } from '../data/generatedImages';

/**
 * The hero's planet backdrop — the page's LCP element.
 *
 * WHAT THIS REPLACES
 * Hero.tsx rendered BOTH theme backdrops as plain <img src="…jpg">, always,
 * with no srcset, no width/height, no loading hint and no format negotiation:
 *
 *   background5_black_jpg60.jpg   953.2 KB   6144 x 4096
 *   background5_white_jpg60.jpg   620.8 KB   6144 x 4096
 *
 * Every visitor, on every device, downloaded 1,574 KB of backdrop to paint a
 * ~1440 x 700 box — and decoded 25.2 megapixels TWICE. A decoded 6144x4096
 * bitmap is ~101 MB of RAM; two of them is ~202 MB before React has rendered a
 * word. That is the single worst thing on the page for the 1,766 Chinese-locale
 * and 762 Android devices in the funnel, and it is why LCP measures 4.1 s on
 * Slow 4G with the image still not fully arrived.
 *
 * WHAT IT DOES NOW
 *   - AVIF, then WebP, then one JPEG, at five widths. The 2560px AVIF of the
 *     dark backdrop is 16.1 KB; the 640px one is 1.3 KB.
 *   - width/height from the source, so the box exists before the bytes.
 *   - fetchpriority=high + a matching <link rel=preload> in the prerendered
 *     head (see preloadTagsFor in components/Picture.tsx).
 *   - ONLY the active theme's layer is in the DOM. The other mounts on first
 *     toggle and stays mounted, so the cross-fade still works but a visitor who
 *     never touches the toggle never fetches the other theme's art.
 *
 * The deferred mount is worth ~4 KB now that the art is AVIF, not the ~621 KB
 * it was worth before. It is kept because it also avoids the second decode and
 * the second compositor layer, which is the part that costs on a phone.
 */

const LAYER: Record<ThemeName, { id: 'heroBackdropDark' | 'heroBackdropLight'; filter?: string }> = {
    dark: { id: 'heroBackdropDark' },
    light: { id: 'heroBackdropLight', filter: 'saturate(1.1)' },
};

export function HeroBackdrop() {
    const { theme } = useTheme();

    // Themes whose layer has ever been needed. Starts as just the initial one,
    // which on the prerendered page is always 'dark' — so the shipped HTML
    // contains exactly one backdrop and the preload scanner has exactly one
    // candidate to race on.
    const [mounted, setMounted] = useState<ThemeName[]>([theme]);
    useEffect(() => {
        setMounted((prev) => (prev.includes(theme) ? prev : [...prev, theme]));
    }, [theme]);

    return (
        <div className="pointer-events-none absolute inset-0 -z-10">
            {mounted.map((name) => (
                <BackdropLayer key={name} name={name} active={name === theme} />
            ))}
            {/* Scrims are theme-agnostic gradients over whichever layer is up.
                They were duplicated per theme before; one set is enough because
                both ramps end at var(--bg), which animates with the theme. */}
            <div
                className="absolute inset-y-0 left-0 w-full lg:w-[58%]"
                style={{
                    background:
                        theme === 'dark'
                            ? 'linear-gradient(to right, #050507 0%, rgba(5,5,7,0.92) 35%, rgba(5,5,7,0.45) 70%, rgba(5,5,7,0) 100%)'
                            : 'none',
                }}
            />
            <div
                className="absolute inset-x-0 bottom-0"
                style={{
                    height: theme === 'dark' ? '33.333%' : '25%',
                    background: 'linear-gradient(to bottom, transparent 0%, var(--bg) 100%)',
                }}
            />
        </div>
    );
}

function BackdropLayer({ name, active }: { name: ThemeName; active: boolean }) {
    const { id, filter } = LAYER[name];
    const img = IMAGES[id];
    const ref = useRef<HTMLImageElement | null>(null);

    // A layer that mounts already-active would jump from nothing to full
    // opacity with no transition (React commits the mount and the class in one
    // paint). Holding it at 0 for one frame — and, when the bytes are not in
    // cache, until decode() settles — is what makes the toggle cross-fade
    // instead of flash.
    const [revealed, setRevealed] = useState(active);
    useEffect(() => {
        if (revealed || !active) return;
        let cancelled = false;
        const node = ref.current;
        const show = () => {
            if (!cancelled) requestAnimationFrame(() => !cancelled && setRevealed(true));
        };
        if (node && !node.complete && typeof node.decode === 'function') {
            node.decode().then(show, show);
        } else {
            show();
        }
        return () => {
            cancelled = true;
        };
    }, [active, revealed]);

    const isPrimary = name === 'dark';

    return (
        <div
            className="absolute inset-0"
            style={{ opacity: active && revealed ? 1 : 0, transition: 'opacity 700ms ease' }}
        >
            <picture>
                <source type="image/avif" srcSet={img.avif} sizes={img.sizes} />
                <source type="image/webp" srcSet={img.webp} sizes={img.sizes} />
                <img
                    ref={ref}
                    src={img.fallback}
                    alt=""
                    aria-hidden
                    width={img.width}
                    height={img.height}
                    sizes={img.sizes}
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{ objectPosition: '80% 20%', filter }}
                    // The dark layer is the LCP element on a cold, prerendered,
                    // default-theme load. It is the only image on the page that
                    // gets high priority — a second one would just contend.
                    loading="eager"
                    fetchPriority={isPrimary ? 'high' : 'low'}
                    decoding={isPrimary ? 'sync' : 'async'}
                    draggable={false}
                />
            </picture>
        </div>
    );
}
