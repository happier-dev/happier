import * as React from 'react';

import { SessionView } from '@/components/sessions/shell/SessionView';
import { DEMO_RICH_SESSION_ID } from '@/demoMode/world/buildDemoWorld';

/**
 * The real session cockpit, composed for the stage. It lives in its own module
 * so `StageAppShell` (sidebar + split composition) can be imported WITHOUT
 * pulling `SessionView`'s import graph: beats whose subject is the session list
 * paint their sidebar first and stream this in behind a nested boundary, while
 * beats whose subject is the session itself load both before they resolve.
 */
export type StageSessionDetailProps = Readonly<{
    sessionId?: string;
}>;

export function StageSessionDetail(props: StageSessionDetailProps): React.ReactElement {
    return (
        <SessionView
            id={props.sessionId ?? DEMO_RICH_SESSION_ID}
            surfaceFocusedOverride
            surfaceVisibleOverride
            routeAnchorOverride
            safeAreaTopMode="external"
            headerSafeAreaTopMode="external"
            chatBottomSpacing="none"
        />
    );
}
