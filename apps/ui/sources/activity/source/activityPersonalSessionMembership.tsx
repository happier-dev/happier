import type { SessionListQueryV1 } from '@happier-dev/protocol';
import * as React from 'react';

import {
    getServerProfilesGeneration,
    getActiveServerSnapshot,
    listServerProfiles,
    resolveServerProfileScopeId,
    subscribeServerProfiles,
    subscribeActiveServer,
} from '@/sync/domains/server/serverProfiles';
import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { buildSessionListQueryKey } from '@/sync/domains/session/listing/sessionListQueryKey';
import { useSessionListQueryHomeStates } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import type { SessionFollowRulesSnapshot, SessionFollowRulesReadResult } from '@/sync/api/session/sessionFollowRulesApi';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeHomeAccountChange, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { isAccountFollowConfigurationChangeRelevant } from '@/components/sessions/follow/sessionFollowAccountChange';

export type ActivityPersonalSessionMembership = Readonly<{
    membershipByServerId: Readonly<Record<string, readonly string[]>>;
    statesByServerId: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    coverageComplete: boolean;
    followRulesByServerId?: Readonly<Record<string, SessionFollowRulesSnapshot>>;
    /** Existing all-accessible query candidates, not personal relevance or enrollment. */
    ruleSessionMembershipByServerId?: Readonly<Record<string, readonly string[]>>;
    accountDeliveryMutesByServerId?: Readonly<Record<string, Readonly<{
        scope: ServerAccountScope; scopes: readonly FollowDeliveryMuteScopeV1[];
    }> | null>>;
}>;

const EMPTY_ACTIVITY_PERSONAL_SESSION_MEMBERSHIP: ActivityPersonalSessionMembership = {
    membershipByServerId: {},
    statesByServerId: {},
    coverageComplete: false,
};

const ActivityPersonalSessionMembershipContext = React.createContext<ActivityPersonalSessionMembership>(
    EMPTY_ACTIVITY_PERSONAL_SESSION_MEMBERSHIP,
);
const EMPTY_FOLLOW_RULES: Readonly<Record<string, SessionFollowRulesReadResult>> = Object.freeze({});
const EMPTY_ACCOUNT_DELIVERY_MUTES: NonNullable<ActivityPersonalSessionMembership['accountDeliveryMutesByServerId']> = Object.freeze({});

/** One private census per mounted Activity owner, shared by closed badges and open details. */
function usePersonalFollowInputs(serverIds: readonly string[], enabled: boolean, generation: number) {
    const [snapshot, setSnapshot] = React.useState({ serverIds, generation, rules: EMPTY_FOLLOW_RULES, mutes: EMPTY_ACCOUNT_DELIVERY_MUTES });
    React.useEffect(() => {
        const setRules = (update: (previous: Readonly<Record<string, SessionFollowRulesReadResult>>) => Readonly<Record<string, SessionFollowRulesReadResult>>) => {
            setSnapshot(previous => {
                const sameScope = previous.serverIds === serverIds && previous.generation === generation;
                const rules = update(sameScope ? previous.rules : EMPTY_FOLLOW_RULES);
                return sameScope && sameStrictJsonValue(previous.rules, rules) ? previous
                    : { serverIds, generation, rules, mutes: sameScope ? previous.mutes : EMPTY_ACCOUNT_DELIVERY_MUTES };
            });
        };
        if (!enabled) setRules(() => EMPTY_FOLLOW_RULES);
        const setMute = (serverId: string, value: NonNullable<ActivityPersonalSessionMembership['accountDeliveryMutesByServerId']>[string]) => {
            setSnapshot(previous => {
                const sameScope = previous.serverIds === serverIds && previous.generation === generation;
                const mutes = { ...(sameScope ? previous.mutes : EMPTY_ACCOUNT_DELIVERY_MUTES), [serverId]: value };
                return sameScope && sameStrictJsonValue(previous.mutes, mutes) ? previous
                    : { serverIds, generation, rules: sameScope ? previous.rules : EMPTY_FOLLOW_RULES, mutes };
            });
        };
        let disposed = false;
        const requests = new Map<string, { controller: AbortController; rerun: boolean }>();
        const refresh = (serverId: string, retire = false) => {
            const existing = requests.get(serverId);
            setMute(serverId, null);
            if (retire) {
                existing?.controller.abort();
                requests.delete(serverId);
                setRules(previous => ({ ...previous, [serverId]: { status: 'unavailable', reason: 'scope-retired' } }));
            } else if (existing) { existing.rerun = true; return; }
            const request = { controller: new AbortController(), rerun: false };
            requests.set(serverId, request);
            const rulesRead = enabled ? import('@/sync/api/session/sessionFollowRulesApi').then(api => api.readSessionFollowRules(serverId, request.controller.signal))
                .then(snapshot => {
                    if (!disposed && !request.controller.signal.aborted) setRules(previous => ({ ...previous, [serverId]: snapshot }));
                }).catch(() => {
                    if (!disposed && !request.controller.signal.aborted) setRules(previous => ({ ...previous, [serverId]: { status: 'unavailable', reason: 'unavailable' } }));
                }) : Promise.resolve();
            const muteRead = resolveServerCredentialAccountScope(serverId).then(async resolution => {
                if (resolution.kind !== 'bound') return null;
                const { readAccountSessionDeliveryMutedScopes } = await import('@/sync/api/session/sessionFollowApi');
                const scopes = await readAccountSessionDeliveryMutedScopes(resolution.scope, request.controller.signal);
                return scopes === null ? null : { scope: resolution.scope, scopes };
            }).then(mutes => {
                if (!disposed && !request.controller.signal.aborted) setMute(serverId, request.rerun ? null : mutes);
            }).catch(() => {
                if (!disposed && !request.controller.signal.aborted) setMute(serverId, null);
            });
            void Promise.all([rulesRead, muteRead]).finally(() => {
                    if (requests.get(serverId) !== request) return;
                    requests.delete(serverId);
                    if (!disposed && request.rerun) refresh(serverId);
                });
        };
        const refreshMatching = (serverId: string, retire = false) => {
            for (const home of serverIds) if (areServerProfileIdentifiersEquivalent(home, serverId)) refresh(home, retire);
        };
        const unsubscribeChanges = subscribeHomeAccountChange(event => {
            if (isAccountFollowConfigurationChangeRelevant(event)) refreshMatching(event.serverId);
        });
        const unsubscribeCredentials = subscribeHomeCredentialChange(event => refreshMatching(event.serverId, true));
        const retirement = captureActiveServerAccountScopeLifetime()?.onRetire(() => {
            for (const request of requests.values()) request.controller.abort();
            setSnapshot({ serverIds, generation, rules: EMPTY_FOLLOW_RULES, mutes: EMPTY_ACCOUNT_DELIVERY_MUTES });
        });
        for (const serverId of serverIds) refresh(serverId);
        return () => {
            disposed = true;
            retirement?.dispose(); unsubscribeChanges(); unsubscribeCredentials();
            for (const request of requests.values()) request.controller.abort();
        };
    }, [enabled, generation, serverIds]);
    const current = snapshot.serverIds === serverIds && snapshot.generation === generation;
    return React.useMemo(() => ({ rules: enabled && current ? snapshot.rules : EMPTY_FOLLOW_RULES,
        mutes: current ? snapshot.mutes : EMPTY_ACCOUNT_DELIVERY_MUTES }), [current, enabled, snapshot.mutes, snapshot.rules]);
}

