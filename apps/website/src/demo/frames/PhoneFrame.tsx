import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { PhoneDynamicIsland } from './PhoneDynamicIsland';
import type { DemoState } from '../timeline/scenarioTypes';

type Props = {
    children: ReactNode;
    /** 'active' | 'inactive' | 'equal' — drives the focus treatment. */
    focus: 'active' | 'inactive' | 'equal';
    /** Tilt side — which direction the phone leans when inactive. */
    tiltSide?: 'left' | 'right';
    /** When present, the Dynamic Island morphs to display the notification. */
    notification?: DemoState['phoneNotification'];
    className?: string;
};

/**
 * iPhone frame. Body scale/opacity/blur/rotate are scripted by `focus` so
 * both devices can swap attention smoothly. Every transition specifies exact
 * properties (never `transition: all`).
 *
 * Scale vocabulary:
 *   active   → 1.00   (foreground, full attention)
 *   equal    → 1.00   (devices share focus during sync moment)
 *   inactive → 0.94   (defocused, tilted away, softened)
 *
 * The Dynamic Island doubles as the notification surface — when a beat
 * supplies a `phoneNotification`, the island morphs into the notification's
 * compact-pill or expanded-card shape.
 */
export function PhoneFrame({
    children,
    focus,
    tiltSide = 'right',
    notification,
    className,
}: Props) {
    const scale = focus === 'active' ? 1 : focus === 'equal' ? 1 : 0.94;
    const opacity = focus === 'active' ? 1 : focus === 'equal' ? 1 : 0.8;
    const rotateY = focus === 'active' ? 0 : focus === 'equal' ? -2 : tiltSide === 'left' ? 5 : -5;
    const blur = focus === 'inactive' ? 1.2 : 0;

    return (
        <motion.div
            className={cn('relative mx-auto', className)}
            style={{ perspective: 1600, transformStyle: 'preserve-3d' }}
            animate={{
                scale,
                opacity,
                rotateY,
                filter: `blur(${blur}px)`,
            }}
            transition={{ type: 'spring', duration: 0.45, bounce: 0 }}
        >
            <div
                className={cn(
                    'relative',
                    'rounded-[56px]',
                    'bg-[#0b0b0f]',
                    'p-[6px]',
                    focus === 'active'
                        ? 'shadow-device-active'
                        : 'shadow-device-inactive',
                )}
                style={{
                    width: 296,
                    height: 600,
                }}
            >
                {/* outer rim highlight */}
                <div
                    aria-hidden
                    className="absolute inset-0 rounded-[56px] pointer-events-none"
                    style={{
                        background:
                            'linear-gradient(180deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02) 20%, transparent 40%)',
                    }}
                />
                {/* screen — background = app canvas so content renders against the real theme bg */}
                <div
                    className="relative overflow-hidden rounded-[48px]"
                    style={{ width: 284, height: 588, background: 'var(--bg)' }}
                >
                    {/* Dynamic Island — only morphs for notification beats.
                        For static beats we rely on the iOS chrome that's
                        baked into the simulator-captured screenshots. */}
                    {notification ? (
                        <PhoneDynamicIsland notification={notification} />
                    ) : null}
                    {children}
                </div>
            </div>
        </motion.div>
    );
}
