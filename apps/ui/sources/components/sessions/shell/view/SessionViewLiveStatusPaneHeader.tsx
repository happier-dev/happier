import * as React from 'react';

import { useSessionRuntimeStatusSource } from '@/components/sessions/shell/useSessionRuntimeStatusSource';
import { SessionPaneHeader, type SessionPaneHeaderProps } from './SessionPaneHeader';
import { resolveSessionViewHeaderLiveStatus, type SessionViewHeaderLiveStatusSource } from './resolveSessionViewHeaderProps';

/**
 * The Session view's header: its bot face, activity and connection follow the live runtime source, so a
 * turn's thinking/status writes redraw this header and not the Session view that builds the rest of it.
 */
export const SessionViewLiveStatusPaneHeader = React.memo(function SessionViewLiveStatusPaneHeader(
    props: SessionPaneHeaderProps & Readonly<{ liveStatusSource?: SessionViewHeaderLiveStatusSource }>,
) {
    const { liveStatusSource, ...headerProps } = props;
    const runtimeSession = useSessionRuntimeStatusSource(liveStatusSource?.session ?? null);
    const managedWakeProjection = liveStatusSource?.managedWakeProjection;
    const liveStatus = React.useMemo(
        () => runtimeSession ? resolveSessionViewHeaderLiveStatus(runtimeSession, managedWakeProjection) : null,
        [managedWakeProjection, runtimeSession],
    );
    if (!liveStatus) return <SessionPaneHeader {...headerProps} />;
    return (
        <SessionPaneHeader
            {...headerProps}
            botFace={liveStatus.botFace}
            botActivity={liveStatus.botActivity}
            isConnected={liveStatus.isConnected}
        />
    );
});
