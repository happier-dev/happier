import { ChangeKindSchema, HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1, type ChangeEntry } from '@happier-dev/protocol/changes';
import {
    subscribeHomeCredentialMutations,
    type HomeCredentialMutationEvent,
} from '@/auth/storage/tokenStorage';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { plannedSessionReadinessChanges, planSessionReadinessWake, type SessionReadinessChanges, accountChangeKindsAffectWorkflowTriggers, accountChangeKindsAffectWorkflowDefinitions, planSyncActionsFromChanges, plannedChangesAffectSessionListQuery, plannedChangesAffectWorkflowTriggers, plannedChangesAffectWorkflowDefinitions } from './changesPlanner';
import type { SessionSystemRecordInvalidationV1 } from '@happier-dev/protocol/sessions/board/changeHint';
import { readSavedSecretDisclosureActivityEntityIdV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

/**
 * Observers of the content-free Account-change wake this owner already receives
 * on each Home socket.
 *
 * This is an observation seam over the existing wake, not a second
 * synchronization system: it opens no socket, starts no cursor, replays no
 * domain events and promises no delivery or ordering beyond the wake itself.
 * Account-scoped projections that are fully reconstructible (Home governance,
 * Teams, Follow preferences) use it to invalidate the exact Home and refetch.
 */
export type HomeAccountChangeEvent = Readonly<{
    serverId: string;
    /** Transport connection, or an early socket wake before detailed catch-up has answered. */
    source?: 'connected' | 'catch-up-pending' | 'socket' | 'snapshot';
    /** Exact only for a consumed focused-Home change page; absent wakes remain conservative. */
    entityIds?: readonly string[];
    /** Revision hints from the consumed change page; never inferred from a socket wake. */
    entityRevisions?: Readonly<Record<string, number>>;
    /** The focused change applier has already published these exact Run summaries to the shared store. */
    workflowRunsMaterialized?: true;
    /** The focused applier has already fenced material and owns its awaited refresh. */
    savedSecretResourcesRefreshStarted?: true;
    /** Present when the publisher knows the changed domains; omitted wakes remain conservative. */
    changeKinds?: readonly ChangeEntry['kind'][];
    /**
     * Detailed focused-Home catch-up may publish the incumbent change planner's
     * exact Session-list decision. Socket-only concurrent-Home wakes omit it and
     * remain conservative. `'structural'` means only row-level Session writes: a
     * corpus the ordinary list can answer is unaffected, a structural filter may move.
     */
    sessionReadinessChanges?: SessionReadinessChanges;
    sessionListQueryAffects?: boolean | 'structural';
    /** Exact focused-page Profile/Artifact/source decision; content-free wakes omit it. */
    profileCatalogAffects?: boolean;
    /** The focused planner's settings decision; unknown/coarse wakes remain conservative. */
    accountSettingsAffects?: boolean;
    /** Machine-only focused pages are covered by the Usage store's material-input subscription. */
    usageQueryAffects?: boolean;
    /** The canonical planner's private trigger-read decision; status is not definition content. */
    workflowTriggersAffect?: boolean;
    /** The canonical planner's saved definition/source query decision. */
    workflowDefinitionsAffect?: boolean;
    /** An acknowledged local Artifact deletion; no private content or replay guarantee. */
    deletedArtifactIds?: readonly string[];
}>;

type HomeAccountChangeDetails = Readonly<{
    entityRevisions?: Readonly<Record<string, number>>;
    workflowRunsMaterialized?: true;
    savedSecretResourcesRefreshStarted?: true;
    source?: 'connected' | 'catch-up-pending' | 'socket' | 'snapshot';
    changeKinds?: readonly ChangeEntry['kind'][];
    /** Exact content-free record/access routing; an empty list excludes record changes. */
    sessionSystemRecords?: readonly SessionSystemRecordInvalidationV1[];
    sessionReadinessChanges?: SessionReadinessChanges;
    sessionListQueryAffects?: boolean | 'structural';
    profileCatalogAffects?: boolean;
    accountSettingsAffects?: boolean;
    usageQueryAffects?: boolean;
    workflowTriggersAffect?: boolean;
    workflowDefinitionsAffect?: boolean;
    deletedArtifactIds?: readonly string[];
}>;

/** An Artifact receipt wakes its readers, without invalidating unrelated mutable domain work. */
export function isArtifactOnlyHomeAccountChange(event: HomeAccountChangeEvent): boolean {
    return event.changeKinds !== undefined && event.changeKinds.length > 0
        && event.changeKinds.every(kind => kind === 'artifact');
}

/** Focused changes that can alter Home administration eligibility or rows. */
export function isHomeAdministrationAccountChange(event: HomeAccountChangeEvent): boolean {
    return event.entityIds === undefined
        || event.entityIds.includes(HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1)
        || event.entityIds.includes('self');
}

type HomeAccountChangeObserver = (event: HomeAccountChangeEvent) => void;

const homeAccountChangeObservers = new Map<HomeAccountChangeObserver, Readonly<{
    includeCatchUpPending: boolean;
    serverIds: readonly string[];
}>>();
const homeAccountChangeDemandListeners = new Set<() => void>();

/** Connection demand is derived from the existing live subscriptions, never retained separately. */
export function getHomeAccountChangeDemandedServerIds(): readonly string[] {
    return [...new Set([...homeAccountChangeObservers.values()].flatMap(observer => observer.serverIds))];
}

/** The canonical Home connection owner reconciles when visible observers mount or retire. */
export function subscribeHomeAccountChangeDemand(listener: () => void): () => void {
    homeAccountChangeDemandListeners.add(listener);
    return () => { homeAccountChangeDemandListeners.delete(listener); };
}

// This fences pending raw reads only; it is not an Account cursor or a currentness fact.
const homeAccountReadRevisions = new Map<string, number>();

export function readHomeAccountReadRevision(serverId: string): number {
    return homeAccountReadRevisions.get(resolveServerProfileScopeIdForIdentifier(serverId)) ?? 0;
}

/** Forget raw read joins without asserting that a domain mutation committed. */
export function invalidateHomeAccountReadJoins(serverId: string): void {
    homeAccountReadRevisions.set(resolveServerProfileScopeIdForIdentifier(serverId), readHomeAccountReadRevision(serverId) + 1);
}

type HomeCredentialChangeObserver = (event: HomeCredentialMutationEvent) => void;
const homeCredentialChangeObservers = new Set<HomeCredentialChangeObserver>();
let unsubscribeHomeCredentialMutations: (() => void) | null = null;

function releaseHomeCredentialMutationObserverIfIdle(): void {
    if (homeCredentialChangeObservers.size > 0) return;
    unsubscribeHomeCredentialMutations?.();
    unsubscribeHomeCredentialMutations = null;
}

/**
 * One refcounted credential-mutation fanout for reconstructible Home projections. Domains decide
 * whether to retain signed-out rows or clear replaced-Account rows; none installs its own watcher.
 */
export function subscribeHomeCredentialChange(observer: HomeCredentialChangeObserver): () => void {
    homeCredentialChangeObservers.add(observer);
    if (!unsubscribeHomeCredentialMutations) {
        unsubscribeHomeCredentialMutations = subscribeHomeCredentialMutations((event) => {
            for (const current of [...homeCredentialChangeObservers]) {
                try {
                    current(event);
                } catch {
                    // One projection cannot suppress credential retirement for its siblings.
                }
            }
        });
    }
    return () => {
        homeCredentialChangeObservers.delete(observer);
        releaseHomeCredentialMutationObserverIfIdle();
    };
}

export type { HomeCredentialMutationEvent };

export function subscribeHomeAccountChange(
    observer: HomeAccountChangeObserver,
    // Most projections consume exact planned entities. Catalogs may opt into
    // early revalidation without making every observer refetch on every wake.
    options?: Readonly<{
        includeCatchUpPending?: boolean;
        serverIds?: readonly string[];
    }>,
): () => void {
    const subscription = {
        includeCatchUpPending: options?.includeCatchUpPending === true,
        serverIds: (options?.serverIds ?? []).map(resolveServerProfileScopeIdForIdentifier).filter(Boolean),
    };
    homeAccountChangeObservers.set(observer, subscription);
    if (subscription.serverIds.length > 0) {
        for (const listener of homeAccountChangeDemandListeners) listener();
    }
    return () => {
        if (homeAccountChangeObservers.get(observer) !== subscription) return;
        homeAccountChangeObservers.delete(observer);
        if (subscription.serverIds.length > 0) {
            for (const listener of homeAccountChangeDemandListeners) listener();
        }
    };
}

export function publishHomeAccountChange(
    serverId: string,
    entityIds?: readonly string[],
    details?: HomeAccountChangeDetails,
): void {
    publishHomeAccountChangeForRouting(serverId, entityIds, details);
}

/** Secondary-Home routing consumes the same admitted event sent to observers. */
export function publishHomeAccountChangeForRouting(
    serverId: string,
    entityIds?: readonly string[],
    details?: HomeAccountChangeDetails,
): HomeAccountChangeEvent {
    // Advance before any consumer can synchronously start its refresh. An adapter
    // listener would depend on insertion order and could join a pre-wake read.
    invalidateHomeAccountReadJoins(serverId);
    const rawKinds = details?.changeKinds;
    const unknownKinds = rawKinds !== undefined && (rawKinds.length === 0
        || rawKinds.some(kind => !ChangeKindSchema.safeParse(kind).success));
    const advisory = details?.source !== undefined;
    const disclosureOnly = rawKinds?.length === 1 && rawKinds[0] === 'account'
        && entityIds !== undefined && entityIds.length > 0
        && entityIds.every(id => readSavedSecretDisclosureActivityEntityIdV1(id) !== null);
    // Only a single-kind Account wake pairs every id with its kind. Ask the
    // incumbent planner what these content-free keys mean; no cursor or hint
    // is inferred and this is never materialization/checkpoint evidence.
    const accountWakePlan = (details?.source === 'catch-up-pending' || details?.source === 'socket')
        && rawKinds !== undefined && rawKinds.length > 0 && rawKinds.every(kind => kind === 'account')
        && entityIds !== undefined && entityIds.length > 0
        ? planSyncActionsFromChanges(entityIds.map(entityId => ({ kind: 'account', entityId, cursor: 0, changedAt: 0 })))
        : null;
    // Generic self/unknown keys need both incumbent readers. Authority changes
    // also retain the coarse wake that withdraws Session-record access; the
    // planner's access/list decisions must exclude those before narrowing.
    const scopedAccountPlan = accountWakePlan && accountWakePlan.unsupportedChanges.length === 0
        && !(accountWakePlan.invalidate.settings && accountWakePlan.invalidate.profile)
        && !accountWakePlan.invalidate.savedSecretResources
        && plannedChangesAffectSessionListQuery(accountWakePlan) === false ? accountWakePlan : null;
    const workflowTriggersAffect = details?.workflowTriggersAffect
        ?? (scopedAccountPlan ? plannedChangesAffectWorkflowTriggers(scopedAccountPlan) : undefined);
    const workflowDefinitionsAffect = details?.workflowDefinitionsAffect
        ?? (scopedAccountPlan ? plannedChangesAffectWorkflowDefinitions(scopedAccountPlan) : undefined);
    // Explicit record routing is produced only when no unknown Account fact
    // joined this wake. Retain its Session ids too: legacy workflow readers on
    // a secondary Home have no detailed feed cursor to recover a mixed wake.
    const coarse = unknownKinds || (advisory && (rawKinds === undefined
        || (rawKinds.includes('account') && details?.sessionSystemRecords === undefined && !disclosureOnly && !scopedAccountPlan)));
    const changeKinds = coarse ? undefined : rawKinds;
    const sessionReadinessChanges = details?.source === 'connected' || details?.source === 'snapshot'
        ? 'all' : details?.sessionReadinessChanges ?? (unknownKinds ? 'all' : accountWakePlan
            ? plannedSessionReadinessChanges(accountWakePlan) : planSessionReadinessWake(rawKinds, entityIds));
    const event = Object.freeze({
        serverId,
        sessionReadinessChanges: sessionReadinessChanges === 'all' ? 'all' as const : Object.freeze({
            sessionIds: Object.freeze([...sessionReadinessChanges.sessionIds]),
            machineIds: Object.freeze([...sessionReadinessChanges.machineIds]),
        }),
        ...(details?.source ? { source: details.source } : {}),
        ...(entityIds ? { entityIds: Object.freeze([...new Set(entityIds)]) } : {}),
        ...(details?.entityRevisions ? { entityRevisions: Object.freeze({ ...details.entityRevisions }) } : {}),
        ...(details?.workflowRunsMaterialized ? { workflowRunsMaterialized: true as const } : {}),
        ...(details?.savedSecretResourcesRefreshStarted ? { savedSecretResourcesRefreshStarted: true as const } : {}),
        ...(details?.changeKinds ? { changeKinds: Object.freeze([...new Set(details.changeKinds)]) } : {}),
        ...(details?.sessionListQueryAffects !== undefined
            ? { sessionListQueryAffects: details.sessionListQueryAffects }
            : {}),
        ...(details?.profileCatalogAffects !== undefined ? { profileCatalogAffects: details.profileCatalogAffects } : {}),
        accountSettingsAffects: details?.accountSettingsAffects ?? (details?.changeKinds === undefined
            || details.changeKinds.length === 0
            || details.changeKinds.some(kind => kind === 'account' || !ChangeKindSchema.safeParse(kind).success)),
        ...(details?.usageQueryAffects !== undefined ? { usageQueryAffects: details.usageQueryAffects } : {}),
        workflowTriggersAffect: !disclosureOnly && (details?.source === 'connected' || coarse
            || (workflowTriggersAffect ?? accountChangeKindsAffectWorkflowTriggers(changeKinds))),
        workflowDefinitionsAffect: details?.source === 'connected' || details?.source === 'snapshot'
            || (!disclosureOnly && (coarse
                || (workflowDefinitionsAffect ?? accountChangeKindsAffectWorkflowDefinitions(changeKinds)))),
        ...(details?.deletedArtifactIds ? { deletedArtifactIds: Object.freeze([...new Set(details.deletedArtifactIds)]) } : {}),
    });
    for (const [observer, { includeCatchUpPending }] of [...homeAccountChangeObservers]) {
        if (event.source === 'catch-up-pending' && !includeCatchUpPending) continue;
        try {
            observer(event);
        } catch {
            // One observer cannot suppress the wake for its siblings or for
            // this owner's own session-cache refresh.
        }
    }
    return event;
}
