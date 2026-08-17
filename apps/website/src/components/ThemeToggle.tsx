import { useTheme } from './ThemeContext';
import { trackThemeToggled } from '../analytics/events';

export function ThemeToggle() {
    const { theme, toggle } = useTheme();
    const isDark = theme === 'dark';

    /**
     * `theme` is the state BEFORE the toggle, so the event carries where the
     * visitor is going, not where they were. A `theme_toggled { to: 'light' }`
     * rate is the only evidence this site has about whether the dark-by-default
     * decision (ThemeContext.readInitial never consults matchMedia) is costing
     * anyone anything.
     */
    const onToggle = () => {
        trackThemeToggled({ to: isDark ? 'light' : 'dark' });
        toggle();
    };

    return (
        <button
            onClick={onToggle}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border"
            style={{ borderColor: 'var(--card-border)', background: 'var(--card)' }}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
            {isDark ? (
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="10" cy="10" r="3.5" />
                    <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5l1.5 1.5M14 14l1.5 1.5M4.5 15.5l1.5-1.5M14 6l1.5-1.5" />
                </svg>
            ) : (
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
                    <path d="M14.2 11.8a6 6 0 1 1-6-9.6 6.7 6.7 0 0 0 6 9.6Z" />
                </svg>
            )}
        </button>
    );
}
