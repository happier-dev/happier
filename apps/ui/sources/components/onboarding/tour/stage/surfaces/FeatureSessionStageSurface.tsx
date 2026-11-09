import * as React from 'react';

import { DEMO_SESSION_MESSAGES_SESSION_ID, DEMO_SUBAGENTS_SESSION_ID } from '@/demoMode/world/featureSessions';

import type { StageDevice } from '../DeviceFrame';
import { StageAppShell } from '../StageAppShell';
import { StageSessionDetail } from '../StageSessionDetail';

function FeatureSession(props: Readonly<{ device: StageDevice; sessionId: string }>): React.ReactElement {
    return <StageAppShell device={props.device} surface="session-view"
        detail={<StageSessionDetail sessionId={props.sessionId} />} />;
}

export function DelegatedWorkStageSurface(props: Readonly<{ device: StageDevice }>): React.ReactElement {
    return <FeatureSession device={props.device} sessionId={DEMO_SUBAGENTS_SESSION_ID} />;
}

export function SessionHandoffStageSurface(props: Readonly<{ device: StageDevice }>): React.ReactElement {
    return <FeatureSession device={props.device} sessionId={DEMO_SESSION_MESSAGES_SESSION_ID} />;
}
