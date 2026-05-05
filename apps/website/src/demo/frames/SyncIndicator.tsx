import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import type { SyncDirection } from '../timeline/scenarioTypes';

type Props = {
    /**
     * Changes when a sync event fires in the timeline — triggers an extra
     * bright pulse on top of the baseline heartbeat.
     */
    pulseKey: number;
    /**
     * Direction the signal travels when the pulse fires.
     * Forward = left → right (terminal asking phone)
     * Back    = right → left (phone answering back)
     */
    direction?: SyncDirection;
};

/**
 * Two dots joined by a line, with a permanent slow heartbeat and an
 * impulse pulse when `pulseKey` increments. The persistent heartbeat
 * tells the viewer "these devices are linked" before anything happens;
 * the impulse pulse says "something just synced", and its direction
 * shows who asked whom.
 */
export function SyncIndicator({ pulseKey, direction = 'forward' }: Props) {
    const [flash, setFlash] = useState(0);

    useEffect(() => {
        setFlash(f => f + 1);
    }, [pulseKey]);

    const isBack = direction === 'back';

    return (
        <div
            className="flex items-center gap-3 text-[11px] font-medium tnum"
            style={{ color: 'var(--fg-tertiary)' }}
        >
            <Dot />
            <motion.div
                key={flash}
                initial={{ opacity: 0.3 }}
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 0.5, ease: [0.2, 0, 0, 1] }}
                className="relative h-px w-24"
                style={{ background: 'var(--border-strong)' }}
            >
                <motion.span
                    key={`flash-${flash}-${direction}`}
                    initial={{ x: isBack ? 90 : -10, opacity: 0 }}
                    animate={{ x: isBack ? -10 : 90, opacity: [0, 1, 0] }}
                    transition={{ duration: 0.6, ease: [0.2, 0, 0, 1] }}
                    className="absolute top-1/2 h-[3px] w-[14px] -translate-y-1/2 rounded-full"
                    style={{
                        background: 'var(--accent-green)',
                        boxShadow: '0 0 10px color-mix(in srgb, var(--accent-green) 75%, transparent)',
                    }}
                />
            </motion.div>
            <Dot />
            <span
                className="ml-2 uppercase tracking-[0.14em]"
                style={{ color: 'var(--fg-tertiary)' }}
            >
                synced
            </span>
        </div>
    );
}

function Dot() {
    return (
        <span className="relative inline-flex h-2 w-2">
            <span
                className="absolute inset-0 animate-pulse-sync rounded-full"
                style={{ background: 'color-mix(in srgb, var(--accent-green) 60%, transparent)' }}
            />
            <span
                className="relative inline-block h-2 w-2 rounded-full"
                style={{ background: 'var(--accent-green)' }}
            />
        </span>
    );
}
