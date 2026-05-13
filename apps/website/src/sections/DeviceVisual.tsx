import { useEffect, useRef, useState } from 'react';

type DeviceVisualProps = {
    kind: 'mobile' | 'desktop' | 'mobileAndDesktop';
    accent: 'sun' | 'coral' | 'blue' | 'indigo';
    side: 'left' | 'right';
};

const ACCENT_COLORS: Record<DeviceVisualProps['accent'], string> = {
    sun: 'rgba(245, 181, 71, 0.55)',
    coral: 'rgba(231, 111, 74, 0.55)',
    blue: 'rgba(81, 135, 255, 0.55)',
    indigo: 'rgba(68, 88, 201, 0.55)',
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
 * Renders a device or pair of devices (mobile.png / desktop.png) floating over a soft
 * accent glow. Animated in-view with a gentle rise.
 */
export function DeviceVisual({ kind, accent, side }: DeviceVisualProps) {
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
            { threshold: 0.22, rootMargin: '0px 0px -15% 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    const glowColor = ACCENT_COLORS[accent];

    return (
        <div ref={ref} className="relative aspect-[5/4] w-full">
            <div
                aria-hidden
                className="absolute inset-0"
                style={{
                    background: `radial-gradient(60% 60% at ${side === 'left' ? '35%' : '65%'} 50%, ${glowColor} 0%, transparent 70%)`,
                    opacity: visible ? 1 : 0,
                    transform: visible ? 'scale(1)' : 'scale(0.92)',
                    transition: 'opacity 1100ms ease, transform 1200ms cubic-bezier(0.16,1,0.3,1)',
                    filter: 'blur(20px)',
                }}
            />

            {kind === 'mobile' && (
                <DeviceImg
                    src="/images/mobile.png"
                    alt="Happier on a phone"
                    visible={visible}
                    layout={{
                        position: { left: '50%', top: '50%' },
                        size: { height: '88%' },
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
                        size: { width: '94%' },
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
                            position: { left: '46%', top: '50%' },
                            size: { width: '86%' },
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
                            position: { right: '2%', top: '50%' },
                            size: { height: '82%' },
                            anchor: 'rightCenter',
                            rotate: 4,
                            delay: 260,
                        }}
                    />
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
                transition: `opacity 900ms ease ${delay}ms, transform 1200ms cubic-bezier(0.16,1,0.3,1) ${delay}ms`,
                filter:
                    'drop-shadow(0 60px 80px rgba(0, 0, 0, 0.55)) drop-shadow(0 8px 20px rgba(0, 0, 0, 0.35))',
                willChange: 'transform, opacity',
            }}
        />
    );
}
