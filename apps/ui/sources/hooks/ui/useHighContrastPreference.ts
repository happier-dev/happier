import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

export function useHighContrastPreference(): boolean {
    const [highContrast, setHighContrast] = React.useState(false);

    React.useEffect(() => {
        let disposed = false;
        const maybeWindow = (globalThis as typeof globalThis & {
            window?: {
                matchMedia?: (query: string) => {
                    matches: boolean;
                    addEventListener?: (eventName: 'change', handler: (event: { matches: boolean }) => void) => void;
                    removeEventListener?: (eventName: 'change', handler: (event: { matches: boolean }) => void) => void;
                    addListener?: (handler: (event: { matches: boolean }) => void) => void;
                    removeListener?: (handler: (event: { matches: boolean }) => void) => void;
                };
            };
        }).window;
        if (Platform.OS === 'web' && typeof maybeWindow?.matchMedia === 'function') {
            const query = maybeWindow.matchMedia('(prefers-contrast: more)');
            setHighContrast(Boolean(query.matches));
            const onChange = (event: { matches: boolean }) => {
                if (!disposed) {
                    setHighContrast(Boolean(event.matches));
                }
            };
            if (typeof query.addEventListener === 'function') {
                query.addEventListener('change', onChange);
                return () => {
                    disposed = true;
                    query.removeEventListener?.('change', onChange);
                };
            }
            query.addListener?.(onChange);
            return () => {
                disposed = true;
                query.removeListener?.(onChange);
            };
        }

        const maybeApi = AccessibilityInfo as unknown as {
            isHighTextContrastEnabled?: () => Promise<boolean>;
            isDarkerSystemColorsEnabled?: () => Promise<boolean>;
            addEventListener?: (
                eventName: 'highTextContrastChanged' | 'darkerSystemColorsChanged',
                handler: (enabled: boolean) => void,
            ) => { remove?: () => void };
        };
        const queryPreference = Platform.OS === 'ios'
            ? maybeApi.isDarkerSystemColorsEnabled
            : maybeApi.isHighTextContrastEnabled;
        const eventName = Platform.OS === 'ios'
            ? 'darkerSystemColorsChanged'
            : 'highTextContrastChanged';

        if (typeof queryPreference === 'function') {
            void queryPreference.call(maybeApi).then((enabled) => {
                if (!disposed) {
                    setHighContrast(Boolean(enabled));
                }
            }).catch(() => {});
        }
        const subscription = typeof maybeApi.addEventListener === 'function'
            ? maybeApi.addEventListener(eventName, (enabled) => {
                if (!disposed) {
                    setHighContrast(Boolean(enabled));
                }
            })
            : null;

        return () => {
            disposed = true;
            subscription?.remove?.();
        };
    }, []);

    return highContrast;
}
