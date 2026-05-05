import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

type Props = {
    children: ReactNode;
    focus: 'active' | 'inactive' | 'equal';
    tiltSide?: 'left' | 'right';
    title?: string;
    /**
     * Frame size. "short" (default) ≈ 580×380 — sits comfortably next to the
     * 540-wide terminal and 296-wide phone in the cinematic stage. "tall" ≈
     * 620×460 — used when desktop is the sole hero of a beat.
     */
    height?: 'short' | 'tall';
    className?: string;
};

/**
 * Desktop (macOS app-window) frame. Sibling of MacWindowFrame (which is the
 * terminal frame). Same focus vocabulary so the whole stage moves as one
 * coordinated piece.
 *
 * Difference from MacWindowFrame:
 *   - Taller content area by default (for a desktop app UI).
 *   - Heavier title bar with a simulated sidebar stripe.
 *   - Meant to host the real apps/ui Desktop content (Direct Sessions
 *     browse, multi-pane transcript, parallel orchestration).
 */
export function DesktopFrame({
    children,
    focus,
    tiltSide = 'left',
    title,
    height = 'tall',
    className,
}: Props) {
    const scale = focus === 'active' ? 1 : focus === 'equal' ? 1 : 0.92;
    const opacity = focus === 'active' ? 1 : focus === 'equal' ? 1 : 0.72;
    const rotateY = focus === 'active' ? 0 : focus === 'equal' ? -1 : tiltSide === 'left' ? -2 : 2;
    const blur = focus === 'inactive' ? 1.5 : 0;
    const saturate = focus === 'inactive' ? 0.85 : 1;

    return (
        <motion.div
            className={cn('relative', className)}
            style={{ perspective: 1600, transformStyle: 'preserve-3d' }}
            animate={{
                scale,
                opacity,
                rotateY,
                filter: `blur(${blur}px) saturate(${saturate})`,
            }}
            transition={{ type: 'spring', duration: 0.45, bounce: 0 }}
        >
            <div
                className={cn(
                    'overflow-hidden rounded-token-xxl border border-white/[0.08]',
                    focus === 'active' ? 'shadow-device-active' : 'shadow-device-inactive',
                )}
                style={{ background: '#0d0d12', width: height === 'short' ? 580 : 620 }}
            >
                <div className="flex h-10 items-center gap-2 border-b border-white/[0.06] bg-[#121218] px-4">
                    <div className="flex gap-[6px]">
                        <span className="block h-3 w-3 rounded-full bg-[#ff5f57]" />
                        <span className="block h-3 w-3 rounded-full bg-[#febc2e]" />
                        <span className="block h-3 w-3 rounded-full bg-[#28c840]" />
                    </div>
                    <div className="flex-1 text-center text-[11px] font-medium tnum text-white/50">
                        {title ?? ''}
                    </div>
                    <span className="w-12" />
                </div>
                <div
                    className="relative overflow-hidden bg-[#0b0b0f]"
                    style={{ height: height === 'short' ? 340 : 420 }}
                >
                    {children}
                </div>
            </div>
        </motion.div>
    );
}
