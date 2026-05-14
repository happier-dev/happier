import { useTheme } from './ThemeContext';

/**
 * Real Happier wordmark. Both PNG variants live in the DOM and we cross-fade
 * their opacities on theme change — gives a smooth day/night transition
 * instead of a harsh swap.
 */
export function HappierMark({ className }: { className?: string }) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    return (
        <a
            href="/"
            className={`relative inline-block h-7 md:h-8 ${className ?? ''}`}
            aria-label="Happier home"
        >
            {/* Light (white) logo — visible on dark theme. Block so it sets the wrapper width via aspect. */}
            <img
                src="/images/logotype-light.png"
                alt="happier"
                className="block h-full w-auto"
                draggable={false}
                style={{ opacity: isDark ? 1 : 0, transition: 'opacity 700ms ease' }}
            />
            {/* Dark (black) logo — visible on light theme. Absolute overlay, same dims. */}
            <img
                src="/images/logotype-dark.png"
                alt=""
                aria-hidden
                className="absolute left-0 top-0 h-full w-auto"
                draggable={false}
                style={{ opacity: isDark ? 0 : 1, transition: 'opacity 700ms ease' }}
            />
        </a>
    );
}
