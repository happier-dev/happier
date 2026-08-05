import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { PRIMARY_FEATURES, type Feature } from '../data/features';
import { featureImageSrcSets } from '../data/featureImageSources';
import { RevealText } from '../components/RevealText';
import clsx from 'clsx';

/**
 * Feature panels.
 *
 * Every feature is a "specimen panel": a contained rounded window with a
 * gradient hairline, holding a CROP of the planet photograph blended so the
 * crop's own rectangle is invisible (screen on dark, multiply on light — see
 * globals.css). That is the same figure/ground idea as the closing
 * "Open source. Yours forever." block, promoted to a system.
 *
 * Panels take explicit 12-column spans (12 / 7+5 / 5+7) and two heights, so
 * fourteen features read as a composed wall instead of fourteen identical rows.
 * The product art inside is transparent — it carries no plate of its own, so it
 * sits in the panel's light instead of on top of it like a sticker.
 *
 * Every panel clips its own contents (`.fpanel` is `overflow: hidden`), so the
 * deliberate bleed below never reaches the page and cannot cause horizontal
 * scroll.
 */

type Span = 12 | 7 | 5;

type PanelSpec = {
    /** 12-column span at md+ */
    span: Span;
    /** taller panel for features whose art deserves room */
    tall?: boolean;
    /** star crop: zoom, sample position (hue anchor), intensity */
    sz: string;
    sp: string;
    so: number;
    /**
     * Wide-panel art direction (md+ only; below that every panel's art is in
     * flow under the copy). `artW` is the overlay's width — one value cannot
     * serve every asset, since a landscape composition and a portrait phone
     * need very different zoom at the same panel size. `artFloor` rests the
     * art on the panel's bottom edge instead of hanging it from the top, for
     * assets already cropped at their own bottom.
     */
    artW?: string;
    artFloor?: boolean;
    /**
     * In-flow art direction, used below md (and by narrow panels at every
     * width). `artMobileW` zooms the image past the panel width — a wide
     * landscape composition shown at 100% on a phone is an illegible strip —
     * and it stays centred, so zooming crops both edges evenly.
     * `artMobileMin` gives that zoom the height it needs.
     */
    artMobileW?: string;
    artMobileMin?: string;
};

/**
 * The sample position walks around the sphere as the reader descends, so the
 * light changes hue continuously down the page from ONE asset. `so` is each
 * panel's RELATIVE intensity; the page-wide `--fp-star-gain` in globals.css
 * scales them all together, so overall weight is tuned in exactly one place.
 */
const LAYOUT: Record<string, PanelSpec> = {
    anywhere:         { span: 12, tall: true, sz: '206%', sp: '76% 20%', so: 0.5,
                        artW: '80%', artFloor: true, artMobileW: '170%', artMobileMin: '250px' },
    existingSessions: { span: 7,  tall: true, sz: '250%', sp: '84% 16%', so: 0.52 },
    terminalTuis:     { span: 5,  tall: true, sz: '300%', sp: '56% 34%', so: 0.5 },
    cockpit:          { span: 5,  tall: true, sz: '344%', sp: '74% 40%', so: 0.44 },
    subagents:        { span: 7,  tall: true, sz: '360%', sp: '66% 56%', so: 0.56 },
    queue:            { span: 12, tall: true, sz: '262%', sp: '70% 26%', so: 0.4 },
    attention:        { span: 5,              sz: '322%', sp: '70% 50%', so: 0.46 },
    review:           { span: 7,  tall: true, sz: '380%', sp: '66% 24%', so: 0.5 },
    voice:            { span: 12, tall: true, sz: '224%', sp: '78% 30%', so: 0.54 },
    mcp:              { span: 7,  tall: true, sz: '300%', sp: '60% 42%', so: 0.48 },
    subscriptions:    { span: 5,  tall: true, sz: '336%', sp: '72% 22%', so: 0.5 },
    accounts:         { span: 7,  tall: true, sz: '288%', sp: '80% 36%', so: 0.52 },
    customization:    { span: 5,              sz: '352%', sp: '62% 52%', so: 0.44 },
    privacy:          { span: 12,             sz: '188%', sp: '76% 28%', so: 0.58 },
};

const SPAN_CLASS: Record<Span, string> = {
    12: 'md:col-span-12',
    7: 'md:col-span-7',
    5: 'md:col-span-5',
};

export function AlternatingFeatures() {
    return (
        <section id="features" className="relative">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="section-head mx-auto max-w-[760px] text-center">
                    <div
                        className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: 'var(--muted)' }}
                    >
                        What Happier does
                    </div>
                    <RevealText
                        as="h2"
                        text={'One control room\nfor every coding agent.'}
                        className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                        stagger={60}
                    />
                    <p
                        className="mx-auto mt-6 max-w-[560px] text-[17px] leading-[1.55] md:text-[18px]"
                        style={{ color: 'var(--muted)' }}
                    >
                        Happier is the mobile-native control layer for the AI coding agents you already use.
                        It mirrors your terminal, syncs every session, and gives you back the things a CLI
                        can&apos;t: presence, approvals, voice, and one inbox for all of it.
                    </p>
                </div>

                <div className="grid grid-cols-1 gap-5 md:grid-cols-12 md:gap-6">
                    {PRIMARY_FEATURES.map((feature) => (
                        <FeaturePanel key={feature.id} feature={feature} />
                    ))}
                </div>
            </div>
        </section>
    );
}

