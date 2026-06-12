import { useEffect, useRef, useState } from 'react';
import { MobileThemePreview } from './heroShowcase/MobileThemePreview';

const DESKTOP_SRC = '/images/demo/screenshots/desktop.png';

/**
 * Product showcase that lives below the hero. Desktop and mobile sit beside
 * each other on large screens and stack on narrow screens.
 */
export function HeroShowcase() {
    const ref = useRef<HTMLDivElement | null>(null);
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
            { threshold: 0.18, rootMargin: '0px 0px -12% 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    return (
        <div
            ref={ref}
            className="relative mx-auto w-full max-w-[1440px] px-4 pb-10 pt-0 sm:px-6 md:px-10 md:pb-16 md:pt-0"
        >
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

            <div className="relative flex flex-col items-center gap-6 md:grid md:grid-cols-[minmax(0,1fr)_315px] md:center md:gap-5 lg:grid-cols-[minmax(0,1040px)_300px] lg:gap-5">
                <div
                    className="relative z-[1] w-full max-w-[1080px] overflow-visible"
                    style={{
                        opacity: visible ? 1 : 0,
                        transform: visible ? 'translateY(0)' : 'translateY(36px)',
                        transition:
                            'opacity 900ms cubic-bezier(0.16,1,0.3,1), transform 900ms cubic-bezier(0.16,1,0.3,1)',
                    }}
                >
                    <div className="relative w-[135%] max-w-none -translate-x-[4%] overflow-visible md:-translate-x-[7%]">
                        <img
                            src={DESKTOP_SRC}
                            alt="Happier desktop app"
                            className="block w-full max-w-none select-none"
                            draggable={false}
                            style={{
                                filter:
                                    'drop-shadow(0 48px 90px rgba(0, 0, 0, 0.32)) drop-shadow(0 10px 28px rgba(0, 0, 0, 0.22))',
                            }}
                        />
                    </div>
                </div>

                <div
                    className="relative z-[2] w-[48%] min-w-[190px] max-w-[270px] md:flex md:w-full md:min-w-0 md:max-w-none md:items-start md:justify-center"
                    style={{
                        opacity: visible ? 1 : 0,
                        transform: visible ? 'translateY(0)' : 'translateY(48px)',
                        transition:
                            'opacity 900ms cubic-bezier(0.16,1,0.3,1) 180ms, transform 900ms cubic-bezier(0.16,1,0.3,1) 180ms',
                    }}
                >
                    <MobileThemePreview />
                </div>
            </div>
        </div>
    );
}
