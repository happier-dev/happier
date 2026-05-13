import { useEffect, useRef, useState } from 'react';
import { ProviderScatter } from './ProviderScatter';

/**
 * Right-hand "stage" of the hero — phone + desktop screenshots floating over the
 * planet, with provider logos scattered around them.
 */
export function HeroStage() {
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
            { threshold: 0.05 },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    return (
        <div ref={ref} className="relative h-full w-full">
            <ProviderScatter />

            {/* Desktop screenshot — sits as the back/main canvas. */}
            <img
                src="/images/desktop.png"
                alt="Happier desktop app"
                className="absolute z-[2]"
                style={{
                    left: '-10%',
                    top: '26%',
                    width: '96%',
                    transform: `translateY(${visible ? '0' : '40px'}) rotate(-1.5deg)`,
                    opacity: visible ? 1 : 0,
                    transition:
                        'opacity 900ms ease 200ms, transform 1200ms cubic-bezier(0.16,1,0.3,1) 200ms',
                    filter:
                        'drop-shadow(0 40px 60px rgba(0, 0, 0, 0.55)) drop-shadow(0 8px 20px rgba(0, 0, 0, 0.4))',
                }}
                draggable={false}
            />

            {/* Mobile screenshot — front, overlapping desktop on the right. */}
            <img
                src="/images/mobile.png"
                alt="Happier mobile app"
                className="absolute z-[3]"
                style={{
                    right: '14%',
                    top: '8%',
                    height: '92%',
                    transform: `translateY(${visible ? '0' : '60px'}) rotate(4deg)`,
                    opacity: visible ? 1 : 0,
                    transition:
                        'opacity 900ms ease 380ms, transform 1200ms cubic-bezier(0.16,1,0.3,1) 380ms',
                    filter:
                        'drop-shadow(0 50px 80px rgba(0, 0, 0, 0.65)) drop-shadow(0 10px 24px rgba(0, 0, 0, 0.45))',
                }}
                draggable={false}
            />
        </div>
    );
}
