import { useEffect, useRef, useState } from 'react';
import { MobileThemePreview } from './heroShowcase/MobileThemePreview';
import { PHONE_FRAME_ASPECT } from './heroShowcase/PhoneFrame';
import { Picture } from '../components/Picture';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';

/**
 * Product showcase below the hero.
 *
 * Tablet & desktop (sm+): the desktop screenshot spans the full content width
 *   (border-to-border with the page chrome) and the phone floats in front of
 *   its right side. The phone width is sized as a fraction of the stage (~24%,
 *   clamped) so it scales *with* the desktop and always fits within its height
 *   — the pair stays balanced from ~640px up to the 300px cap on wide screens.
 *   The composition holds down to ~640px; below that the desktop screenshot
 *   gets too small to read side-by-side, so we switch to the stacked treatment.
 *
 * Phones (< sm): stacked —
 *   1. Desktop in a height-capped, horizontally pannable window (so it can't
 *      tower over the page the way a natural-size screenshot would).
 *   2. The SAME phone as sm+ — one `PhoneFrame`, one theme switcher — sized by
 *      height so it sits at the desktop shot's visual weight.
 */
export function HeroShowcase() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const sectionRef = useRef<HTMLDivElement | null>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const node = sectionRef.current;
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
            { threshold: 0.12, rootMargin: '0px 0px -10% 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    return (
        <div
            ref={sectionRef}
            data-section="hero-showcase"
            className="section-y-end relative mx-auto w-full max-w-[1460px] px-0 pt-0 sm:px-10"
        >
            {/* Ambient glow (static — does not repaint on scroll) */}
            <div
                aria-hidden
                className="pointer-events-none absolute inset-x-[10%] top-[14%] h-[62%] rounded-full blur-3xl"
                style={{
                    background:
                        'radial-gradient(72% 110% at 52% 40%, rgba(245,181,71,0.26) 0%, rgba(214,94,67,0.12) 38%, rgba(44,78,194,0.18) 72%, transparent 100%)',
                    opacity: visible ? 1 : 0,
                    transform: visible ? 'scale(1)' : 'scale(0.94)',
                    transition: 'opacity 900ms cubic-bezier(0.16,1,0.3,1), transform 900ms cubic-bezier(0.16,1,0.3,1)',
                }}
            />

            {/* --- Tablet & desktop (sm+): full-bleed desktop with the phone in front --- */}
            <div className="relative hidden overflow-visible sm:block">
                {/* The desktop PNG carries ~3.45% transparent + baked-shadow
                    padding on each side. Shift the image left by that amount so
                    the actual app-window edge (not the image edge) lines up with
                    the page content, and clip the small left bleed. The shadow is
                    baked into the screenshot, so no CSS drop-shadow is added. */}
                <div className="relative z-[1] w-full" style={{ overflowX: 'clip' }}>
                    <Picture
                        id="showcaseDesktop"
                        alt={PAGE_PROSE.heroShowcase.p1}
                        className="block w-full"
                        imgClassName="w-full select-none"
                        draggable={false}
                        data-reveal
                        style={{
                            opacity: visible ? 1 : 0,
                            transform: visible
                                ? 'translateX(-3.45%) translateY(0)'
                                : 'translateX(-3.45%) translateY(36px)',
                            transition: 'opacity 900ms cubic-bezier(0.16,1,0.3,1), transform 900ms cubic-bezier(0.16,1,0.3,1)',
                        }}
                    />
                </div>

                {/* Phone floats in front of the desktop's right side, vertically
                    centered. clamp() keeps it proportional at every desktop width,
                    and it covers the small gap the left-shift leaves on the right. */}
                <div
                    className="absolute z-[2]"
                    style={{
                        right: '-0.5%',
                        top: '50%',
                        width: 'clamp(140px, 24%, 300px)',
                        transform: visible
                            ? 'translateY(-48%)'
                            : 'translateY(calc(-48% + 48px))',
                        opacity: visible ? 1 : 0,
                        transition: 'opacity 900ms cubic-bezier(0.16,1,0.3,1) 180ms, transform 900ms cubic-bezier(0.16,1,0.3,1) 180ms',
                    }}
                >
                    <MobileThemePreview />
                </div>
            </div>

            {/* --- Phones (< sm): stacked with scroll behaviors --- */}
            <div className="relative flex flex-col gap-10 sm:hidden">
                <DesktopScrollable visible={visible} />
                <PhoneShowcase visible={visible} />
            </div>
        </div>
    );
}

