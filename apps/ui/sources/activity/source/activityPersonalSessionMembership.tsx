import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
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
import type { AcquiredSessionFollowRulesSnapshot, SessionFollowRulesSnapshot, SessionFollowRulesReadResult } from '@/sync/api/session/sessionFollowRulesApi';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeHomeAccountChange, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { isAccountFollowConfigurationChangeRelevant } from '@/components/sessions/follow/sessionFollowAccountChange';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { createSessionFollowPersonalReceiverRuntime } from '@/sync/engine/sessions/sessionFollowPersonalReceiver';
import type { ActivityReceiverRuleEvaluationByServerId } from './activityAttentionSourceTypes';

export type ActivityPersonalSessionMembership = Readonly<{
    membershipByServerId: Readonly<Record<string, readonly string[]>>;
    statesByServerId: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    coverageComplete: boolean;
    followRulesByServerId?: Readonly<Record<string, SessionFollowRulesSnapshot>>;
    /** Existing all-accessible query candidates, not personal relevance or enrollment. */
    ruleSessionMembershipByServerId?: Readonly<Record<string, readonly string[]>>;
    receiverRuleEvaluationByServerId?: ActivityReceiverRuleEvaluationByServerId;
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
const EMPTY_ACQUIRED_FOLLOW_RULES: Readonly<Record<string, SessionFollowRulesReadResult>> = Object.freeze({});
const EMPTY_ACCOUNT_DELIVERY_MUTES: NonNullable<ActivityPersonalSessionMembership['accountDeliveryMutesByServerId']> = Object.freeze({});

/** One private census per mounted Activity owner, shared by closed badges and open details. */
function usePersonalFollowInputs(serverIds: readonly string[], enabled: boolean, generation: number) {
    const [snapshot, setSnapshot] = React.useState({ serverIds, generation, rules: EMPTY_ACQUIRED_FOLLOW_RULES, mutes: EMPTY_ACCOUNT_DELIVERY_MUTES });
    const snapshotRef = React.useRef(snapshot);
    snapshotRef.current = snapshot;
    React.useEffect(() => {
        const setRules = (update: (previous: Readonly<Record<string, SessionFollowRulesReadResult>>) => Readonly<Record<string, SessionFollowRulesReadResult>>) => {
            setSnapshot(previous => {
                const sameScope = previous.serverIds === serverIds && previous.generation === generation;
                const rules = update(sameScope ? previous.rules : EMPTY_ACQUIRED_FOLLOW_RULES);
                return sameScope && sameStrictJsonValue(previous.rules, rules) ? previous
                    : { serverIds, generation, rules, mutes: sameScope ? previous.mutes : EMPTY_ACCOUNT_DELIVERY_MUTES };
            });
        };
        if (!enabled) setRules(() => EMPTY_ACQUIRED_FOLLOW_RULES);
        const setMute = (serverId: string, value: NonNullable<ActivityPersonalSessionMembership['accountDeliveryMutesByServerId']>[string]) => {
            setSnapshot(previous => {
                const sameScope = previous.serverIds === serverIds && previous.generation === generation;
                const mutes = { ...(sameScope ? previous.mutes : EMPTY_ACCOUNT_DELIVERY_MUTES), [serverId]: value };
                return sameScope && sameStrictJsonValue(previous.mutes, mutes) ? previous
                    : { serverIds, generation, rules: sameScope ? previous.rules : EMPTY_ACQUIRED_FOLLOW_RULES, mutes };
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
        }, { reconnect: { readNotCurrent: () => {
            const current = snapshotRef.current;
            return current.serverIds !== serverIds || current.generation !== generation || serverIds.some(home =>
                !current.mutes[home] || (enabled && current.rules[home]?.status !== 'ready'));
        } } });
        const unsubscribeCredentials = subscribeHomeCredentialChange(event => refreshMatching(event.serverId, true));
        const retirement = captureActiveServerAccountScopeLifetime()?.onRetire(() => {
            for (const request of requests.values()) request.controller.abort();
            setSnapshot({ serverIds, generation, rules: EMPTY_ACQUIRED_FOLLOW_RULES, mutes: EMPTY_ACCOUNT_DELIVERY_MUTES });
        });
        for (const serverId of serverIds) refresh(serverId);
        return () => {
            disposed = true;
            retirement?.dispose(); unsubscribeChanges(); unsubscribeCredentials();
            for (const request of requests.values()) request.controller.abort();
        };
    }, [enabled, generation, serverIds]);
    const acceptProgress = React.useCallback((previous: AcquiredSessionFollowRulesSnapshot, next: AcquiredSessionFollowRulesSnapshot) => {
        if (next === previous) return;
        setSnapshot(current => current.rules[previous.serverId] !== previous ? current
            : { ...current, rules: { ...current.rules, [previous.serverId]: next } });
    }, []);
    const current = snapshot.serverIds === serverIds && snapshot.generation === generation;
    return React.useMemo(() => ({ rules: enabled && current ? snapshot.rules : EMPTY_ACQUIRED_FOLLOW_RULES,
        mutes: current ? snapshot.mutes : EMPTY_ACCOUNT_DELIVERY_MUTES, acceptProgress }), [acceptProgress, current, enabled, snapshot.mutes, snapshot.rules]);
}

/** The existing census owns the only private snapshot and its accepted source progress. */
function usePersonalReceiverEvaluation(input: Readonly<{
    enabled: boolean; serverId: string | null; generation: number;
    personalInputs: ReturnType<typeof usePersonalFollowInputs>;
    membershipByServerId: Readonly<Record<string, readonly SessionAddress[] | null | undefined>>;
}>): ActivityReceiverRuleEvaluationByServerId {
    const [pending, setPending] = React.useState<ActivityReceiverRuleEvaluationByServerId>({});
    const latest = React.useRef(input);
    const runtime = React.useRef<ReturnType<typeof createSessionFollowPersonalReceiverRuntime> | null>(null);
    const acceptedCensus = React.useRef<AcquiredSessionFollowRulesSnapshot | null>(null);
    React.useLayoutEffect(() => { latest.current = input; });
    const activeRules = input.serverId ? input.personalInputs.rules[input.serverId] : undefined;
    const acquired = activeRules?.status === 'ready' ? activeRules : null;
    const hasPersonalRules = acquired?.rules.some(rule => rule.receiver.kind === 'account' && rule.definition.enabled) === true;
    React.useEffect(() => {
        if (!input.enabled || !acquired || !hasPersonalRules) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !lifetime.isCurrent() || lifetime.scope.accountId !== acquired.accountId
            || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, acquired.serverId)) return;
        const serverId = acquired.serverId;
        const readInputs = () => {
            const current = latest.current;
            const snapshot = current.personalInputs.rules[serverId];
            const mutes = current.personalInputs.mutes[serverId];
            return { snapshot: snapshot?.status === 'ready' && snapshot.accountId === lifetime.scope.accountId ? snapshot : null,
                mutedScopes: mutes?.scope.accountId === lifetime.scope.accountId ? mutes.scopes : null };
        };
        const readSourceSessionIds = () => {
            const current = latest.current;
            const snapshot = current.personalInputs.rules[serverId];
            const state = readRegisteredStorageState();
            const sourceSessionIds = new Set([
                ...(current.membershipByServerId[serverId] ?? []).map(address => address.sessionId),
                ...(state?.ordinarySessionListMembershipByServerId[serverId] ?? []),
                ...Object.values(state?.sessions ?? {}).filter(session => !session.serverId
                    || areServerProfileIdentifiersEquivalent(session.serverId, serverId)).map(session => session.id),
                ...(snapshot?.status === 'ready' ? snapshot.rules.filter(rule => rule.receiver.kind === 'account')
                    .flatMap(rule => rule.sources?.map(source => source.sourceSessionId) ?? []) : []),
            ]);
            return [...sourceSessionIds];
        };
        const owner = createSessionFollowPersonalReceiverRuntime({ lifetime, readInputs, readSourceSessionIds,
            acceptedProgress: (previous, next) => {
                // Publish synchronously for another original in this same traversal;
                // React then exposes the same accepted census to presentation.
                latest.current = { ...latest.current, personalInputs: { ...latest.current.personalInputs,
                    rules: { ...latest.current.personalInputs.rules, [serverId]: next } } };
                acceptedCensus.current = next;
                input.personalInputs.acceptProgress(previous, next);
            },
            pending: (occurrence, waiting) => setPending(previous => {
                if (!lifetime.isCurrent()) return previous;
                const existing = previous[serverId]?.accountId === lifetime.scope.accountId
                    ? previous[serverId]!.pendingBySourceSessionId : {};
                const state = waiting ? 'catch_up_pending' as const : undefined;
                if (existing[occurrence.sourceSessionId] === state) return previous;
                const pendingBySourceSessionId = { ...existing };
                if (state) pendingBySourceSessionId[occurrence.sourceSessionId] = state;
                else delete pendingBySourceSessionId[occurrence.sourceSessionId];
                return { ...previous, [serverId]: { accountId: lifetime.scope.accountId, pendingBySourceSessionId } };
            }),
        });
        runtime.current = owner;
        const retirement = lifetime.onRetire(() => { owner.dispose(); setPending({}); });
        owner.reconcile();
        return () => { owner.dispose(); retirement.dispose(); if (runtime.current === owner) runtime.current = null; };
    }, [input.enabled, input.generation, hasPersonalRules, acquired?.accountId, acquired?.credentialScopeKey, acquired?.serverId]);
    React.useEffect(() => {
        if (!acquired) {
            setPending(previous => Object.values(previous).some(projection => Object.values(projection.pendingBySourceSessionId)
                .some(state => state !== 'waiting_for_authorized_device')) ? Object.fromEntries(Object.entries(previous).map(([serverId, projection]) => [serverId,
                { ...projection, pendingBySourceSessionId: Object.fromEntries(Object.keys(projection.pendingBySourceSessionId)
                    .map(id => [id, 'waiting_for_authorized_device' as const])) }])) : previous);
            return;
        }
        // A reflected source ACK changes consumption, not rule configuration.
        // Its existing exact-source change wake owns any remaining suffix.
        if (acquired !== acceptedCensus.current) runtime.current?.reconcile();
    }, [acquired, input.membershipByServerId, input.personalInputs.mutes]);
    return pending;
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
    /**
     * The last committed projection. Query lifecycle moves (refreshing, freshness) on every
     * background refetch; equal per-Home membership keeps this identity so Activity selectors
     * keyed on membership are not rebuilt by lifecycle-only changes.
     */
    previousMembershipByServerId?: ActivityPersonalSessionMembership['membershipByServerId'] | null;
}>): ActivityPersonalSessionMembership {
    if (!input.enabled) return EMPTY_ACTIVITY_PERSONAL_SESSION_MEMBERSHIP;
    const previous = input.previousMembershipByServerId ?? null;
    const membershipByServerId: Record<string, readonly string[]> = {};
    let reusesPrevious = previous !== null && Object.keys(previous).length === input.homes.length;
    for (const home of input.homes) {
        const state = input.statesByServerId[home.serverId];
        const withdrawn = state?.failureReason === 'unsupported'
            || state?.failureReason === 'invalid_query'
            || (state?.appliedQueryKey === home.queryKey && state.appliedSourceKind !== 'query');
        const sessionIds = withdrawn
            ? []
            : (input.membershipByServerId[home.serverId] ?? [])
                .filter((address) => address.serverId === home.serverId)
                .map((address) => address.sessionId);
        const previousIds = previous?.[home.serverId];
        const equal = previousIds !== undefined && previousIds.length === sessionIds.length
            && previousIds.every((sessionId, index) => sessionId === sessionIds[index]);
        membershipByServerId[home.serverId] = equal ? previousIds : sessionIds;
        if (!equal) reusesPrevious = false;
    }
    return {
        membershipByServerId: reusesPrevious && previous ? previous : membershipByServerId,
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
    const receiverMembership = React.useMemo(() => {
        const result = { ...querySource.membershipByServerId };
        for (const [serverId, addresses] of Object.entries(receiverCorpus.membershipByServerId)) {
            if (!addresses) continue;
            const sources = new Map((result[serverId] ?? []).map(address => [address.sessionId, address]));
            for (const address of addresses) sources.set(address.sessionId, address);
            result[serverId] = [...sources.values()];
        }
        return result;
    }, [querySource.membershipByServerId, receiverCorpus.membershipByServerId]);
    const receiverRuleEvaluationByServerId = usePersonalReceiverEvaluation({ enabled: props.enabled,
        serverId: activeServer.serverId, generation: activeServer.generation, personalInputs,
        membershipByServerId: receiverMembership });
    const ruleSessionMembershipByServerId = React.useMemo(() => Object.fromEntries(Object.entries(receiverCorpus.membershipByServerId)
        .map(([serverId, addresses]) => [serverId, (addresses ?? []).map(address => address.sessionId)])), [receiverCorpus.membershipByServerId]);
    // Background membership observes its first page and reports partial coverage.
    // Only a visible list or an explicit exhaustive operation demands more pages.

    const committedMembershipRef = React.useRef<ActivityPersonalSessionMembership['membershipByServerId'] | null>(null);
    const value = React.useMemo(() => ({ ...projectActivityPersonalSessionMembership({
        enabled: props.enabled,
        homes,
        statesByServerId: querySource.statesByServerId,
        membershipByServerId: querySource.membershipByServerId,
        coverageComplete: querySource.coverageComplete,
        previousMembershipByServerId: committedMembershipRef.current,
    }), followRulesByServerId: personalInputs.rules, accountDeliveryMutesByServerId: personalInputs.mutes,
        receiverRuleEvaluationByServerId, ruleSessionMembershipByServerId }), [personalInputs, receiverRuleEvaluationByServerId, ruleSessionMembershipByServerId, homes, props.enabled, querySource.coverageComplete, querySource.membershipByServerId, querySource.statesByServerId]);
    // Remember only what was committed; an abandoned render must not become the reference point.
    React.useLayoutEffect(() => { committedMembershipRef.current = value.membershipByServerId; }, [value.membershipByServerId]);

    return (
        <ActivityPersonalSessionMembershipContext.Provider value={value}>
            {props.children}
        </ActivityPersonalSessionMembershipContext.Provider>
    );
}

export function useActivityPersonalSessionMembership(): ActivityPersonalSessionMembership {
    return React.useContext(ActivityPersonalSessionMembershipContext);
}
