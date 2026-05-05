import { AnimatePresence, motion } from 'framer-motion';
import { useTheme } from '@/theme/useTheme';

/**
 * Small sun/moon toggle.
 *
 * Motion spec follows the make-interfaces-feel-better icon-swap recipe:
 *     initial:  scale 0.25, opacity 0, blur 4px
 *     animate:  scale 1.00, opacity 1, blur 0
 *     exit:     scale 0.25, opacity 0, blur 4px
 *     spring:   { type: 'spring', duration: 0.3, bounce: 0 }
 *
 * `initial={false}` on AnimatePresence prevents the enter animation from
 * firing on first page load — only on subsequent toggles.
 *
 * Hit area is 40×40px minimum via `h-10 w-10`; the icon itself is smaller
 * for visual weight.
 */
export function ThemeToggle() {
    const { theme, toggle } = useTheme();
    const isDark = theme === 'dark';

    return (
        <button
            type="button"
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggle}
            className="press relative flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--border-subtle)] text-[color:var(--fg-secondary)] transition-colors hover:text-[color:var(--fg-primary)]"
        >
            <AnimatePresence initial={false} mode="popLayout">
                {isDark ? (
                    <motion.svg
                        key="moon"
                        initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                        exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                        transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                        width="16"
                        height="16"
                        viewBox="0 0 20 20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                    >
                        <path d="M16.5 11.5a6.5 6.5 0 1 1-8-8 5.5 5.5 0 0 0 8 8Z" />
                    </motion.svg>
                ) : (
                    <motion.svg
                        key="sun"
                        initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                        exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                        transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                        width="16"
                        height="16"
                        viewBox="0 0 20 20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                    >
                        <circle cx="10" cy="10" r="3.2" />
                        <path d="M10 2v1.5M10 16.5V18M3.6 3.6l1.1 1.1M15.3 15.3l1.1 1.1M2 10h1.5M16.5 10H18M3.6 16.4l1.1-1.1M15.3 4.7l1.1-1.1" />
                    </motion.svg>
                )}
            </AnimatePresence>
        </button>
    );
}
