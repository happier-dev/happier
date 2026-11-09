import * as React from 'react';

import { useSessionBrowserContextRuntimeContext } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { buildDemoBrowserWorld } from '@/demoMode/world/browser';

/** Seeds only the stage's mounted Session browser-context owner. */
export function BrowserSessionContextSeed(): React.ReactElement | null {
    const runtime = useSessionBrowserContextRuntimeContext();
    const [world] = React.useState(buildDemoBrowserWorld);
    const onStateChange = runtime?.browserShellContext.onStateChange;
    const onAttachPageReferenceChange = runtime?.browserShellContext.onAttachPageReferenceChange;
    React.useEffect(() => {
        if (!onStateChange || !onAttachPageReferenceChange) return;
        let mounted = true;
        // The Session resets its context in a mount effect. Seed after that
        // boundary, once for this stage lifetime, so removal stays removed.
        void Promise.resolve().then(() => {
            if (!mounted) return;
            onStateChange(world.contextState);
            onAttachPageReferenceChange(() => onStateChange(world.contextState));
        });
        return () => {
            mounted = false;
            onAttachPageReferenceChange(null);
        };
    }, [onAttachPageReferenceChange, onStateChange, world]);
    return null;
}
