import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

export function useReducedMotionPreference(): boolean {
    const [reducedMotion, setReducedMotion] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;

        const maybeWindow: any = (globalThis as any).window;
        if (Platform.OS === 'web' && maybeWindow?.matchMedia) {
            const query = maybeWindow.matchMedia('(prefers-reduced-motion: reduce)');
            setReducedMotion(Boolean(query.matches));
            const onChange = (event: any) => {
                if (cancelled) return;
                setReducedMotion(Boolean(event?.matches));
            };
            if (typeof query.addEventListener === 'function') {
                query.addEventListener('change', onChange);
                return () => {
                    cancelled = true;
                    query.removeEventListener?.('change', onChange);
                };
            }
            if (typeof query.addListener === 'function') {
                query.addListener(onChange);
                return () => {
                    cancelled = true;
                    query.removeListener?.(onChange);
                };
            }
            return () => {
                cancelled = true;
            };
        }

        const maybeApi: any = AccessibilityInfo as any;
        if (typeof maybeApi?.isReduceMotionEnabled === 'function') {
            void maybeApi.isReduceMotionEnabled().then((enabled: boolean) => {
                if (cancelled) return;
                setReducedMotion(Boolean(enabled));
            });
        }

        const subscription =
            typeof maybeApi?.addEventListener === 'function'
                ? maybeApi.addEventListener('reduceMotionChanged', (enabled: boolean) => {
                    if (cancelled) return;
                    setReducedMotion(Boolean(enabled));
                })
                : null;

        return () => {
            cancelled = true;
            subscription?.remove?.();
        };
    }, []);

    return reducedMotion;
}
