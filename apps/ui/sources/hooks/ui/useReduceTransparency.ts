import * as React from 'react';
import { AccessibilityInfo } from 'react-native';

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
