import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { copy } from '@/theme/copy';
import { DemoLoader } from '@/demo/DemoLoader';

export function Hero() {
    const ref = useRef<HTMLDivElement>(null);

    // Cursor-reactive glow: updates CSS vars --mx/--my on pointer move.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const onMove = (e: PointerEvent) => {
            const rect = el.getBoundingClientRect();
            el.style.setProperty('--mx', `${e.clientX - rect.left}px`);
            el.style.setProperty('--my', `${e.clientY - rect.top}px`);
        };
        el.addEventListener('pointermove', onMove);
        return () => el.removeEventListener('pointermove', onMove);
    }, []);

    const [line1, line2] = copy.hero.headline.split('\n');

    return (
        <section
            ref={ref}
            id="top"
            className="hero-glow relative isolate overflow-hidden px-6 pb-24 pt-28 sm:pt-36"
        >
            <div className="mx-auto max-w-[1180px] text-center">
                <motion.span
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: [0.2, 0, 0, 1] }}
                    className="text-[12px] font-medium tracking-[0.02em]"
                    style={{ color: 'var(--fg-tertiary)' }}
                >
                    {copy.hero.badge}
                </motion.span>

                <h1 className="mt-6 text-[56px] font-semibold leading-[0.95] tracking-[-0.02em] text-[color:var(--fg-primary)] sm:text-[80px] md:text-[96px]">
                    <motion.span
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.55, ease: [0.2, 0, 0, 1] }}
                        className="block"
                    >
                        {line1}
                    </motion.span>
                    <motion.span
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.55, ease: [0.2, 0, 0, 1], delay: 0.08 }}
                        className="block bg-gradient-to-b from-[color:var(--fg-primary)] to-[color:var(--fg-primary-soft)] bg-clip-text text-transparent"
                    >
                        {line2}
                    </motion.span>
                </h1>

                <motion.p
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.55, ease: [0.2, 0, 0, 1], delay: 0.16 }}
                    className="mx-auto mt-6 max-w-[620px] text-[17px] leading-[1.55] text-[color:var(--fg-secondary)]"
                >
                    {copy.hero.sub}
                </motion.p>

                <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: [0.2, 0, 0, 1], delay: 0.24 }}
                    className="mt-8 flex flex-wrap items-center justify-center gap-3"
                >
                    <a
                        href="#get-started"
                        className="press inline-flex items-center gap-2 rounded-full bg-[color:var(--fg-primary)] px-5 py-2.5 text-[14px] font-semibold text-[color:var(--page-bg)] hover:brightness-95"
                    >
                        {copy.hero.primaryCta}
                    </a>
                    <a
                        href="https://github.com/happier-dev"
                        className="press inline-flex items-center gap-2 rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-5 py-2.5 text-[14px] font-semibold text-[color:var(--fg-primary)] hover:bg-[color:var(--bg-elevated)]"
                    >
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            aria-hidden
                        >
                            <path d="M12 .5C5.65.5.5 5.65.5 12a11.49 11.49 0 0 0 7.85 10.92c.57.1.78-.25.78-.55v-2.07c-3.2.7-3.87-1.36-3.87-1.36-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.04 1.77 2.72 1.26 3.39.96.1-.75.4-1.26.74-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.3 1.2-3.1-.12-.3-.52-1.48.11-3.08 0 0 .98-.31 3.2 1.18a11.1 11.1 0 0 1 5.83 0c2.22-1.49 3.2-1.18 3.2-1.18.63 1.6.23 2.78.11 3.08.75.8 1.2 1.84 1.2 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.05.78 2.12v3.14c0 .3.2.65.79.54A11.49 11.49 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
                        </svg>
                        {copy.hero.secondaryCta}
                    </a>
                </motion.div>
            </div>

            {/* Device stage — visual twin renders instantly; real demo bundle lazy-loads on intersection */}
            <motion.div
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, ease: [0.2, 0, 0, 1], delay: 0.36 }}
                className="relative z-10 mt-16 sm:mt-20"
            >
                <DemoLoader />
            </motion.div>
        </section>
    );
}
