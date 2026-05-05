import { AnimatePresence, motion } from 'framer-motion';
import type { DemoState } from '../timeline/scenarioTypes';

type Notification = NonNullable<DemoState['phoneNotification']>;

type Props = {
    notification?: Notification | null;
};

/**
 * iPhone Dynamic Island — used as the notification surface.
 *
 * Three states, morphing in place:
 *   - idle:     compact pill (110 × 34)
 *   - arriving: wider pill with compact title (~240 × 38)
 *   - opened:   expanded card with avatar / title / body / action
 *               (~270 × 102, rounded 22)
 *
 * Motion: a single `motion.div` animates width, height, and borderRadius via
 * spring (bounce: 0). Inner content cross-fades through AnimatePresence keyed
 * on the phase. This is the on-device behavior viewers know from real iOS,
 * which makes the demo read as "the phone got a notification" without any
 * label or arrow needed.
 */
export function PhoneDynamicIsland({ notification }: Props) {
    const phase = notification?.phase ?? 'idle';
    const isOpened = phase === 'opened';
    const isArriving = phase === 'arriving';
    const hasContent = isOpened || isArriving;

    // Tightened from 270×102 / 244×38 — the phone screen is 284px wide,
    // so 244 wide felt like the island was eating the whole header. The
    // values below mirror real iOS proportions on a 393px-wide screen.
    const width = isOpened ? 232 : isArriving ? 200 : 110;
    const height = isOpened ? 82 : isArriving ? 34 : 34;
    const radius = isOpened ? 20 : 999;

    return (
        <motion.div
            className="absolute left-1/2 z-30 -translate-x-1/2 overflow-hidden"
            style={{
                top: 14,
                background: '#000',
                boxShadow: hasContent
                    ? '0 8px 24px rgba(0, 0, 0, 0.4), 0 0 0 0.5px rgba(255, 255, 255, 0.08) inset'
                    : 'none',
            }}
            animate={{ width, height, borderRadius: radius }}
            transition={{ type: 'spring', duration: 0.5, bounce: 0 }}
            aria-live={hasContent ? 'polite' : 'off'}
            aria-label={hasContent ? `${notification?.title}. ${notification?.body}` : undefined}
        >
            <AnimatePresence mode="wait">
                {isArriving ? (
                    <motion.div
                        key="arriving"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                        className="flex h-full items-center justify-between gap-2 pl-3 pr-2.5"
                    >
                        <div className="flex min-w-0 items-center gap-2">
                            <span
                                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ background: 'var(--accent-orange)' }}
                            />
                            <span className="truncate text-[11.5px] font-semibold text-white">
                                {notification?.title}
                            </span>
                        </div>
                    </motion.div>
                ) : isOpened ? (
                    <motion.div
                        key="opened"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{
                            duration: 0.28,
                            delay: 0.06,
                            ease: [0.2, 0, 0, 1],
                        }}
                        className="flex h-full gap-2 px-2.5 py-2"
                    >
                        {/* App icon — small Happier mark */}
                        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-[14px] bg-white text-[10px] font-black text-black">
                            H
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col justify-center">
                            <div className="truncate text-[11.5px] font-semibold leading-tight text-white">
                                {notification?.title}
                            </div>
                            <div className="line-clamp-1 text-[10px] leading-[1.25] text-white/65">
                                {notification?.body}
                            </div>
                        </div>
                        {notification?.actionLabel ? (
                            <div className="flex shrink-0 items-center">
                                <span className="rounded-full bg-white/12 px-2 py-0.5 text-[9.5px] font-semibold text-white">
                                    {notification.actionLabel}
                                </span>
                            </div>
                        ) : null}
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </motion.div>
    );
}
