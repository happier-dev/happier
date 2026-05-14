import { type CSSProperties, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ProviderScatter } from './ProviderScatter';

/**
 * Right-hand "stage" of the hero — phone + desktop screenshots floating over the
 * planet, with provider logos scattered around them.
 *
 * The screenshots are clickable: tapping either one toggles the *previewed*
 * app theme between dark and light, revealing the new screenshot via a
 * top-to-bottom clip-path animation. Both screenshots animate together so
 * the swap reads as one unified theme switch — the same 600ms
 * cubic-bezier(0.4, 0, 0.2, 1) curtain reveal the real app uses when the
 * user changes their theme preference in settings.
 */

type DeviceTheme = 'dark' | 'light';

const SCREENSHOT_SRC: Record<'desktop' | 'mobile', Record<DeviceTheme, string>> = {
    desktop: {
        dark: '/images/desktop.png',
        light: '/images/demo/screenshots/desktop_light.jpg',
    },
    mobile: {
        dark: '/images/mobile.png',
        light: '/images/demo/screenshots/mobile_light.jpg',
    },
};

const REVEAL_ANIMATION = 'theme-reveal-down 600ms cubic-bezier(0.4, 0, 0.2, 1) forwards';

export function HeroStage() {
    const ref = useRef<HTMLDivElement | null>(null);
    const [visible, setVisible] = useState(false);
    const [deviceTheme, setDeviceTheme] = useState<DeviceTheme>('dark');
    const [revealingTo, setRevealingTo] = useState<DeviceTheme | null>(null);

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
            { threshold: 0.05 },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    // Preload alternate-theme images so the first click reveals instantly
    // instead of waiting on the network.
    useEffect(() => {
        const preload = (src: string) => {
            const img = new window.Image();
            img.src = src;
        };
        Object.values(SCREENSHOT_SRC).forEach((variants) =>
            Object.values(variants).forEach(preload),
        );
    }, []);

    const handleClick = useCallback(() => {
        if (revealingTo) return; // Block re-entry during animation.
        setRevealingTo(deviceTheme === 'dark' ? 'light' : 'dark');
    }, [deviceTheme, revealingTo]);

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLImageElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleClick();
            }
        },
        [handleClick],
    );

    const handleRevealEnd = useCallback(() => {
        setRevealingTo((prev) => {
            if (prev) setDeviceTheme(prev);
            return null;
        });
    }, []);

    const nextThemeLabel = deviceTheme === 'dark' ? 'light' : 'dark';
    const ariaLabel = `Preview the ${nextThemeLabel} theme of the Happier app`;

    const desktopStyle: CSSProperties = {
        left: '-10%',
        top: '26%',
        width: '96%',
        transform: `translateY(${visible ? '0' : '40px'}) rotate(-1.5deg)`,
        opacity: visible ? 1 : 0,
        transition:
            'opacity 900ms cubic-bezier(0.16,1,0.3,1) 200ms, transform 900ms cubic-bezier(0.16,1,0.3,1) 200ms',
        filter:
            'drop-shadow(0 40px 60px rgba(0, 0, 0, 0.55)) drop-shadow(0 8px 20px rgba(0, 0, 0, 0.4))',
        willChange: 'transform, opacity',
    };

    const mobileStyle: CSSProperties = {
        right: '14%',
        top: '8%',
        height: '92%',
        transform: `translateY(${visible ? '0' : '60px'}) rotate(4deg)`,
        opacity: visible ? 1 : 0,
        transition:
            'opacity 900ms cubic-bezier(0.16,1,0.3,1) 380ms, transform 900ms cubic-bezier(0.16,1,0.3,1) 380ms',
        filter:
            'drop-shadow(0 50px 80px rgba(0, 0, 0, 0.65)) drop-shadow(0 10px 24px rgba(0, 0, 0, 0.45))',
        willChange: 'transform, opacity',
    };

    return (
        <div ref={ref} className="relative h-full w-full">
            <ProviderScatter />

            {/* Desktop screenshot — base layer + (optional) revealing overlay. */}
            <img
                src={SCREENSHOT_SRC.desktop[deviceTheme]}
                alt="Happier desktop app"
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                role="button"
                tabIndex={0}
                aria-label={ariaLabel}
                draggable={false}
                className="absolute z-[2] cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--card-border)] focus-visible:ring-offset-4 focus-visible:ring-offset-transparent"
                style={desktopStyle}
            />
            {revealingTo && (
                <img
                    key={`desktop-${revealingTo}`}
                    src={SCREENSHOT_SRC.desktop[revealingTo]}
                    alt=""
                    aria-hidden
                    onAnimationEnd={handleRevealEnd}
                    draggable={false}
                    className="pointer-events-none absolute z-[2] select-none"
                    style={{ ...desktopStyle, animation: REVEAL_ANIMATION }}
                />
            )}

            {/* Mobile screenshot — same pattern. */}
            <img
                src={SCREENSHOT_SRC.mobile[deviceTheme]}
                alt="Happier mobile app"
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                role="button"
                tabIndex={0}
                aria-label={ariaLabel}
                draggable={false}
                className="absolute z-[3] cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--card-border)] focus-visible:ring-offset-4 focus-visible:ring-offset-transparent"
                style={mobileStyle}
            />
            {revealingTo && (
                <img
                    key={`mobile-${revealingTo}`}
                    src={SCREENSHOT_SRC.mobile[revealingTo]}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className="pointer-events-none absolute z-[3] select-none"
                    style={{ ...mobileStyle, animation: REVEAL_ANIMATION }}
                />
            )}
        </div>
    );
}
