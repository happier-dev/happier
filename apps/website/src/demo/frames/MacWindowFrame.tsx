import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

type Props = {
    children: ReactNode;
    focus: 'active' | 'inactive' | 'equal';
    tiltSide?: 'left' | 'right';
    title?: string;
    className?: string;
};

/**
 * macOS window frame. Used for the terminal and the web/desktop views.
 * Same focus vocabulary as PhoneFrame so the two devices move as a pair.
 */
export function MacWindowFrame({
    children,
    focus,
    tiltSide = 'left',
    title,
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
                    focus === 'active'
                        ? 'shadow-device-active'
                        : 'shadow-device-inactive',
                )}
                style={{ background: '#0d0d12', width: 540 }}
            >
                {/* title bar */}
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
                {children}
            </div>
        </motion.div>
    );
}
