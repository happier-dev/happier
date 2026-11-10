import { useSessionAudienceContext } from '@/hooks/teams/useSessionAudienceContext';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
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
    type ActiveServerSnapshot,
} from '@/sync/domains/server/serverProfiles';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { createActivityAttentionStoreSourceSelector, readActivityAttentionStoreSource } from './createActivityAttentionStoreSourceSelector';
import { useActivityPersonalSessionMembership, type ActivityPersonalSessionMembership } from './activityPersonalSessionMembership';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StorageState } from '@/sync/store/types';

/** The store source, re-published only when one of the store values it carries moved. */
function createIdentityStoreSourceSelector(includeSessionMessages: boolean, includeFollowRuleFacts: boolean) {
    let previous: ReturnType<typeof readActivityAttentionStoreSource> | undefined;
    return (state: StorageState) => {
        const next = readActivityAttentionStoreSource(state, includeSessionMessages, includeFollowRuleFacts);
        if (previous && (Object.keys(next) as (keyof typeof next)[]).every(key => Object.is(previous![key], next[key]))) return previous;
        previous = next;
        return next;
    };
}

/** The Activity summary source for one personal membership and active Home, as a store selector. */
export function createActivityAttentionSourceSelector(params: Readonly<{
    personalMembership: ActivityPersonalSessionMembership;
    activeServer: ActiveServerSnapshot;
    includeSessionMessages: boolean;
    detailAddresses?: readonly SessionAddress[];
    /**
     * `signature` (default) publishes a new source only when a fact Activity reads changed, at the
     * cost of signing every row per publication. `identity` publishes whenever a store collection it
     * reads moved, for a reader that follows the changed-id publication itself and so never re-reads
     * unchanged rows.
     */
    changeDetection?: 'signature' | 'identity';
}>): (state: StorageState) => ActivityAttentionSource {
    const { personalMembership, activeServer } = params;
    const includeFollowRuleFacts = Object.values(personalMembership.followRulesByServerId ?? {}).some(snapshot =>
        snapshot.status === 'ready' && snapshot.rules.some(rule => rule.receiver.kind === 'account' && rule.definition.enabled));
    const storeSourceSelector = params.changeDetection === 'identity'
        ? createIdentityStoreSourceSelector(params.includeSessionMessages, includeFollowRuleFacts)
        : createActivityAttentionStoreSourceSelector(
            personalMembership.membershipByServerId,
            { includeSessionMessages: params.includeSessionMessages, detailAddresses: params.detailAddresses, includeFollowRuleFacts,
                ruleMembershipByServerId: personalMembership.ruleSessionMembershipByServerId },
        );
    let previousSource: ReturnType<typeof storeSourceSelector> | undefined;
    let selected: ActivityAttentionSource | undefined;
    return (state: StorageState) => {
        const storeSource = storeSourceSelector(state);
        if (previousSource === storeSource && selected) return selected;
        // Membership is fixed for this selector's lifetime. Session arrivals cannot change Home currentness.
        const homeObservations = selected && previousSource?.concurrentSessionListCacheByServerId === storeSource.concurrentSessionListCacheByServerId
            ? selected.sessionListHomeObservationByServerId
            : buildSessionListHomeObservations({
                concurrentSessionListCacheByServerId: storeSource.concurrentSessionListCacheByServerId,
                queryStatesByServerId: personalMembership.statesByServerId,
            });
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
            receiverRuleEvaluationByServerId: personalMembership.receiverRuleEvaluationByServerId,
            accountDeliveryMutesByServerId: personalMembership.accountDeliveryMutesByServerId,
            sessionListHomeObservationByServerId: homeObservations,
        };
        return selected;
    };
}

/** The active Home snapshot every Activity source is read against. */
export function useActivityActiveServer(): ActiveServerSnapshot {
    return React.useSyncExternalStore(
        React.useCallback((listener) => {
            return subscribeActiveServer(() => listener());
        }, []),
        getActiveServerSnapshot,
        getActiveServerSnapshot,
    );
}

/** Select at the subscription owner, before a changed source can render closed chrome. */
export function useActivityAttentionStoreSelector(
    includeSessionMessages: boolean,
    detailAddresses?: readonly SessionAddress[],
): (state: StorageState) => ActivityAttentionSource {
    const personalMembership = useActivityPersonalSessionMembership();
    const activeServer = useActivityActiveServer();
    return React.useMemo(
        () => createActivityAttentionSourceSelector({ personalMembership, activeServer, includeSessionMessages, detailAddresses }),
        [activeServer, detailAddresses, includeSessionMessages, personalMembership],
    );
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
    return useActivityAttentionSourceContext(false);
}

export function useActivityAttentionSource(options?: Readonly<{
    includeSessionMessages?: boolean;
    detailAddresses?: readonly SessionAddress[];
}>): ActivityAttentionSource {
    return useActivityAttentionSourceContext(options?.includeSessionMessages !== false, options?.detailAddresses);
}

function useActivityAttentionSourceContext(includeSessionMessages: boolean, detailAddresses?: readonly SessionAddress[]): ActivityAttentionSource {
    const summarySource = storage(useActivityAttentionStoreSelector(includeSessionMessages, detailAddresses));
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
