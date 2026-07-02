import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import * as safeAreaContext from 'react-native-safe-area-context';
import type { EdgeInsets } from 'react-native-safe-area-context';

import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';

type Edge = 'top' | 'bottom' | 'left' | 'right';

const CSS_SAFE_AREA_VAR_PREFIX = '--happier-safe-area-';
const UNKNOWN_VIEWPORT_KEY = 'unknown';

type CachedNativeSafeAreaInsets = Readonly<{
    insets: EdgeInsets;
    viewportKey: string;
}>;

let cachedNativeSafeAreaInsets: CachedNativeSafeAreaInsets | null = null;

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
        const probeStyle = probe.style;
        probeStyle.position = 'absolute';
        probeStyle.visibility = 'hidden';
        probeStyle.pointerEvents = 'none';
        probeStyle.paddingTop = `var(${CSS_SAFE_AREA_VAR_PREFIX}top)`;
        probeStyle.paddingBottom = `var(${CSS_SAFE_AREA_VAR_PREFIX}bottom)`;
        probeStyle.paddingLeft = `var(${CSS_SAFE_AREA_VAR_PREFIX}left)`;
        probeStyle.paddingRight = `var(${CSS_SAFE_AREA_VAR_PREFIX}right)`;

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

function hasAnyPositiveInset(insets: EdgeInsets): boolean {
    return insets.top > 0 || insets.bottom > 0 || insets.left > 0 || insets.right > 0;
}

function createViewportKey(width: number, height: number): string {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return UNKNOWN_VIEWPORT_KEY;
    }

    return `${Math.round(width)}x${Math.round(height)}`;
}

function resolveNativeSafeAreaInsets(
    primary: EdgeInsets,
    fallback: EdgeInsets,
    viewportKey: string,
): EdgeInsets {
    const merged = mergeSafeAreaInsets(primary, fallback);
    if (hasAnyPositiveInset(merged)) {
        cachedNativeSafeAreaInsets = { insets: merged, viewportKey };
        return merged;
    }

    if (cachedNativeSafeAreaInsets?.viewportKey === viewportKey) {
        return mergeSafeAreaInsets(merged, cachedNativeSafeAreaInsets.insets);
    }

    return merged;
}

export function useChromeSafeAreaInsets(): EdgeInsets {
    const isDesktopOverlayWindow = isDesktopActivityOverlayWindowContext();
    const dimensions = useWindowDimensions();
    const insets = safeAreaContext.useSafeAreaInsets();
    const nativeFallback = React.useMemo<EdgeInsets>(() => {
        if (Platform.OS === 'web') {
            return { top: 0, bottom: 0, left: 0, right: 0 };
        }
        const moduleShape = safeAreaContext as unknown as {
            initialWindowMetrics?: unknown;
            default?: { initialWindowMetrics?: unknown };
        };
        const initialWindowMetrics = (() => {
            try {
                const direct = moduleShape.initialWindowMetrics;
                if (direct != null) return direct;
            } catch {
                // ignore
            }
            try {
                const fallback = moduleShape.default?.initialWindowMetrics;
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
        Platform.OS === 'web' && !isDesktopOverlayWindow
            ? readWebSafeAreaInsetsFromCss()
            : { top: 0, bottom: 0, left: 0, right: 0 }
    ));

    React.useEffect(() => {
        if (Platform.OS !== 'web' || isDesktopOverlayWindow) return;
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
    }, [isDesktopOverlayWindow]);

    if (isDesktopOverlayWindow) {
        return { top: 0, bottom: 0, left: 0, right: 0 };
    }

    if (Platform.OS !== 'web') {
        return resolveNativeSafeAreaInsets(
            insets,
            nativeFallback,
            createViewportKey(dimensions.width, dimensions.height),
        );
    }

    return mergeSafeAreaInsets(insets, webFallback);
}
