import { useEffect, useRef, useState } from 'react';
import { ProviderScatter } from './ProviderScatter';

/**
 * Right-hand hero stage. It now acts as a pure orbital provider cloud that
 * sits on top of the planet, leaving the product screenshots to the dedicated
 * showcase below the hero.
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
            { threshold: 0.1 },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    return (
        <div ref={ref} className="relative h-full w-full">
            <div
                aria-hidden
                className="absolute inset-[10%] rounded-full blur-3xl"
                style={{
                    background:
                        'radial-gradient(48% 42% at 50% 50%, rgba(255,255,255,0.12) 0%, rgba(245,181,71,0.16) 34%, rgba(73,100,224,0.16) 68%, transparent 100%)',
                    opacity: visible ? 1 : 0,
                    transform: visible ? 'scale(1)' : 'scale(0.9)',
                    transition: 'opacity 900ms cubic-bezier(0.16,1,0.3,1), transform 900ms cubic-bezier(0.16,1,0.3,1)',
                }}
            />
            <ProviderScatter visible={visible} />
        </div>
    );
}
