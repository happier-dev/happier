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
import { HOME_PERSONAL_SESSION_LIST_QUERY } from '@/sync/engine/sessions/sessionListPageOneRead';
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
    const refreshingHomes = React.useRef<ReadonlyMap<string, unknown> | null>(null);
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
        refreshingHomes.current = requests;
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
            const rulesRead = enabled ? import('@/sync/api/session/sessionFollowRulesApi')
                .then(api => api.readSessionFollowRules(serverId, request.controller.signal))
                .catch(() => ({ status: 'unavailable', reason: 'unavailable' } as const)) : Promise.resolve(undefined);
            const muteRead = resolveServerCredentialAccountScope(serverId).then(async resolution => {
                if (resolution.kind !== 'bound') return null;
                const { readAccountDeliveryMutedScopes } = await import('./accountDeliveryMutes');
                const scopes = await readAccountDeliveryMutedScopes(resolution.scope);
                return scopes === null ? null : { scope: resolution.scope, scopes };
            }).catch(() => null);
            void Promise.all([rulesRead, muteRead]).then(([rules, mutes]) => {
                    if (requests.get(serverId) !== request) return;
                    requests.delete(serverId);
                if (disposed || request.controller.signal.aborted) return;
                if (request.rerun) { refresh(serverId); return; }
                if (rules) setRules(previous => ({ ...previous, [serverId]: rules }));
                setMute(serverId, mutes);
                });
        };
        const refreshMatching = (serverId: string, retire = false) => {
            for (const home of serverIds) if (areServerProfileIdentifiersEquivalent(home, serverId)) refresh(home, retire);
        };
        const unsubscribeChanges = subscribeHomeAccountChange(event => {
            if (isAccountFollowConfigurationChangeRelevant(event)) refreshMatching(event.serverId);
        }, { reconnect: { readNotCurrent: (event) => {
            const current = snapshotRef.current;
            return serverIds.some(home => areServerProfileIdentifiersEquivalent(home, event.serverId)
                && (current.serverIds !== serverIds || current.generation !== generation
                    || !current.mutes[home] || (enabled && current.rules[home]?.status !== 'ready')));
        } } });
        const unsubscribeCredentials = subscribeHomeCredentialChange(event => refreshMatching(event.serverId, true));
        const retirement = captureActiveServerAccountScopeLifetime()?.onRetire(() => {
            for (const request of requests.values()) request.controller.abort();
            setSnapshot({ serverIds, generation, rules: EMPTY_ACQUIRED_FOLLOW_RULES, mutes: EMPTY_ACCOUNT_DELIVERY_MUTES });
        });
        for (const serverId of serverIds) refresh(serverId);
        return () => {
            disposed = true;
            refreshingHomes.current = null;
            retirement?.dispose(); unsubscribeChanges(); unsubscribeCredentials();
            for (const request of requests.values()) request.controller.abort();
        };
    }, [enabled, generation, serverIds]);
    const isRefreshing = React.useCallback((serverId: string) => refreshingHomes.current?.has(serverId) === true, []);
    const acceptProgress = React.useCallback((previous: AcquiredSessionFollowRulesSnapshot, next: AcquiredSessionFollowRulesSnapshot) => {
        if (next === previous) return;
        setSnapshot(current => current.rules[previous.serverId] !== previous ? current
            : { ...current, rules: { ...current.rules, [previous.serverId]: next } });
    }, []);
    const current = snapshot.serverIds === serverIds && snapshot.generation === generation;
    return React.useMemo(() => ({ rules: enabled && current ? snapshot.rules : EMPTY_ACQUIRED_FOLLOW_RULES,
        mutes: current ? snapshot.mutes : EMPTY_ACCOUNT_DELIVERY_MUTES, acceptProgress, isRefreshing }), [acceptProgress, current, enabled, isRefreshing, snapshot.mutes, snapshot.rules]);
}

