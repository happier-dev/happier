import { useSessionAudienceContext } from '@/hooks/teams/useSessionAudienceContext';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { buildSessionListHomeObservations } from '@/sync/domains/session/listing/sessionListHomeObservation';
import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
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

/** Select at the subscription owner, before a changed source can render closed chrome. */
export function useActivityAttentionStoreSelector(
    includeSessionMessages: boolean,
    detailAddresses?: readonly SessionAddress[],
): (state: StorageState) => ActivityAttentionSource {
    const personalMembership = useActivityPersonalSessionMembership();
    const includeFollowRuleFacts = Object.values(personalMembership.followRulesByServerId ?? {}).some(snapshot =>
        snapshot.status === 'ready' && snapshot.rules.some(rule => rule.receiver.kind === 'account' && rule.definition.enabled));
    const storeSourceSelector = React.useMemo(
        () => createActivityAttentionStoreSourceSelector(
            personalMembership.membershipByServerId,
            { includeSessionMessages, detailAddresses, includeFollowRuleFacts,
                ruleMembershipByServerId: personalMembership.ruleSessionMembershipByServerId },
        ),
        [includeSessionMessages, detailAddresses, includeFollowRuleFacts, personalMembership.membershipByServerId,
            personalMembership.ruleSessionMembershipByServerId],
    );
    const activeServer = React.useSyncExternalStore(
        React.useCallback((listener) => {
            return subscribeActiveServer(() => listener());
        }, []),
        getActiveServerSnapshot,
        getActiveServerSnapshot,
    );
    return React.useMemo(() => {
        let previousSource: ReturnType<typeof storeSourceSelector> | undefined;
        let selected: ActivityAttentionSource | undefined;
        return (state: StorageState) => {
            const storeSource = storeSourceSelector(state);
            if (previousSource === storeSource && selected) return selected;
            previousSource = storeSource;
            selected = {
                ...storeSource,
                activeServer,
                activeServerId: activeServer.serverId,
                personalSessionListMembershipByServerId: personalMembership.membershipByServerId,
                ruleSessionMembershipByServerId: personalMembership.ruleSessionMembershipByServerId,
                personalSessionListQueryStatesByServerId: personalMembership.statesByServerId,
                personalSessionListCoverageComplete: personalMembership.coverageComplete,
                personalFollowRulesByServerId: personalMembership.followRulesByServerId,
                accountDeliveryMutesByServerId: personalMembership.accountDeliveryMutesByServerId,
                sessionListHomeObservationByServerId: buildSessionListHomeObservations({
                    concurrentSessionListCacheByServerId: storeSource.concurrentSessionListCacheByServerId,
                    queryStatesByServerId: personalMembership.statesByServerId,
                }),
            };
            return selected;
        };
    }, [activeServer, personalMembership, storeSourceSelector]);
}

function useActivityAttentionStoreSource(includeSessionMessages: boolean, detailAddresses?: readonly SessionAddress[]): ActivityAttentionSource {
    return storage(useActivityAttentionStoreSelector(includeSessionMessages, detailAddresses));
}

/**
 * The exact-Home scopes the address-admission owner needs for rule-query candidacy. Chrome that
 * projects a count or a pending list does not present Team labels or observe Session audiences,
 * so it needs these scopes and not the full audience context.
 */
export function useActivityRuleAudienceScopes(): ReadonlyMap<string, ServerAccountScope> {
    const personalMembership = useActivityPersonalSessionMembership();
    const homeIds = React.useMemo(() => Object.keys(personalMembership.ruleSessionMembershipByServerId ?? {}),
        [personalMembership.ruleSessionMembershipByServerId]);
    const bindings = useServerCredentialAccountScopeBindings(homeIds);
    return React.useMemo(() => new Map([...bindings].map(([home, binding]) => [home, binding.scope])), [bindings]);
}

/** Summary surfaces never subscribe to or scan detailed transcript messages. */
export function useActivityAttentionSummarySource(): ActivityAttentionSource {
    return useActivityAttentionStoreSource(false);
}

export function useActivityAttentionSource(options?: Readonly<{
    includeSessionMessages?: boolean;
    detailAddresses?: readonly SessionAddress[];
}>): ActivityAttentionSource {
    const summarySource = useActivityAttentionStoreSource(options?.includeSessionMessages !== false, options?.detailAddresses);
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
        ...Object.entries(summarySource.ruleSessionMembershipByServerId ?? {})
        .flatMap(([serverId, ids]) => (ids ?? []).flatMap((id) => {
            const address = normalizeSessionAddress(serverId, id);
            return address ? [address] : [];
        })),
    ], [
        summarySource.ordinarySessionListMembershipByServerId,
        summarySource.personalSessionListMembershipByServerId,
        summarySource.ruleSessionMembershipByServerId,
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
