import * as React from 'react';

import { BrowserSurfaceHost } from '@/components/browser/surfaces/BrowserSurfaceHost';
import { buildDemoBrowserWorld, DEMO_BROWSER_SESSION_ID } from '@/demoMode/world/browser';

/** The production Browser host and page-context controller, over a capture-served example page. */
export function BrowserStageSurface(): React.ReactElement {
    const world = React.useMemo(() => buildDemoBrowserWorld(), []);
    const [contextState, setContextState] = React.useState(world.contextState);
    const browserContext = React.useMemo(() => ({
        state: contextState,
        enabled: true,
        contextCapabilities: world.contextCapabilities,
        onStateChange: setContextState,
    }), [contextState, world]);
    return <BrowserSurfaceHost
        browserSessionId={DEMO_BROWSER_SESSION_ID}
        platform="web"
        initialBrowserState={world.state}
        policy={{ browserEnabled: true, viewTargetsEnabled: true, contextEnabled: true, diagnosticsEnabled: false }}
        browserContext={browserContext}
        allowExternalUrlBrowsing={false}
        testID="demo-stage-browser"
    />;
}
