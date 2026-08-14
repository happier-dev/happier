import { useEffect, useRef, useState, useCallback } from 'react';
import { MobileThemePreview } from './heroShowcase/MobileThemePreview';
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
 *   2. Phone in a 4:5 window whose screenshot translates on scroll (parallax
 *      reveal), driven imperatively so scrolling never re-renders React.
 */
export function HeroShowcase() {
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
                        alt="Happier desktop app"
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
                <PhoneParallax visible={visible} />
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
                aria-label="Happier desktop app screenshot — scroll to explore"
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
                    alt="Happier desktop app — scroll horizontally to explore"
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
 * Phone screenshot in a fixed 4:5 window. As the page scrolls, the inner
 * screenshot translates upward to reveal its lower half (parallax). The
 * transform is written imperatively inside a rAF — no React re-render and no
 * CSS transition chasing the scroll value — so it stays smooth on mobile.
 */
function PhoneParallax({ visible }: { visible: boolean }) {
    const windowRef = useRef<HTMLDivElement | null>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const frame = useRef(0);

    const update = useCallback(() => {
        frame.current = 0;
        const win = windowRef.current;
        const img = imgRef.current;
        // Inert on lg+ where this lives inside a `lg:hidden` (display:none)
        // wrapper: offsetParent is null, so we skip the layout reads entirely
        // and never pay forced-reflow cost on the (common) desktop viewport.
        if (!win || !img || win.offsetParent === null) return;

        const rect = win.getBoundingClientRect();
        const viewportH = window.innerHeight || 1;
        // 0 when the window's top is at the bottom of the viewport, 1 when it
        // has scrolled fully past the top.
        const range = viewportH + rect.height;
        const progress = Math.max(0, Math.min(1, (viewportH - rect.top) / range));

        const overflow = Math.max(0, img.offsetHeight - win.offsetHeight);
        const ty = -(overflow * progress);
        img.style.transform = `translate3d(0, ${ty.toFixed(1)}px, 0)`;
    }, []);

    const onScroll = useCallback(() => {
        if (frame.current) return;
        frame.current = window.requestAnimationFrame(update);
    }, [update]);

    useEffect(() => {
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll, { passive: true });
        update();
        return () => {
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
            if (frame.current) window.cancelAnimationFrame(frame.current);
        };
    }, [onScroll, update]);

    return (
        <div
            className="mx-auto w-full max-w-[460px] px-4"
            data-reveal
            style={{
                opacity: visible ? 1 : 0,
                transform: visible ? 'translateY(0)' : 'translateY(48px)',
                transition: 'opacity 900ms cubic-bezier(0.16,1,0.3,1) 180ms, transform 900ms cubic-bezier(0.16,1,0.3,1) 180ms',
            }}
        >
            <div
                ref={windowRef}
                className="relative overflow-hidden rounded-[30px] ring-1 ring-white/10"
                style={{
                    aspectRatio: '6 / 5',
                    boxShadow: '0 44px 90px rgba(0,0,0,0.5), 0 10px 26px rgba(0,0,0,0.32)',
                }}
            >
                <Picture
                    id="showcaseMobile"
                    imgRef={imgRef}
                    alt="Happier mobile app"
                    onLoad={onScroll}
                    className="block w-full"
                    imgClassName="w-full select-none"
                    draggable={false}
                    style={{ willChange: 'transform' }}
                />
                {/* Soft top/bottom fades so the crop reads as a window, not a cut. */}
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-8"
                    style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.28), transparent)' }}
                />
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-10"
                    style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.34), transparent)' }}
                />
            </div>
        </div>
    );
}
