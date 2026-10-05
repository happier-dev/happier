import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

type MediaChangeEvent = Readonly<{ matches: boolean }>;
type TransparencyMediaQuery = Readonly<{
    matches: boolean;
    addEventListener?: (event: 'change', listener: (event: MediaChangeEvent) => void) => void;
    removeEventListener?: (event: 'change', listener: (event: MediaChangeEvent) => void) => void;
    addListener?: (listener: (event: MediaChangeEvent) => void) => void;
    removeListener?: (listener: (event: MediaChangeEvent) => void) => void;
}>;

/**
 * Tracks the OS "Reduce Transparency" accessibility setting. When enabled the
 * user has asked the system to avoid translucency, so chrome that would otherwise
 * use Liquid Glass / blur must fall back to an opaque surface.
 *
 * Returns `false` on platforms that do not expose the setting.
 */
export function useReduceTransparency(): boolean {
    const [reduceTransparency, setReduceTransparency] = React.useState(false);

    React.useEffect(() => {
        let mounted = true;

        if (Platform.OS === 'web') {
            // react-native-web does not expose Reduce Transparency through AccessibilityInfo.
            const maybeWindow = (globalThis as {
                window?: { matchMedia?: (query: string) => TransparencyMediaQuery };
            }).window;
            if (typeof maybeWindow?.matchMedia !== 'function') return;

            let query: TransparencyMediaQuery;
            try {
                query = maybeWindow.matchMedia('(prefers-reduced-transparency: reduce)');
            } catch {
                // An unavailable preference is not a request to reduce transparency.
                return;
            }
            setReduceTransparency(query.matches === true);
            const onChange = (event: MediaChangeEvent) => {
                if (mounted) setReduceTransparency(event.matches === true);
            };
            if (typeof query.addEventListener === 'function') {
                query.addEventListener('change', onChange);
                return () => {
                    mounted = false;
                    query.removeEventListener?.('change', onChange);
                };
            }
            query.addListener?.(onChange);
            return () => {
                mounted = false;
                query.removeListener?.(onChange);
            };
        }

        AccessibilityInfo.isReduceTransparencyEnabled?.()
            .then((enabled) => {
                if (mounted) {
                    setReduceTransparency(enabled === true);
                }
            })
            .catch(() => {
                // Setting is unavailable on this platform; keep the safe default.
            });

        const subscription = AccessibilityInfo.addEventListener(
            'reduceTransparencyChanged',
            (enabled) => setReduceTransparency(enabled === true),
        );

        return () => {
            mounted = false;
            subscription?.remove?.();
        };
    }, []);

    return reduceTransparency;
}