/** The existing census owns the only private snapshot and its accepted source progress. */
function usePersonalReceiverEvaluation(input: Readonly<{
    enabled: boolean; generation: number;
    acquired: AcquiredSessionFollowRulesSnapshot | null;
    mutes: NonNullable<ActivityPersonalSessionMembership['accountDeliveryMutesByServerId']>[string];
    acceptProgress: ReturnType<typeof usePersonalFollowInputs>['acceptProgress'];
    isRefreshing: ReturnType<typeof usePersonalFollowInputs>['isRefreshing'];
    personalMembership: readonly SessionAddress[] | null | undefined;
    receiverMembership: readonly SessionAddress[] | null | undefined;
}>): ActivityReceiverRuleEvaluationByServerId {
    const [pending, setPending] = React.useState<ActivityReceiverRuleEvaluationByServerId>({});
    const sources = React.useMemo(() => new Set([
        ...(input.personalMembership ?? []), ...(input.receiverMembership ?? []),
    ].map(address => address.sessionId)), [input.personalMembership, input.receiverMembership]);
    const latest = React.useRef({ ...input, sources });
    const runtime = React.useRef<ReturnType<typeof createSessionFollowPersonalReceiverRuntime> | null>(null);
    React.useLayoutEffect(() => { latest.current = { ...input, sources }; });
    const { acquired } = input;
    React.useEffect(() => {
        if (!input.enabled || !acquired) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !lifetime.isCurrent() || lifetime.scope.accountId !== acquired.accountId
            || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, acquired.serverId)) return;
        const serverId = acquired.serverId;
        const readInputs = () => {
            const { acquired: snapshot, mutes } = latest.current;
            return {
                snapshot: snapshot?.serverId === serverId && snapshot.accountId === lifetime.scope.accountId ? snapshot : null,
                mutedScopes: !input.isRefreshing(serverId) && mutes?.scope.accountId === lifetime.scope.accountId ? mutes.scopes : null,
            };
        };
        const owner = createSessionFollowPersonalReceiverRuntime({ lifetime, readInputs,
            readSourceSessionIds: () => latest.current.sources,
            readOrdinarySessionIds: () => readRegisteredStorageState()?.ordinarySessionListMembershipByServerId[serverId] ?? [],
            acceptedProgress: (previous, next) => {
                // Publish synchronously for another original in this same traversal;
                // React then exposes the same accepted census to presentation.
                latest.current = { ...latest.current, acquired: next };
                input.acceptProgress(previous, next);
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
        return () => { owner.dispose(); retirement.dispose(); if (runtime.current === owner) runtime.current = null; };
    }, [input.enabled, input.generation, input.acceptProgress, input.isRefreshing, acquired?.accountId, acquired?.credentialScopeKey, acquired?.serverId]);
    React.useEffect(() => {
        if (!acquired) {
            setPending(previous => Object.values(previous).some(projection => Object.values(projection.pendingBySourceSessionId)
                .some(state => state !== 'waiting_for_authorized_device')) ? Object.fromEntries(Object.entries(previous).map(([serverId, projection]) => [serverId,
                { ...projection, pendingBySourceSessionId: Object.fromEntries(Object.keys(projection.pendingBySourceSessionId)
                    .map(id => [id, 'waiting_for_authorized_device' as const])) }])) : previous);
            return;
        }
        runtime.current?.reconcile();
    }, [acquired, input.generation, input.enabled, sources, input.mutes]);
    return pending;
}

/**
 * Activity's independent personal corpus. The strict query owner evaluates every
 * personal-relevance producer before pagination; Activity only retains its exact
 * per-Home membership and lets the shared row owner hydrate the returned rows.
 */
export const ACTIVITY_PERSONAL_SESSION_QUERY: SessionListQueryV1 = HOME_PERSONAL_SESSION_LIST_QUERY;

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
    const activeRules = activeServer.serverId ? personalInputs.rules[activeServer.serverId] : undefined;
    const acquired = activeRules?.status === 'ready' ? activeRules : null;
    const receiverEnabled = props.enabled && acquired?.rules.some(rule => rule.receiver.kind === 'account' && rule.definition.enabled) === true;
    const receiverHomes = React.useMemo(() => !receiverEnabled || !activeServer.serverId ? [] : [{
        serverId: activeServer.serverId, query: { ...ACTIVITY_PERSONAL_SESSION_QUERY, scope: 'all_accessible' as const, includeAttention: false },
        queryMembership: 'rowOnly' as const,
        // Replacement pages describe one census. Publishing a prefix would
        // make the retained suffix look like newly admitted sources later.
        readMode: 'complete' as const,
    }], [activeServer.serverId, receiverEnabled]);
    const receiverCorpus = useSessionListQueryHomeStates({ enabled: receiverEnabled, homes: receiverHomes });
    const receiverRuleEvaluationByServerId = usePersonalReceiverEvaluation({
        enabled: receiverEnabled, generation: activeServer.generation, acquired,
        acceptProgress: personalInputs.acceptProgress, isRefreshing: personalInputs.isRefreshing,
        mutes: activeServer.serverId ? personalInputs.mutes[activeServer.serverId] : null,
        personalMembership: activeServer.serverId ? querySource.membershipByServerId[activeServer.serverId] : null,
        receiverMembership: activeServer.serverId ? receiverCorpus.membershipByServerId[activeServer.serverId] : null,
    });
    const ruleSessionMembershipByServerId = React.useMemo(() => Object.fromEntries(Object.entries(receiverCorpus.membershipByServerId)
        .map(([serverId, addresses]) => [serverId, (addresses ?? []).map(address => address.sessionId)])), [receiverCorpus.membershipByServerId]);
    // The personal presentation query still observes its first page and reports partial coverage.

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