function FeaturePanel({ feature }: { feature: Feature }) {
    const spec: PanelSpec = LAYOUT[feature.id] ?? { span: 7, sz: '300%', sp: '70% 30%', so: 0.48 };
    const ref = useRef<HTMLElement | null>(null);
    const [visible, setVisible] = useState(false);

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
            { threshold: 0.14, rootMargin: '0px 0px -8% 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    const wide = spec.span === 12;
    const hasArt = Boolean(feature.image);
    // Reserve extra height ONLY when there is art to fill it — otherwise a
    // text-only panel becomes a tall empty box.
    const tall = Boolean(spec.tall) && hasArt;

    return (
        <article
            ref={ref}
            className={clsx('fpanel', SPAN_CLASS[spec.span], visible && 'is-in')}
            style={
                {
                    '--sz': spec.sz,
                    '--sp': spec.sp,
                    '--so': spec.so,
                    '--fp-art-w': spec.artW,
                    '--fp-art-mobile-w': spec.artMobileW,
                    '--fp-art-mobile-min': spec.artMobileMin,
                    minHeight: tall
                        ? wide
                            ? 'clamp(360px, 31vw, 460px)'
                            : 'clamp(420px, 40vw, 560px)'
                        : undefined,
                } as CSSProperties
            }
        >
            <div aria-hidden className="fpanel__star" />
            <div aria-hidden className="fpanel__flare" />
            <div aria-hidden className="fpanel__veil" />

            <div
                className={clsx(
                    'fpanel__in relative z-[3] flex h-full flex-col',
                    // a 12-col panel has room to breathe: centre the copy in it
                    wide && 'md:justify-center',
                )}
            >
                {/* Copy sits away from the light, which enters at the top-right, and
                    stacks above the art so a wide panel's overlay cannot cover it. */}
                <div className={clsx('relative z-[2]', wide ? 'max-w-[560px]' : 'max-w-[100%]')}>
                    <h3
                        className={clsx(
                            'font-display font-normal leading-[1.08] tracking-[-0.025em]',
                            // Wide panels carry a longer measure and more air, so they step
                            // up; narrow panels stay on the site's display floor. Both sit
                            // clearly below the section h2 (56px) they belong to.
                            wide
                                ? 'text-[32px] md:text-[40px] lg:text-[48px]'
                                : 'text-[28px] md:text-[32px] lg:text-[36px]',
                        )}
                        style={{ color: 'var(--fg)' }}
                    >
                        {feature.title}
                    </h3>
                    <p
                        className={clsx(
                            'text-[17px] leading-[1.55] md:text-[18px]',
                            wide ? 'mt-5' : 'mt-4',
                        )}
                        style={{ color: 'var(--muted)' }}
                    >
                        {feature.body}
                    </p>
                </div>

                {/* Always AFTER the copy in the DOM. On phones the art is in flow and
                    must land below the text; from `md` a wide panel's art lifts out
                    into an absolute overlay beside it, where source order no longer
                    affects placement. */}
                {hasArt && (
                    <PanelArt
                        feature={feature}
                        wide={wide}
                        floor={Boolean(spec.artFloor)}
                        visible={visible}
                    />
                )}
            </div>
        </article>
    );
}

/**
 * The product art inside a panel.
 *
 * The assets are transparent — cut-outs of real app UI with no plate of their
 * own — so CSS owns their shadow (`--fp-art-shadow`, cast down-LEFT, away from
 * the light the panel's star brings in from the top-right). The art is oversized
 * so the PANEL's own edge crops it: a window onto something larger rather than a
 * picture in a frame.
 *
 * Placement is `.fpanel__art` in globals.css, because it has to change at `md`.
 */
function PanelArt({
    feature,
    wide,
    floor,
    visible,
}: {
    feature: Feature;
    wide: boolean;
    floor: boolean;
    visible: boolean;
}) {
    const image = feature.image;
    // Art for some features has not been produced yet; a referenced file that is
    // missing falls back to the generic device mockup instead of a broken image.
    const [failed, setFailed] = useState(false);
    if (!image) return null;

    const fallbackSrc = feature.visual === 'mobile' ? '/images/mobile.png' : '/images/desktop.png';
    const srcSets = featureImageSrcSets(image);

    return (
        <div
            // Geometry lives in .fpanel__art / --wide so it can be breakpoint-aware;
            // only the reveal, which is per-element state, stays inline.
            className={clsx(
                'fpanel__art',
                wide && 'fpanel__art--wide',
                wide && floor && 'fpanel__art--floor',
            )}
            style={{
                opacity: visible ? 1 : 0,
                transform: visible ? 'translate3d(0,0,0)' : 'translate3d(0,20px,0)',
                transition:
                    'opacity 1150ms cubic-bezier(0.16,1,0.3,1) 140ms, transform 1250ms cubic-bezier(0.16,1,0.3,1) 140ms',
            }}
        >
            {failed ? (
                <img
                    src={fallbackSrc}
                    alt={feature.title}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                />
            ) : (
                <picture>
                    <source type="image/webp" srcSet={srcSets.webp} />
                    <img
                        src={image.src}
                        srcSet={srcSets.png}
                        alt={feature.title}
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        onError={() => setFailed(true)}
                    />
                </picture>
            )}
        </div>
    );
}
