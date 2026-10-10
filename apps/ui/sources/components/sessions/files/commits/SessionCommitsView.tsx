import * as React from 'react';

import { ScmCommitsView, type ScmCommitsViewProps } from './ScmCommitsView';
import { useSessionCommitPlan } from './useSessionCommitPlan';

export type SessionCommitsViewProps = Omit<ScmCommitsViewProps, 'plan'> & Readonly<{
    sessionId: string;
    serverId?: string | null;
    /** Hands the person to the authorized Session composer. */
    onOpenComposer?: () => void;
}>;

/** Session authority and composer remain in the Session adapter; presentation is shared with Project. */
export const SessionCommitsView = React.memo(function SessionCommitsView(props: SessionCommitsViewProps) {
    const plan = useSessionCommitPlan({ sessionId: props.sessionId, serverId: props.serverId, enabled: props.active !== false,
        branch: props.branch, ...(props.onOpenComposer ? { onOpenComposer: props.onOpenComposer } : {}) });
    return <ScmCommitsView {...props} plan={plan} />;
});
