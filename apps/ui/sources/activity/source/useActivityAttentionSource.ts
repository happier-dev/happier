import { useSessionAudienceContext } from '@/hooks/teams/useSessionAudienceContext';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { buildSessionListHomeObservations } from '@/sync/domains/session/listing/sessionListHomeObservation';
import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import {
    getActiveServerSnapshot,
    getServerProfilesGeneration,
    listServerProfiles,
    subscribeActiveServer,
    subscribeServerProfiles,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { createActivityAttentionStoreSourceSelector } from './createActivityAttentionStoreSourceSelector';
import { useActivityPersonalSessionMembership } from './activityPersonalSessionMembership';

function useActivityAttentionStoreSource(includeSessionMessages: boolean): ActivityAttentionSource {
    const personalMembership = useActivityPersonalSessionMembership();
    const storeSourceSelector = React.useMemo(
        () => createActivityAttentionStoreSourceSelector(
            personalMembership.membershipByServerId,
            { includeSessionMessages },
        ),
        [includeSessionMessages, personalMembership.membershipByServerId],
    );
    const activeServer = React.useSyncExternalStore(
        React.useCallback((listener) => {
            return subscribeActiveServer(() => listener());
        }, []),
        getActiveServerSnapshot,
        getActiveServerSnapshot,
    );
    const storeSource = storage(storeSourceSelector);
    return React.useMemo(() => ({
        ...storeSource,
        activeServer,
        activeServerId: activeServer.serverId,
        personalSessionListMembershipByServerId: personalMembership.membershipByServerId,
        personalSessionListQueryStatesByServerId: personalMembership.statesByServerId,
        personalSessionListCoverageComplete: personalMembership.coverageComplete,
        sessionListHomeObservationByServerId: buildSessionListHomeObservations({
            concurrentSessionListCacheByServerId: storeSource.concurrentSessionListCacheByServerId,
            queryStatesByServerId: personalMembership.statesByServerId,
        }),
    }), [activeServer, personalMembership, storeSource]);
}

/** Summary surfaces never subscribe to or scan detailed transcript messages. */
export function useActivityAttentionSummarySource(): ActivityAttentionSource {
    return useActivityAttentionStoreSource(false);
}

export function useActivityAttentionSource(): ActivityAttentionSource {
    const summarySource = useActivityAttentionStoreSource(true);
    const serverProfilesGeneration = React.useSyncExternalStore(
        subscribeServerProfiles,
        getServerProfilesGeneration,
        getServerProfilesGeneration,
    );
    const serverProfilesById = React.useMemo(() => {
        const profileEntries = listServerProfiles().flatMap((profile) => [
            [profile.id, profile] as const,
            [resolveServerProfileScopeId(profile), profile] as const,
        ]);
        return Object.fromEntries(profileEntries);
    }, [serverProfilesGeneration]);

    const audienceAddresses = React.useMemo(() => [
        ...Object.values(summarySource.sessionsById).flatMap((session) => {
            const address = normalizeSessionAddress(session.serverId, session.id);
            return address ? [address] : [];
        }),
        ...Object.entries(summarySource.ordinarySessionListMembershipByServerId ?? {})
        .flatMap(([serverId, ids]) => (ids ?? []).flatMap((id) => {
            const address = normalizeSessionAddress(serverId, id);
            return address ? [address] : [];
        })),
        ...Object.entries(summarySource.personalSessionListMembershipByServerId ?? {})
        .flatMap(([serverId, ids]) => (ids ?? []).flatMap((id) => {
            const address = normalizeSessionAddress(serverId, id);
            return address ? [address] : [];
        })),
    ], [
        summarySource.ordinarySessionListMembershipByServerId,
        summarySource.personalSessionListMembershipByServerId,
        summarySource.sessionsById,
    ]);
    const audience = useSessionAudienceContext(audienceAddresses);
    return React.useMemo(() => ({
        ...summarySource,
        audienceScopes: audience.scopes,
        audienceLabelsVersion: audience.labelsVersion,
        serverProfilesById,
    }), [audience.labelsVersion, audience.scopes, serverProfilesById, summarySource]);
}
