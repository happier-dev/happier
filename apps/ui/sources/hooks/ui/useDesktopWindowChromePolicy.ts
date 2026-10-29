import * as React from 'react';
import {
    getDesktopWindowChromePolicy,
    subscribeDesktopWindowChromePolicy,
    type DesktopWindowChromePolicy,
} from '@/utils/platform/desktopWindowBridge';

/** Observes the native owner; this is a projection, never a persisted UI preference. */
export function useDesktopWindowChromePolicy(enabled = true): DesktopWindowChromePolicy {
    const [policy, setPolicy] = React.useState<DesktopWindowChromePolicy>({ strategy: 'none' });
    React.useEffect(() => {
        if (!enabled) return;
        let active = true;
        let changed = false;
        const unsubscribe = subscribeDesktopWindowChromePolicy((next) => {
            changed = true;
            setPolicy(next);
        });
        void getDesktopWindowChromePolicy().then((initial) => {
            // A slow initial read cannot replace a newer user-initiated change.
            if (active && !changed) setPolicy(initial);
        });
        return () => { active = false; unsubscribe(); };
    }, [enabled]);
    return policy;
}