/**
 * Height-capped, horizontally pannable desktop screenshot for mobile. The
 * window height is clamped so the (very tall) natural screenshot can't dominate
 * the page; the image fills the height and overflows horizontally to pan.
 */
function DesktopScrollable({ visible }: { visible: boolean }) {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const scrollRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !visible) return;
        const timer = setTimeout(() => {
            el.scrollTo({ left: 48, behavior: 'smooth' });
        }, 600);
        return () => clearTimeout(timer);
    }, [visible]);

    return (
        <div
            className="px-4 sm:px-6"
            data-reveal
            style={{
                opacity: visible ? 1 : 0,
                transform: visible ? 'translateY(0)' : 'translateY(36px)',
                transition: 'opacity 900ms cubic-bezier(0.16,1,0.3,1), transform 900ms cubic-bezier(0.16,1,0.3,1)',
            }}
        >
            <div
                ref={scrollRef}
                tabIndex={0}
                role="region"
                aria-label={PAGE_PROSE.heroShowcase.p2}
                className="no-scrollbar overflow-x-auto rounded-2xl"
                style={{
                    WebkitOverflowScrolling: 'touch',
                    // Tall enough that the desktop UI stays readable; the image
                    // is then far wider than the viewport, so it pans (superset-
                    // style) rather than shrinking the whole app to fit.
                    height: 'clamp(380px, 62vh, 540px)',
                    boxShadow: '0 32px 60px rgba(0,0,0,0.28), 0 8px 20px rgba(0,0,0,0.18)',
                }}
            >
                <Picture
                    id="showcaseDesktop"
                    alt={PAGE_PROSE.heroShowcase.p3}
                    className="block h-full w-max max-w-none"
                    imgClassName="h-full w-auto max-w-none select-none"
                    sizes="auto 180vw"
                    draggable={false}
                />
            </div>
            <p className="mt-3 text-center text-[12px]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.heroShowcase.p0)}</p>
        </div>
    );
}

/**
 * The phone, on a phone.
 *
 * This used to be its own thing: `mobile.png` — a device mockup with a frame
 * baked into the pixels — cropped into a 6:5 window that panned on scroll. So
 * the site carried TWO phone frames for one product shot, and the one only
 * mobile visitors ever saw was the photographed one. Worse, a 6:5 window over a
 * 994x2160 device shot cuts the device roughly in half: the crop ran straight
 * through the phone, so what read as "a phone" on desktop read as a floating
 * rectangle of UI here. The scroll-pan existed to make that crop tolerable — it
 * was compensating for the wrong asset rather than showing anything.
 *
 * It is the same component as desktop now. The frame is drawn rather than
 * photographed, so it stays sharp at any width and matches the desktop shot
 * exactly; the screenshot inside sits at the screen's own aspect and is never
 * cropped; and mobile finally reaches the theme switcher, which it previously
 * had no way to see at all.
 *
 * Width is derived from HEIGHT, not from the column. A phone at full column
 * width would stand ~775px tall on a 390px viewport and shove everything below
 * it off the fold. Capping height near the desktop screenshot's own 62vh keeps
 * the two shots at the same visual weight, which is what makes the stack read
 * as a pair instead of as two unrelated pictures.
 */
function PhoneShowcase({ visible }: { visible: boolean }) {
    return (
        <div
            className="flex justify-center px-4"
            data-reveal
            style={{
                opacity: visible ? 1 : 0,
                transform: visible ? 'translateY(0)' : 'translateY(48px)',
                transition:
                    'opacity 900ms cubic-bezier(0.16,1,0.3,1) 180ms, transform 900ms cubic-bezier(0.16,1,0.3,1) 180ms',
            }}
        >
            <div style={{ width: `min(72vw, calc(64vh * ${PHONE_FRAME_ASPECT}))` }}>
                <MobileThemePreview />
            </div>
        </div>
    );
}
