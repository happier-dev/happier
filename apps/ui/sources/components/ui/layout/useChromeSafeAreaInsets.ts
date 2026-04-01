import * as React from 'react';
import { Platform } from 'react-native';
import * as safeAreaContext from 'react-native-safe-area-context';
import type { EdgeInsets } from 'react-native-safe-area-context';

type Edge = 'top' | 'bottom' | 'left' | 'right';

const CSS_SAFE_AREA_VAR_PREFIX = '--happier-safe-area-';

function parseCssPx(value: string): number {
    const raw = value.trim();
    if (!raw) return 0;
    const normalized = raw.endsWith('px') ? raw.slice(0, -2) : raw;
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function readWebSafeAreaInsetsFromCss(getComputedStyleFn: ((elt: Element) => CSSStyleDeclaration) | null = null): EdgeInsets {
    if (typeof document === 'undefined') {
        return { top: 0, bottom: 0, left: 0, right: 0 };
    }
    if (typeof getComputedStyleFn !== 'function') {
        if (typeof getComputedStyle !== 'function') {
            return { top: 0, bottom: 0, left: 0, right: 0 };
        }
        getComputedStyleFn = getComputedStyle;
    }

    const body = document.body;
    if (!body || typeof document.createElement !== 'function') {
        return { top: 0, bottom: 0, left: 0, right: 0 };
    }

    // NOTE:
    // CSS custom properties preserve the literal token value (e.g. `env(safe-area-inset-top)`), so reading
    // `getComputedStyle(...).getPropertyValue('--foo')` does not reliably give a computed px value.
    //
    // Instead, create a hidden probe element that references the custom properties in a real CSS property,
    // so `getComputedStyle(probe).paddingTop` returns a resolved px value on iOS Safari.
    const probe = document.createElement('div');
    try {
        (probe as any).style.position = 'absolute';
        (probe as any).style.visibility = 'hidden';
        (probe as any).style.pointerEvents = 'none';
        (probe as any).style.paddingTop = `var(${CSS_SAFE_AREA_VAR_PREFIX}top)`;
        (probe as any).style.paddingBottom = `var(${CSS_SAFE_AREA_VAR_PREFIX}bottom)`;
        (probe as any).style.paddingLeft = `var(${CSS_SAFE_AREA_VAR_PREFIX}left)`;
        (probe as any).style.paddingRight = `var(${CSS_SAFE_AREA_VAR_PREFIX}right)`;

        body.appendChild(probe);
        const styles = getComputedStyleFn(probe);
        return {
            top: parseCssPx(styles.paddingTop ?? ''),
            bottom: parseCssPx(styles.paddingBottom ?? ''),
            left: parseCssPx(styles.paddingLeft ?? ''),
            right: parseCssPx(styles.paddingRight ?? ''),
        };
    } catch {
        return { top: 0, bottom: 0, left: 0, right: 0 };
    } finally {
        try {
            body.removeChild(probe);
        } catch {
            // ignore
        }
    }
}

export function mergeSafeAreaInsets(primary: EdgeInsets, fallback: EdgeInsets): EdgeInsets {
    return {
        top: Math.max(primary.top, fallback.top),
        bottom: Math.max(primary.bottom, fallback.bottom),
        left: Math.max(primary.left, fallback.left),
        right: Math.max(primary.right, fallback.right),
    };
}

export function useChromeSafeAreaInsets(): EdgeInsets {
    const insets = safeAreaContext.useSafeAreaInsets();
    const nativeFallback = React.useMemo<EdgeInsets>(() => {
        if (Platform.OS === 'web') {
            return { top: 0, bottom: 0, left: 0, right: 0 };
        }
        const initialWindowMetrics = (() => {
            try {
                const direct = (safeAreaContext as any).initialWindowMetrics;
                if (direct != null) return direct;
            } catch {
                // ignore
            }
            try {
                const fallback = (safeAreaContext as any)?.default?.initialWindowMetrics;
                if (fallback != null) return fallback;
            } catch {
                // ignore
            }
            return null;
        })();
        const initial = (initialWindowMetrics as { insets?: EdgeInsets } | null)?.insets ?? null;
        if (!initial) {
            return { top: 0, bottom: 0, left: 0, right: 0 };
        }
        return {
            top: typeof initial.top === 'number' ? initial.top : 0,
            bottom: typeof initial.bottom === 'number' ? initial.bottom : 0,
            left: typeof initial.left === 'number' ? initial.left : 0,
            right: typeof initial.right === 'number' ? initial.right : 0,
        };
    }, []);
    const [webFallback, setWebFallback] = React.useState<EdgeInsets>(() => (
        Platform.OS === 'web' ? readWebSafeAreaInsetsFromCss() : { top: 0, bottom: 0, left: 0, right: 0 }
    ));

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const update = () => setWebFallback(readWebSafeAreaInsetsFromCss());
        update();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('resize', update);
            window.addEventListener('orientationchange', update);
            return () => {
                window.removeEventListener('resize', update);
                window.removeEventListener('orientationchange', update);
            };
        }
        return undefined;
    }, []);

    if (Platform.OS !== 'web') {
        return mergeSafeAreaInsets(insets, nativeFallback);
    }

    return mergeSafeAreaInsets(insets, webFallback);
}