/**
 * Activity's independent personal corpus. The strict query owner evaluates every
 * personal-relevance producer before pagination; Activity only retains its exact
 * per-Home membership and lets the shared row owner hydrate the returned rows.
 */
export const ACTIVITY_PERSONAL_SESSION_QUERY: SessionListQueryV1 = {
    v: 1,
    storage: 'active',
    includeInactive: true,
    scope: 'my_work',
    attention: 'any',
    audiences: [],
    tagIds: [],
    includeAttention: true,
};

type ActivityPersonalQueryHome = Readonly<{
    serverId: string;
    query: SessionListQueryV1;
    queryKey: string;
    queryMembership: 'rowOnly';
}>;

export function buildActivityPersonalQueryHomes(serverIds: readonly string[]): ActivityPersonalQueryHome[] {
    const seen = new Set<string>();
    const homes: ActivityPersonalQueryHome[] = [];
    for (const serverIdRaw of serverIds) {
        const serverId = serverIdRaw.trim();
        if (!serverId || seen.has(serverId)) continue;
        seen.add(serverId);
        homes.push({
            serverId,
            query: ACTIVITY_PERSONAL_SESSION_QUERY,
            queryKey: buildSessionListQueryKey(serverId, ACTIVITY_PERSONAL_SESSION_QUERY),
            queryMembership: 'rowOnly',
        });
    }
    return homes;
}

export function buildActivityPersonalQueryHomeServerIds(
    profileServerIds: readonly string[],
    activeServerId: string | null | undefined,
): string[] {
    return Array.from(new Set([activeServerId ?? '', ...profileServerIds].map((id) => id.trim()).filter(Boolean)));
}

/**
 * Activity reads the shared strict-query membership projection (`useSessionListQueryHomeStates`):
 * the applied page while one answers, otherwise the store's last-known membership for this exact
 * Account/Home/query. Controller state only decides what that membership may not claim: an
 * unsupported or invalid query, or a released-listing fallback page, is never personal membership.
 */
