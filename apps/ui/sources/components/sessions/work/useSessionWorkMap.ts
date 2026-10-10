import * as React from 'react';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { useSessionWorkOpeners } from './useSessionWorkOpeners';
import { projectSessionWorkMap } from './workMapProducer';
import type { WorkProjection } from './workProjection';

/** The map and its openers consume the same Work facts as the containing list or open pane. */
export function useSessionWorkMap(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    scopeId: string;
    session: Session | null | undefined;
    projection: WorkProjection | null;
    subagents: readonly SessionSubagent[];
    /** A list-only Work tab keeps its openers without building unseen map nodes. */
    active?: boolean;
}>) {
    const leadTitle = params.session ? getSessionName(params.session, params.serverId) : '';
    const leadAgentId = params.session ? readSessionPresentationAgentId(params.session) : null;
    const { sessionId, projection, active = true } = params;
    const openers = useSessionWorkOpeners(params);
    const map = React.useMemo(() => active && projection
        ? projectSessionWorkMap({ leadSessionId: sessionId, leadTitle, leadAgentId, projection })
        : null, [active, leadAgentId, leadTitle, projection, sessionId]);
    return { map, ...openers };
}
