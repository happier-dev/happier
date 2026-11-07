import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useActiveRetainedSessionListQueryStates } from '@/components/sessions/shell/sessionListPaneRetention';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRoutePathActive } from '@/sync/domains/session/sessionSurfaceVisibility';
import { storage } from '@/sync/domains/state/storage';
import { buildScopedSessionRouteHref, createSessionRouteServerScope, readSessionRouteServerId } from './sessionRouteServerScope';

type SessionRouteParams = Readonly<Record<string, string | string[] | undefined>>;

export type SessionRouteQualification = Readonly<{
    sessionId: string;
    explicitServerId: string | null;
    resolvedServerId: string | null;
    candidateServerIds: readonly string[];
    /** The Home-qualified href for this route, while it is current and a sole Home is known. */
    qualifiedHref: ReturnType<typeof buildScopedSessionRouteHref> | null;
}>;

/**
 * The one decision for a Session route's Home: an explicit `serverId`, else the sole Home known to hold
 * the Session. Focus never breaks a tie. `query` is the route's remaining query (path params excluded).
 */
export function useSessionRouteQualification(input: Readonly<{
    params: SessionRouteParams;
    query: SessionRouteParams;
    pathname: string;
    enabled: boolean;
}>): SessionRouteQualification {
    const sessionId = normalizeSessionId(input.params.id);
    const queryStates = useActiveRetainedSessionListQueryStates();
    const profilesGeneration = useServerProfilesGeneration();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the profile publication is the list's identity.
    const homeServerIds = React.useMemo(() => listServerProfiles().map(resolveServerProfileScopeId), [profilesGeneration]);
    const [resolvedServerId, ...candidateServerIds] = storage(useShallow((state) => {
        const scope = createSessionRouteServerScope(input.params, state, { queryStates, homeServerIds });
        return [scope.serverId, ...scope.candidateAddresses.map((address) => address.serverId)] as const;
    }));
    const explicitServerId = readSessionRouteServerId(input.params);
    const promotedServerId = explicitServerId === null ? resolvedServerId : null;
    // A retained Session's params outlive its route. Only qualify the route that is current.
    const qualifiedHref = input.enabled && promotedServerId && isSessionRoutePathActive(input.pathname, sessionId)
        ? buildScopedSessionRouteHref({
            sessionId,
            serverId: promotedServerId,
            suffix: input.pathname.slice(`/session/${encodeURIComponent(sessionId)}`.length),
            query: input.query,
        }) : null;
    return { sessionId, explicitServerId, resolvedServerId, candidateServerIds, qualifiedHref };
}
