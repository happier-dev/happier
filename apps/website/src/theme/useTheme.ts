import { useEffect, useRef, useState } from 'react';

import { applyThemeWithTransition } from './themeTransition';

export type ThemeChoice = 'dark' | 'light';

const STORAGE_KEY = 'happier-website-theme';

/**
 * Resolve the initial theme once, before React renders, to avoid a light→dark
 * flash on first paint.
 *
 * Resolution order:
 *   1. localStorage (explicit user choice — wins)
 *   2. prefers-color-scheme (system preference)
 *   3. dark (our default — it's a dev tool)
 */
export function resolveInitialTheme(): ThemeChoice {
    if (typeof document === 'undefined') return 'dark';
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'dark' || stored === 'light') return stored;
    } catch {
        // private mode / blocked storage — fall through
    }
    const prefersLight =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
}

/**
 * Apply the theme to the document before first paint. Call this in main.tsx
 * BEFORE createRoot.render so the first frame is already in the right theme.
 */
export function installInitialThemeAttribute(): void {
    if (typeof document === 'undefined') return;
    const theme = resolveInitialTheme();
    document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme(): {
    theme: ThemeChoice;
    toggle: () => void;
    setTheme: (next: ThemeChoice) => void;
} {
    const [theme, setThemeState] = useState<ThemeChoice>(() => resolveInitialTheme());
    const previousThemeRef = useRef<ThemeChoice>(theme);

    useEffect(() => {
        void applyThemeWithTransition({
            currentTheme: previousThemeRef.current,
            nextTheme: theme,
            reduceMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        });
        previousThemeRef.current = theme;
        try {
            localStorage.setItem(STORAGE_KEY, theme);
        } catch {
            // ignore — user preference still applies for this session
        }
    }, [theme]);

    return {
        theme,
        setTheme: setThemeState,
        toggle: () => setThemeState(t => (t === 'dark' ? 'light' : 'dark')),
    };
}