export function projectActivityPersonalSessionMembership(input: Readonly<{
    enabled: boolean;
    homes: readonly ActivityPersonalQueryHome[];
    statesByServerId: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    membershipByServerId: Readonly<Record<string, readonly SessionAddress[] | null | undefined>>;
    coverageComplete: boolean;
}>): ActivityPersonalSessionMembership {
    if (!input.enabled) return EMPTY_ACTIVITY_PERSONAL_SESSION_MEMBERSHIP;
    const membershipByServerId: Record<string, readonly string[]> = {};
    for (const home of input.homes) {
        const state = input.statesByServerId[home.serverId];
        const withdrawn = state?.failureReason === 'unsupported'
            || state?.failureReason === 'invalid_query'
            || (state?.appliedQueryKey === home.queryKey && state.appliedSourceKind !== 'query');
        membershipByServerId[home.serverId] = withdrawn
            ? []
            : (input.membershipByServerId[home.serverId] ?? [])
                .filter((address) => address.serverId === home.serverId)
                .map((address) => address.sessionId);
    }
    return {
        membershipByServerId,
        statesByServerId: input.statesByServerId,
        coverageComplete: input.coverageComplete,
    };
}

export function ActivityPersonalSessionMembershipProvider(props: React.PropsWithChildren<{
    enabled: boolean;
}>): React.ReactElement {
    const profilesGeneration = React.useSyncExternalStore(
        subscribeServerProfiles,
        getServerProfilesGeneration,
        getServerProfilesGeneration,
    );
    const activeServer = React.useSyncExternalStore(
        (listener) => subscribeActiveServer(() => listener()),
        getActiveServerSnapshot,
        getActiveServerSnapshot,
    );
    const serverIds = React.useMemo(
        () => buildActivityPersonalQueryHomeServerIds(
            listServerProfiles().map(resolveServerProfileScopeId),
            activeServer.serverId,
        ),
        [activeServer.serverId, profilesGeneration],
    );
    const homes = React.useMemo(() => buildActivityPersonalQueryHomes(serverIds), [serverIds]);
    const personalInputs = usePersonalFollowInputs(serverIds, props.enabled, activeServer.generation);
    // Membership needs which Sessions are in the corpus, never their rows: the states-only owner keeps
    // session content changes from re-rendering Activity.
    const querySource = useSessionListQueryHomeStates({
        enabled: props.enabled,
        homes,
    });
    // Authored personal rules need original catch-up beyond the private my-work
    // page, including a first foreign source created while this app was closed.
    // This borrows the list owner's existing paging/cancellation; it stores no
    // delivery cursor or membership/enrollment edge.
    const receiverEnabled = props.enabled && Object.values(personalInputs.rules).some(snapshot => snapshot.status === 'ready'
        && areServerProfileIdentifiersEquivalent(snapshot.serverId, activeServer.serverId ?? '')
        && snapshot.rules.some(rule => rule.receiver.kind === 'account' && rule.definition.enabled));
    const receiverHomes = React.useMemo(() => !receiverEnabled || !activeServer.serverId ? [] : [{
        serverId: activeServer.serverId, query: { ...ACTIVITY_PERSONAL_SESSION_QUERY, scope: 'all_accessible' as const, includeAttention: false },
        queryMembership: 'rowOnly' as const,
    }], [activeServer.serverId, receiverEnabled]);
    const receiverCorpus = useSessionListQueryHomeStates({ enabled: receiverEnabled, homes: receiverHomes });
    React.useEffect(() => {
        const state = activeServer.serverId ? receiverCorpus.statesByServerId[activeServer.serverId] : undefined;
        if (receiverEnabled && state?.phase === 'ready' && state.appliedSourceKind === 'query' && state.hasNext) {
            void receiverCorpus.loadNext().catch(() => { /* The query owner retains the exact failed page and repair state. */ });
        }
    }, [activeServer.serverId, receiverEnabled, receiverCorpus.loadNext, receiverCorpus.statesByServerId]);
    const ruleSessionMembershipByServerId = React.useMemo(() => Object.fromEntries(Object.entries(receiverCorpus.membershipByServerId)
        .map(([serverId, addresses]) => [serverId, (addresses ?? []).map(address => address.sessionId)])), [receiverCorpus.membershipByServerId]);
    // Background membership observes its first page and reports partial coverage.
    // Only a visible list or an explicit exhaustive operation demands more pages.

    const value = React.useMemo(() => ({ ...projectActivityPersonalSessionMembership({
        enabled: props.enabled,
        homes,
        statesByServerId: querySource.statesByServerId,
        membershipByServerId: querySource.membershipByServerId,
        coverageComplete: querySource.coverageComplete,
    }), followRulesByServerId: personalInputs.rules, accountDeliveryMutesByServerId: personalInputs.mutes,
        ruleSessionMembershipByServerId }), [personalInputs, ruleSessionMembershipByServerId, homes, props.enabled, querySource.coverageComplete, querySource.membershipByServerId, querySource.statesByServerId]);

    return (
        <ActivityPersonalSessionMembershipContext.Provider value={value}>
            {props.children}
        </ActivityPersonalSessionMembershipContext.Provider>
    );
}

export function useActivityPersonalSessionMembership(): ActivityPersonalSessionMembership {
    return React.useContext(ActivityPersonalSessionMembershipContext);
}
