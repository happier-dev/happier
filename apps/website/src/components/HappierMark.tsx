import { useTheme } from './ThemeContext';

/**
 * Real Happier wordmark. The asset naming reflects the LOGO'S color, not the
 * intended background — so on a dark site we render the LIGHT (white) logo,
 * and on a light site we render the DARK (black) logo.
 */
export function HappierMark({ className }: { className?: string }) {
    const { theme } = useTheme();
    const src = theme === 'dark' ? '/images/logotype-light.png' : '/images/logotype-dark.png';
    return (
        <a href="/" className={`inline-flex items-center ${className ?? ''}`} aria-label="Happier home">
            <img src={src} alt="happier" className="h-7 w-auto md:h-8" draggable={false} />
        </a>
    );
}
