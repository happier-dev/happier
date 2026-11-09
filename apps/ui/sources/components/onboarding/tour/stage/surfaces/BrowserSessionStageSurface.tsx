import * as React from 'react';

import { DEMO_BROWSER_CONTEXT_SESSION_ID } from '@/demoMode/world/featureSessions';

import type { StageDevice } from '../DeviceFrame';
import { StageAppShell } from '../StageAppShell';
import { StageSessionDetail } from '../StageSessionDetail';
import { BrowserSessionContextSeed } from './BrowserSessionContextSeed';
import { BrowserSessionStageActivity } from './BrowserSessionStageActivity';

/** The complete real Session cockpit; the accessory seeds its own mounted context runtime. */
export function BrowserSessionStageSurface(props: Readonly<{ device: StageDevice }>): React.ReactElement {
    return <>
        <BrowserSessionStageActivity />
        <StageAppShell device={props.device} surface="session-view" detail={
            <StageSessionDetail sessionId={DEMO_BROWSER_CONTEXT_SESSION_ID} headerAccessory={<BrowserSessionContextSeed />} />
        } />
    </>;
}
