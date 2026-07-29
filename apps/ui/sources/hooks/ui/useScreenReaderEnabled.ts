import * as React from 'react';
import { AccessibilityInfo } from 'react-native';

export function useScreenReaderEnabled(): boolean {
    const [screenReaderEnabled, setScreenReaderEnabled] = React.useState(false);

    React.useEffect(() => {
        let disposed = false;
        const maybeApi = AccessibilityInfo as unknown as {
            isScreenReaderEnabled?: () => Promise<boolean>;
            addEventListener?: (
                eventName: 'screenReaderChanged',
                handler: (enabled: boolean) => void,
            ) => { remove?: () => void };
        };

        if (typeof maybeApi.isScreenReaderEnabled === 'function') {
            void maybeApi.isScreenReaderEnabled().then((enabled) => {
                if (!disposed) {
                    setScreenReaderEnabled(Boolean(enabled));
                }
            }).catch(() => {});
        }

        const subscription = typeof maybeApi.addEventListener === 'function'
            ? maybeApi.addEventListener('screenReaderChanged', (enabled) => {
                if (!disposed) {
                    setScreenReaderEnabled(Boolean(enabled));
                }
            })
            : null;

        return () => {
            disposed = true;
            subscription?.remove?.();
        };
    }, []);

    return screenReaderEnabled;
}
