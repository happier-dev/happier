import * as React from 'react';

import { SessionView } from '@/components/sessions/shell/SessionViewHost';
import { DEMO_RICH_SESSION_ID } from '@/demoMode/world/buildDemoWorld';
import { StagePhoneCaptureContext } from './StagePhoneCaptureContext';

/**
 * The real session cockpit, composed for the stage. It lives in its own module
 * so `StageAppShell` (sidebar + split composition) can be imported WITHOUT
 * pulling `SessionView`'s import graph: beats whose subject is the session list
 * paint their sidebar first and stream this in behind a nested boundary, while
 * beats whose subject is the session itself load both before they resolve.
 */
export type StageSessionDetailProps = Readonly<{
    sessionId?: string;
    headerAccessory?: React.ReactNode;
}>;

export function StageSessionDetail(props: StageSessionDetailProps): React.ReactElement {
    const phoneCapture = React.useContext(StagePhoneCaptureContext);
    return (
        <SessionView
            id={props.sessionId ?? DEMO_RICH_SESSION_ID}
            headerAccessory={props.headerAccessory}
            surfaceFocusedOverride
            surfaceVisibleOverride
            routeAnchorOverride
            safeAreaTopMode={phoneCapture ? undefined : 'external'}
            headerSafeAreaTopMode={phoneCapture ? undefined : 'external'}
            chatBottomSpacing={phoneCapture ? undefined : 'none'}
        />
    );
}
