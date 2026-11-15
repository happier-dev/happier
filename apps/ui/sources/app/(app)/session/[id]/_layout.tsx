import * as React from 'react';
import { Slot, useLocalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useExpoSceneMirrorsWorkspace } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useNavigationState, useRoute } from '@react-navigation/native';

import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionSelector } from '@/sync/domains/state/storage';
import { isVoiceTranscriptHistorySession } from '@/voice/persistence/voiceTranscriptHistorySession';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { useSessionRouteQualification } from '@/hooks/session/useSessionRouteQualification';
import { SessionViewerDestinationScope } from '@/components/sessions/viewer/SessionViewerDestinationScope';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';

type SessionLayoutParams = Record<string, string | string[] | undefined>;

/**
 * A route's query as strings only. Expo also hands a layout navigator values (a native deep link's nested
 * `params` object), which are not query and cannot be written back into a URL.
 */
function readStringRouteParams(params: Readonly<Record<string, unknown>> | undefined, into: SessionLayoutParams = {}): SessionLayoutParams {
    for (const [key, value] of Object.entries(params ?? {})) {
        if (typeof value === 'string' || (Array.isArray(value) && value.every(part => typeof part === 'string'))) {
            into[key] = value;
        }
    }
    return into;
}

function useSessionLayoutParams() {
    const layoutParams = readStringRouteParams(useLocalSearchParams());
    const hosted = useDestinationInstanceKey() !== null;
    // The retained destination already supplies its leaf's exact params. Expo's
    // outer branch describes another mounted route and must not lend its Home.
    if (hosted) return layoutParams;
    // eslint-disable-next-line react-hooks/rules-of-hooks -- only Expo layouts have a native route branch.
    const route = useRoute();
    // Expo puts a cold leaf's query on the child state, not its ancestor layout.
    // Read only this layout's branch: a retained sibling must never lend its Home.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- only Expo layouts have a native route branch.
    const childNavigationState = useNavigationState((state) => state.routes.find((candidate) => candidate.key === route.key)?.state);
    const childParams: SessionLayoutParams = {};
    let childState = childNavigationState;
    while (childState?.routes.length) {
        const child = childState.routes[childState.index ?? childState.routes.length - 1];
        readStringRouteParams(child.params as Readonly<Record<string, unknown>> | undefined, childParams);
        childState = child.state;
    }
    return { ...layoutParams, ...childParams, serverId: readSessionRouteServerId(childParams) ?? layoutParams.serverId };
}

export default function OrdinarySessionRouteLayout() {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSessionLayoutParams();
    const mirrorsWorkspace = useExpoSceneMirrorsWorkspace();
    const { id, ...routeQuery } = params;
    // A workspace-hosted Session is qualified by its destination host (HostedSessionRouteQualification);
    // this layout qualifies only the Expo-owned (native/unhosted) route.
    const hosted = useDestinationInstanceKey() !== null;
    const { sessionId, explicitServerId, resolvedServerId, candidateServerIds, qualifiedHref } = useSessionRouteQualification({
        params, query: routeQuery, pathname, enabled: !mirrorsWorkspace && !hosted,
    });
    const promotedServerId = explicitServerId === null ? resolvedServerId : null;
    React.useEffect(() => {
        if (qualifiedHref) {
            // The destination navigation owner must update the retained leaf,
            // too. Expo layout setParams alone leaves that leaf unqualified.
            router.replace(qualifiedHref);
        }
    }, [qualifiedHref, router]);
    // Select the one carrier fact: the whole record changes on every streamed turn write.
    const isVoiceTranscriptHistory = useSessionSelector(sessionId, undefined, (session) => isVoiceTranscriptHistorySession(
        session && (!explicitServerId || session.serverId === explicitServerId)
            ? { active: session.active, metadata: readSessionOwnerMetadataView(session) }
            : null,
    ));

    // The workspace's destination host owns this Session's Home, viewer and Board execution. Under
    // Expo's hidden URL mirror its leaves draw only navigation metadata, and its params may still name the
    // previous Session of the same route pattern; a scope or fallback here would be a second owner.
    if (mirrorsWorkspace) return <Slot />;

    // The nested route reconstructs its hydration scope from route params. Do not
    // mount it while the sole authoritative legacy candidate is still unqualified.
    if (promotedServerId) {
        return null;
    }

    // Keep the children unmounted: an ambiguous legacy link must not start route hydration.
    if (candidateServerIds.length > 1) {
        return <SessionInvalidLinkFallback sessionId={sessionId} candidateServerIds={candidateServerIds} />;
    }

    // With neither Session membership nor a sole saved Home, the person chooses
    // the exact Home. Focus is never a tie-breaker among several Homes.
    if (explicitServerId === null && candidateServerIds.length === 0) {
        return <SessionInvalidLinkFallback sessionId={sessionId} homeChoice="unknown" />;
    }

    if (isVoiceTranscriptHistory) {
        return <SessionInvalidLinkFallback />;
    }

    const viewerAddress = normalizeSessionAddress(explicitServerId ?? resolvedServerId, sessionId);
    return viewerAddress ? <SessionViewerDestinationScope key={sessionAddressKey(viewerAddress)}
        sessionId={viewerAddress.sessionId} serverId={viewerAddress.serverId}>
        <Slot />
    </SessionViewerDestinationScope> : <Slot />;
}
