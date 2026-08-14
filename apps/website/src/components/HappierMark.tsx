import { useTheme } from './ThemeContext';
import { Picture } from './Picture';
import { useSiteData } from '../i18n/siteData';

/**
 * Real Happier wordmark. Both PNG variants live in the DOM and we cross-fade
 * their opacities on theme change — gives a smooth day/night transition
 * instead of a harsh swap.
 */
export function HappierMark({ className }: { className?: string }) {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { theme } = useTheme();
    const isDark = theme === 'dark';
    return (
        <a
            href="/"
            className={`relative inline-block h-7 md:h-8 ${className ?? ''}`}
            aria-label={PAGE_PROSE.happierMark.p0}
        >
            {/* Light (white) logo — visible on dark theme. Block so it sets the wrapper width via aspect. */}
            <Picture
                id="logotypeLight"
                alt={PAGE_PROSE.happierMark.p1}
                className="block h-full"
                imgClassName="block h-full w-auto"
                draggable={false}
                style={{ opacity: isDark ? 1 : 0, transition: 'opacity 700ms ease' }}
            />
            {/* Dark (black) logo — visible on light theme. Absolute overlay, same dims. */}
            <Picture
                id="logotypeDark"
                alt=""
                aria-hidden
                className="absolute left-0 top-0 h-full"
                imgClassName="h-full w-auto"
                draggable={false}
                style={{ opacity: isDark ? 0 : 1, transition: 'opacity 700ms ease' }}
            />
        </a>
    );
}
