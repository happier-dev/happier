import { ChangeKindSchema, HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1, isAccountCurrentnessEntityIdV1, type ChangeEntry } from '@happier-dev/protocol/changes';
import type { EphemeralUpdate } from '@happier-dev/protocol/updates';
import type { SessionSystemRecordInvalidationV1 } from '@happier-dev/protocol/sessions/board/changeHint';
import type { UpdateBody } from '@happier-dev/protocol/updates';
import { WorkflowDefinitionIdV1Schema } from '@happier-dev/protocol/workflows/workflowIdsV1';
import { readSavedSecretDisclosureActivityEntityIdV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { SessionListRowMembershipFacets } from '@/sync/domains/session/listing/sessionListQuerySelection';
import {
    areCredentialsEqual,
    subscribeHomeCredentialMutations,
    type AuthCredentials,
    type HomeCredentialMutationEvent,
} from '@/auth/storage/tokenStorage';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import { parseToken } from '@/utils/auth/parseToken';
import { areServerProfileIdentifiersEquivalent, getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
    accountChangeKindsAffectMachineResources,
    homeAccountChangeAffectsArtifactKinds,
    accountChangeKindsAffectManagedMachineInventory,
    accountChangeKindsAffectWorkflowTriggers,
    accountChangeKindsAffectWorkflowDefinitions,
    accountChangeKindsAffectWorkflowPluginSources,
    isWorkflowRunOnlyAccountChange,
    planSyncActionsFromChanges,
    planSyncActionsFromHomeWake,
    plannedChangesAffectProfileCatalog,
    plannedChangesAffectSessionListQuery,
    plannedChangesAffectUsageQuery,
    plannedChangesAffectUsageAccounting,
    plannedChangesAffectWorkflowTriggers,
    plannedChangesAffectWorkflowDefinitions,
    plannedChangesAffectWorkflowPluginSources,
    plannedWorkflowDefinitionAutomationIds,
    plannedSessionReadinessChanges,
    planSessionReadinessWake,
    type SessionReadinessChanges,
} from './changesPlanner';

/**
 * Observers of the content-free Account-change wake this owner already receives
 * on each Home socket.
 *
 * This is an observation seam over the existing wake, not a second
 * synchronization system: visible observers may demand the incumbent Home
 * connection, but start no cursor and replay no domain events. It promises no
 * delivery or ordering beyond the wake itself.
 * Account-scoped projections that are fully reconstructible (Home governance,
 * Teams, Follow preferences) use it to invalidate the exact Home and refetch.
 */
export type HomeAccountChangeEvent = Readonly<{
    serverId: string;
    /** Transport/early wake, or a real snapshot repair whose changed keys are unknown. */
    source?: 'connected' | 'catch-up-pending' | 'socket' | 'snapshot';
    /**
     * A `connected` wake or Artifact socket receipt whose publisher owns this Home's changes catch-up.
     * Absent (a secondary transport with no changes cursor): readers re-read.
     */
    changesCatchUp?: true;
    /** Advisory committed ids are routing facts, not proof that a feed page was consumed. */
    entityIds?: readonly string[];
    /** The detailed page passed planner dispatch, not a cursor checkpoint or materialization proof. */
    feedPageConsumed?: true;
    /** Revision hints from the consumed change page; never inferred from a socket wake. */
    entityRevisions?: Readonly<Record<string, number>>;
    /** The focused change applier has already published these exact Run summaries to the shared store. */
    workflowRunsMaterialized?: true;
    /** The focused applier has already fenced material and owns its awaited refresh. */
    savedSecretResourcesRefreshStarted?: true;
    /** Present when the publisher knows the changed domains; omitted wakes remain conservative. */
    changeKinds?: readonly ChangeEntry['kind'][];
    /** Complete server-visible encoded Artifact kinds; omission keeps readers conservative. */
    artifactKinds?: readonly string[];
    /** Exact content-free record/access routing; an empty list excludes record changes. */
    sessionSystemRecords?: readonly SessionSystemRecordInvalidationV1[];
    /**
     * Detailed focused-Home catch-up may publish the incumbent change planner's
     * exact Session-list decision. Secondary row-only wakes with retained membership
     * use that same planner; other socket-only wakes remain conservative.
     * `'structural'` means only row-level Session writes: a
     * corpus the ordinary list can answer is unaffected, a structural filter may move.
     */
    sessionListQueryAffects?: boolean | 'structural';
    /** Exact rows admitted by the secondary wake planner; absent retains snapshot recovery. */
    sessionRowRefreshIds?: readonly string[];
    /** With `'structural'`: the membership inputs those row writes can move. Absent stays conservative. */
    sessionListRowFacets?: SessionListRowMembershipFacets;
    /** Producer-selected readiness inputs; ordinary Session content is observed through admitted keys. */
    sessionReadinessChanges?: SessionReadinessChanges;
    /** Exact focused-page Profile/Artifact/source decision; content-free wakes omit it. */
    profileCatalogAffects?: boolean;
    /** Producer-selected publication/visible Account identity relevance, independent of private catalogs and Usage. */
    publicProfileAffects?: boolean;
    /** The focused planner's settings decision; unknown/coarse wakes remain conservative. */
    accountSettingsAffects?: boolean;
    /** Producer-admitted resource/source/access relevance; absent events remain conservative. */
    machineResourcesAffect?: boolean;
    /** Retained managed list membership/content; ordinary Machine presence does not alter it. */
    managedMachineInventoryAffect?: boolean;
    /** Canonical planner row ids; absent remains a full inventory recovery. */
    managedMachineChangedIds?: readonly string[];
    /** Exact producer domain fact; absence retains Discussion access/recovery revalidation. */
    discussionAffects?: boolean;
    /** Exact resource/source/access producer fact; absence stays conservative. */
    savedSecretCatalogAffects?: boolean;
    /** Machine-only focused pages are covered by the Usage store's material-input subscription. */
    usageQueryAffects?: boolean;
    /** False only when the focused planner proves no server accounting change since its page cursor. */
    usageAccountingAffects?: boolean;
    /** Producer-selected accounting scope; missing/native facts remain conservative. */
    usageAccountingChange?: Extract<EphemeralUpdate, { type: 'usage' }>['accountingChange'];
    /** Exact capture/status invalidation from the Machine source producer. */
    usageSourcesMachineIds?: readonly string[];
    /** The canonical planner's private trigger-read decision; status is not definition content. */
    workflowTriggersAffect?: boolean;
    /** Canonical saved-definition/trigger/access query relevance. */
    workflowDefinitionsAffect?: boolean;
    /** Machine-contributed Workflow sources; true whenever saved definitions are affected, and for Machine rows. */
    workflowPluginSourcesAffect?: boolean;
    /** Exact saved-definition candidates; the definition owner decides Artifact membership. */
    changedWorkflowDefinitionIds?: readonly string[];
    /** Present when Automation rows are the only saved-definition change: the rows showing them re-read. */
    workflowDefinitionAutomationIds?: readonly string[];
    /** An acknowledged local Artifact deletion; no replay guarantee. */
    deletedArtifactIds?: readonly string[];
    /** Already-readable titles for client-local feedback only; never sent to the server. */
    deletedArtifactTitles?: Readonly<Record<string, string>>;
}>;

type HomeAccountChangeDetails = Readonly<{
    entityRevisions?: Readonly<Record<string, number>>;
    workflowRunsMaterialized?: true;
    savedSecretResourcesRefreshStarted?: true;
    source?: 'connected' | 'catch-up-pending' | 'socket' | 'snapshot';
    changesCatchUp?: true;
    feedPageConsumed?: true;
    changeKinds?: readonly ChangeEntry['kind'][];
    artifactKinds?: readonly string[];
    sessionSystemRecords?: readonly SessionSystemRecordInvalidationV1[];
    sessionListQueryAffects?: boolean | 'structural';
    sessionListRowFacets?: SessionListRowMembershipFacets | null;
    sessionReadinessChanges?: SessionReadinessChanges;
    profileCatalogAffects?: boolean;
    publicProfileAffects?: boolean;
    accountSettingsAffects?: boolean;
    machineResourcesAffect?: boolean;
    managedMachineInventoryAffect?: boolean;
    /** Canonical planner row ids; absent remains a full inventory recovery. */
    managedMachineChangedIds?: readonly string[];
    discussionAffects?: boolean;
    savedSecretCatalogAffects?: boolean;
    usageQueryAffects?: boolean;
    /** False only when the focused planner proves no server accounting change since its page cursor. */
    usageAccountingAffects?: boolean;
    usageAccountingChange?: Extract<EphemeralUpdate, { type: 'usage' }>['accountingChange'];
    usageSourcesMachineIds?: readonly string[];
    workflowTriggersAffect?: boolean;
    workflowDefinitionsAffect?: boolean;
    workflowPluginSourcesAffect?: boolean;
    workflowDefinitionAutomationIds?: readonly string[];
    deletedArtifactIds?: readonly string[];
    deletedArtifactTitles?: Readonly<Record<string, string>>;
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
        || event.entityIds.some(isAccountCurrentnessEntityIdV1);
}

type HomeAccountChangeObserver = (event: HomeAccountChangeEvent) => void;

/**
 * How an observer treats a primary-Home reconnect wake (`connected` + `changesCatchUp`). That Home's
 * changes catch-up delivers what changed while away through its own exact publications, so a reconnect
 * is not "everything changed":
 * - omitted: the observer's data is in the changes feed; it does not hear the reconnect wake.
 * - `'refresh'`: its data can change while away outside the feed (live/runtime state); it re-reads.
 * - `readNotCurrent`: its data is in the feed, but the reconnect is its only retry after a read that
 *   failed during the outage; it hears the wake only while its own existing read state is not current.
 * A `connected` wake without a catch-up (a secondary Home transport) and every other wake reach all.
 */
export type HomeAccountReconnectClass = 'refresh' | Readonly<{ readNotCurrent: () => boolean }>;

function hearsHomeAccountChange(event: HomeAccountChangeEvent, reconnect: HomeAccountReconnectClass | undefined): boolean {
    if (event.source !== 'connected' || event.changesCatchUp !== true) return true;
    if (reconnect === undefined) return false;
    return reconnect === 'refresh' || reconnect.readNotCurrent();
}

const homeAccountChangeObservers = new Map<HomeAccountChangeObserver, Readonly<{
    includeCatchUpPending: boolean | 'recovery';
    serverIds: readonly string[];
    usageSourcesMachineIds?: readonly string[];
    reconnect?: HomeAccountReconnectClass;
    artifactKinds?: readonly string[];
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

/** A refreshed Account bearer keeps authority; replacement identity, keys and restricted credentials do not. */
export function retainsHomeAccountCredential(original: AuthCredentials | null, next: AuthCredentials | null | undefined): boolean {
    if (!original || !next) return false;
    if (areCredentialsEqual(original, next)) return true;
    if (readCredentialAuthorityKind(original.token) !== 'account' || readCredentialAuthorityKind(next.token) !== 'account') return false;
    try {
        return parseToken(original.token) === parseToken(next.token)
            && areCredentialsEqual({ ...original, token: next.token }, next);
    } catch {
        return false;
    }
}

/**
 * What one credential mutation means for its Home, decided once here for every observer:
 * `accountLeft` is sign-out, another Account or replaced keys; a same-Account bearer refresh is not.
 */
export type HomeCredentialChange = Readonly<{ accountLeft: boolean }>;
type HomeCredentialChangeObserver = (event: HomeCredentialMutationEvent, change: HomeCredentialChange) => void;
const homeCredentialChangeObservers = new Set<HomeCredentialChangeObserver>();

/**
 * The credential each Home holds, as this process last saw it. A Home holds one credential at a time,
 * so whatever was read through it belongs to that credential until this record stops retaining it.
 * `departures` counts Account departures: a read that cannot name its Account captures it before
 * issuing and refuses to land once it moved.
 */
const homeCredentialRecords = new Map<string, { credentials: AuthCredentials | null; departures: number }>();
let homeAccountDepartures = 0;
let homeCredentialMutationsObserved = false;

function recordHomeCredential(serverId: string, next: AuthCredentials | null, previousIfUnseen: AuthCredentials | null): boolean {
    const record = homeCredentialRecords.get(serverId);
    const accountLeft = !retainsHomeAccountCredential(record ? record.credentials : previousIfUnseen, next);
    if (!record) homeCredentialRecords.set(serverId, { credentials: next, departures: accountLeft ? 1 : 0 });
    else {
        record.credentials = next;
        if (accountLeft) record.departures += 1;
    }
    if (accountLeft) homeAccountDepartures += 1;
    return accountLeft;
}

function publishHomeCredentialChange(event: HomeCredentialMutationEvent, change: HomeCredentialChange): void {
    for (const current of [...homeCredentialChangeObservers]) {
        try {
            current(event, change);
        } catch {
            // One projection cannot suppress credential retirement for its siblings.
        }
    }
}

// The record must see every mutation once anything relies on it, so this one watcher stays installed.
function observeHomeCredentialMutations(): void {
    if (homeCredentialMutationsObserved) return;
    homeCredentialMutationsObserved = true;
    subscribeHomeCredentialMutations((event) => {
        const accountLeft = recordHomeCredential(resolveServerProfileScopeIdForIdentifier(event.serverId),
            event.kind === 'credentials_removed' ? null : event.credentials ?? null, event.previousCredentials ?? null);
        publishHomeCredentialChange(event, { accountLeft });
    });
}

/**
 * The one credential-mutation fan-out for reconstructible Home projections. Domains decide whether
 * to retain signed-out rows or clear replaced-Account rows; none installs its own watcher. Rows that
 * belong to an Account but not to its bearer drop only on `accountLeft`.
 */
export function subscribeHomeCredentialChange(observer: HomeCredentialChangeObserver): () => void {
    observeHomeCredentialMutations();
    homeCredentialChangeObservers.add(observer);
    return () => { homeCredentialChangeObservers.delete(observer); };
}

/** Bind a reader to the credential it just read. A record that no longer retains it is a departure. */
export function admitHomeCredential(serverId: string, credentials: AuthCredentials): void {
    observeHomeCredentialMutations();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const record = homeCredentialRecords.get(scopeId);
    if (!record) { homeCredentialRecords.set(scopeId, { credentials, departures: 0 }); return; }
    if (record.credentials && retainsHomeAccountCredential(record.credentials, credentials)) {
        record.credentials = credentials;
        return;
    }
    if (!recordHomeCredential(scopeId, credentials, null)) return;
    // Another realm (a second browser tab) changed this Home unseen: observers hear it as the write it was.
    const event = { kind: 'credentials_set', serverId: scopeId, serverUrl: getServerProfileById(scopeId)?.serverUrl ?? '' } as HomeCredentialMutationEvent;
    Object.defineProperty(event, 'credentials', { value: credentials, enumerable: false });
    publishHomeCredentialChange(event, { accountLeft: true });
}

/** Whether credentials an operation was issued with still hold for this Home. A refreshed bearer does. */
export function isHomeCredentialCurrent(serverId: string, credentials: AuthCredentials): boolean {
    observeHomeCredentialMutations();
    const record = homeCredentialRecords.get(resolveServerProfileScopeIdForIdentifier(serverId));
    return !record || retainsHomeAccountCredential(credentials, record.credentials);
}

/**
 * Account departures on this Home; a read addressed to no Home (the focused one) counts every Home's.
 * Capture before issuing a read whose cache key names no Account.
 */
export function readHomeAccountDepartures(serverId: string | null | undefined): number {
    observeHomeCredentialMutations();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    return scopeId ? homeCredentialRecords.get(scopeId)?.departures ?? 0 : homeAccountDepartures;
}

export type { HomeCredentialMutationEvent };

export function subscribeHomeAccountChange(
    observer: HomeAccountChangeObserver,
    // Most projections consume exact planned entities. Catalogs may opt into
    // early revalidation without making every observer refetch on every wake.
    options?: Readonly<{
        /** 'recovery' hears unscoped blocked-cursor recovery, leaving ordinary changes to the feed. */
        includeCatchUpPending?: boolean | 'recovery';
        /** Declares Home demand and scopes delivery; omitted or empty observes every Home. */
        serverIds?: readonly string[];
        /** Select exact source facts and recovery within the subscribed Homes. */
        usageSourcesMachineIds?: readonly string[];
        /** Exact Artifact kind hints selected by this reader; recovery and absent hints stay coarse. */
        artifactKinds?: readonly string[];
        /** This observer's primary-reconnect class; omitted means its data is covered by the changes catch-up. */
        reconnect?: HomeAccountReconnectClass;
    }>,
): () => void {
    const subscription = {
        includeCatchUpPending: options?.includeCatchUpPending ?? false,
        serverIds: (options?.serverIds ?? []).map(resolveServerProfileScopeIdForIdentifier).filter(Boolean),
        ...(options?.usageSourcesMachineIds !== undefined
            ? { usageSourcesMachineIds: [...new Set(options.usageSourcesMachineIds)] } : {}),
        ...(options?.artifactKinds !== undefined ? { artifactKinds: [...new Set(options.artifactKinds)] } : {}),
        ...(options?.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
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

export type HomeAccountChangeWake = Extract<UpdateBody, { t: 'account-change' | 'account-settings-changed' }>;

/** Both Home ingress paths retain producer facts without claiming feed materialization. */
export function publishHomeAccountChangeWake(
    serverId: string,
    wake: HomeAccountChangeWake,
    source: 'socket' | 'catch-up-pending',
    isSessionListMember?: (sessionId: string) => boolean,
): HomeAccountChangeEvent {
    if (wake.t === 'account-change') return publishHomeAccountChangeForRouting(serverId, wake.entityIds, {
        source, changeKinds: wake.changeKinds, artifactKinds: wake.artifactKinds, sessionSystemRecords: wake.sessionSystemRecords,
    }, isSessionListMember);
    // This synthetic row routes an admitted socket fact through the incumbent
    // planner only. It advances no cursor and is never checkpoint evidence.
    const planned = planSyncActionsFromChanges([{ kind: 'account', entityId: 'self', cursor: 0, changedAt: 0,
        hint: { settingsVersion: wake.settingsVersion } }]);
    return publishHomeAccountChangeForRouting(serverId, ['self'], {
        source, changeKinds: ['account'], sessionSystemRecords: [],
        sessionListQueryAffects: plannedChangesAffectSessionListQuery(planned),
        accountSettingsAffects: planned.invalidate.settings,
        profileCatalogAffects: plannedChangesAffectProfileCatalog(planned),
        publicProfileAffects: planned.invalidate.publicProfile,
        usageQueryAffects: plannedChangesAffectUsageQuery(planned),
        usageAccountingAffects: plannedChangesAffectUsageAccounting(planned),
        workflowTriggersAffect: plannedChangesAffectWorkflowTriggers(planned),
        workflowDefinitionsAffect: plannedChangesAffectWorkflowDefinitions(planned),
        workflowPluginSourcesAffect: plannedChangesAffectWorkflowPluginSources(planned),
    });
}

/** Secondary-Home routing consumes the same admitted event sent to observers. */
export function publishHomeAccountChangeForRouting(
    serverId: string,
    entityIds?: readonly string[],
    details?: HomeAccountChangeDetails,
    isSessionListMember?: (sessionId: string) => boolean,
): HomeAccountChangeEvent {
    // Advance before any consumer can synchronously start its refresh. An adapter
    // listener would depend on insertion order and could join a pre-wake read.
    invalidateHomeAccountReadJoins(serverId);
    // Admit routing once for every observer. Legacy, unknown and unqualified Account wakes
    // cannot narrow relevance before the detailed feed supplies its decisions.
    const rawKinds = details?.changeKinds;
    const unknownKinds = rawKinds !== undefined && (rawKinds.length === 0
        || rawKinds.some(kind => !ChangeKindSchema.safeParse(kind).success));
    const advisory = details?.source !== undefined;
    const disclosureOnly = rawKinds?.length === 1 && rawKinds[0] === 'account'
        && entityIds !== undefined && entityIds.length > 0
        && entityIds.every(id => readSavedSecretDisclosureActivityEntityIdV1(id) !== null);
    const workflowRunOnly = (details?.source === 'catch-up-pending' || details?.source === 'socket')
        && isWorkflowRunOnlyAccountChange(rawKinds, entityIds);
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
    // Known non-Account domains can exclude unrelated catalogs by kind. Reuse
    // the planner with conservative missing hints rather than widening every
    // Session publication into a Profile/Settings/Workflow refresh.
    const kindWakePlan = (details?.source === 'catch-up-pending' || details?.source === 'socket')
        && !unknownKinds && rawKinds?.length === 1 && rawKinds[0] !== 'account' && entityIds?.length
        // An Artifact wake's kind hints cover all of its ids; each id carries them as a feed row would.
        ? planSyncActionsFromHomeWake(entityIds.map(entityId => ({ kind: rawKinds[0]!, entityId, cursor: 0, changedAt: 0,
            ...(rawKinds[0] === 'artifact' && details?.artifactKinds !== undefined ? { hint: { artifactKinds: [...details.artifactKinds] } } : {}) })), details?.sessionSystemRecords?.length === 0, isSessionListMember) : null;
    const routingPlan = scopedAccountPlan ?? (kindWakePlan?.unsupportedChanges.length === 0 ? kindWakePlan : null);
    const readinessWakePlan = accountWakePlan ?? kindWakePlan;
    const publicProfileAffects = details?.source === 'connected' || details?.source === 'snapshot'
        || (details?.publicProfileAffects ?? (unknownKinds || rawKinds === undefined
            || (rawKinds.includes('account') && (!accountWakePlan || accountWakePlan.invalidate.publicProfile))));
    const sessionListQueryAffects = details?.sessionListQueryAffects
        ?? (routingPlan ? plannedChangesAffectSessionListQuery(routingPlan) : undefined);
    const profileCatalogAffects = details?.profileCatalogAffects
        ?? (routingPlan ? plannedChangesAffectProfileCatalog(routingPlan) : undefined);
    const accountSettingsAffects = details?.accountSettingsAffects ?? routingPlan?.invalidate.settings;
    const usageQueryAffects = details?.usageQueryAffects
        ?? (routingPlan ? plannedChangesAffectUsageQuery(routingPlan) : undefined);
    const usageAccountingAffects = details?.usageAccountingAffects
        ?? (routingPlan ? plannedChangesAffectUsageAccounting(routingPlan) : undefined);
    const workflowTriggersAffect = details?.workflowTriggersAffect
        ?? (routingPlan ? plannedChangesAffectWorkflowTriggers(routingPlan) : undefined);
    const workflowDefinitionsAffect = details?.workflowDefinitionsAffect
        ?? (routingPlan ? plannedChangesAffectWorkflowDefinitions(routingPlan) : undefined);
    const workflowPluginSourcesAffect = details?.workflowPluginSourcesAffect
        ?? (routingPlan ? plannedChangesAffectWorkflowPluginSources(routingPlan) : undefined);
    const workflowDefinitionAutomationIds = details?.workflowDefinitionsAffect !== undefined ? details.workflowDefinitionAutomationIds
        : routingPlan ? plannedWorkflowDefinitionAutomationIds(routingPlan) : undefined;
    // Explicit record routing is produced only when no unknown Account fact
    // joined this wake. Retain its Session ids too: legacy workflow readers on
    // a secondary Home have no detailed feed cursor to recover a mixed wake.
    const coarse = unknownKinds || (advisory && (rawKinds === undefined
        || (rawKinds.includes('account') && details?.sessionSystemRecords === undefined && !disclosureOnly && !scopedAccountPlan)));
    const changeKinds = coarse ? undefined : rawKinds;
    const admittedIds = coarse || (advisory && entityIds?.length === 0) ? undefined : entityIds;
    // Pair identities once at publication; consumers use these typed routing facts.
    const sessionReadinessChanges = details?.source === 'connected' || details?.source === 'snapshot'
        ? 'all' : details?.sessionReadinessChanges ?? (unknownKinds ? 'all' : readinessWakePlan
            ? plannedSessionReadinessChanges(readinessWakePlan) : planSessionReadinessWake(rawKinds, entityIds));
    const definitionsAffect = details?.source === 'connected' || details?.source === 'snapshot'
        || (!disclosureOnly && (coarse
            || (workflowDefinitionsAffect ?? accountChangeKindsAffectWorkflowDefinitions(changeKinds))));
    const event = Object.freeze({
        serverId,
        publicProfileAffects,
        sessionReadinessChanges: sessionReadinessChanges === 'all' ? 'all' as const : Object.freeze({
            sessionIds: Object.freeze([...sessionReadinessChanges.sessionIds]),
            machineIds: Object.freeze([...sessionReadinessChanges.machineIds]),
        }),
        ...(details?.source ? { source: details.source } : {}),
        ...((details?.source === 'connected' || details?.source === 'socket') && details.changesCatchUp
            ? { changesCatchUp: true as const } : {}),
        ...(admittedIds ? { entityIds: Object.freeze([...new Set(admittedIds)]) } : {}),
        ...(admittedIds?.length && changeKinds?.length && changeKinds.every(kind => kind === 'artifact')
            ? { changedWorkflowDefinitionIds: Object.freeze([...new Set(admittedIds)]
                .filter(id => WorkflowDefinitionIdV1Schema.safeParse(id).success)) } : {}),
        ...(details?.feedPageConsumed ? { feedPageConsumed: true as const } : {}),
        ...(details?.entityRevisions ? { entityRevisions: Object.freeze({ ...details.entityRevisions }) } : {}),
        ...(details?.workflowRunsMaterialized ? { workflowRunsMaterialized: true as const } : {}),
        ...(details?.savedSecretResourcesRefreshStarted ? { savedSecretResourcesRefreshStarted: true as const } : {}),
        ...(changeKinds ? { changeKinds: Object.freeze([...new Set(changeKinds)]) } : {}),
        ...(!coarse && details?.artifactKinds !== undefined
            ? { artifactKinds: Object.freeze([...details.artifactKinds]) } : {}),
        ...(details?.sessionSystemRecords !== undefined
            ? { sessionSystemRecords: Object.freeze([...details.sessionSystemRecords]) } : {}),
        ...(!coarse && sessionListQueryAffects !== undefined
            ? { sessionListQueryAffects }
            : {}),
        ...(!coarse && routingPlan?.sessionRowRefreshIds.length
            ? { sessionRowRefreshIds: Object.freeze([...routingPlan.sessionRowRefreshIds]) } : {}),
        ...(!coarse && sessionListQueryAffects === 'structural' && details?.sessionListRowFacets
            ? { sessionListRowFacets: Object.freeze({ ...details.sessionListRowFacets }) }
            : {}),
        ...(disclosureOnly ? { profileCatalogAffects: false } : !coarse && profileCatalogAffects !== undefined ? { profileCatalogAffects } : {}),
        accountSettingsAffects: !disclosureOnly && (coarse || (accountSettingsAffects ?? (changeKinds === undefined
            || changeKinds.includes('account')))),
        machineResourcesAffect: details?.source === 'connected' || details?.source === 'snapshot'
            || (details?.machineResourcesAffect ?? accountChangeKindsAffectMachineResources(rawKinds, entityIds)),
        managedMachineInventoryAffect: details?.source === 'connected' || details?.source === 'snapshot'
            // The managed list is a Machine resource: a producer that rules Machine resources out rules it out too.
            || (details?.managedMachineInventoryAffect ?? (details?.machineResourcesAffect === false ? false
                : accountChangeKindsAffectManagedMachineInventory(rawKinds, entityIds))),
        ...(details?.source !== 'connected' && details?.source !== 'snapshot' && !unknownKinds
            && details?.managedMachineChangedIds !== undefined
            ? { managedMachineChangedIds: Object.freeze([...new Set(details.managedMachineChangedIds)]) } : {}),
        // Preserve the producer's exact non-Discussion fact even when other
        // Account consumers still need a conservative, content-free wake.
        ...(details?.discussionAffects !== undefined ? { discussionAffects: details.discussionAffects }
            : workflowRunOnly ? { discussionAffects: false } : {}),
        ...(details?.savedSecretCatalogAffects !== undefined ? { savedSecretCatalogAffects: details.savedSecretCatalogAffects } : {}),
        ...(!coarse && usageQueryAffects !== undefined ? { usageQueryAffects } : {}),
        ...(usageAccountingAffects !== undefined ? { usageAccountingAffects } : {}),
        ...(details?.usageAccountingChange !== undefined
            ? { usageAccountingChange: Object.freeze({ ...details.usageAccountingChange }) } : {}),
        ...(details?.usageSourcesMachineIds !== undefined
            ? { usageSourcesMachineIds: Object.freeze([...new Set(details.usageSourcesMachineIds)]) } : {}),
        workflowTriggersAffect: !disclosureOnly && (details?.source === 'connected' || coarse
            || (workflowTriggersAffect ?? accountChangeKindsAffectWorkflowTriggers(changeKinds))),
        workflowDefinitionsAffect: definitionsAffect,
        // Saved definitions carry their plugin sources; a Machine row can change only the sources.
        workflowPluginSourcesAffect: definitionsAffect || (!disclosureOnly
            && (workflowPluginSourcesAffect ?? accountChangeKindsAffectWorkflowPluginSources(changeKinds))),
        ...(definitionsAffect && !coarse && details?.source !== 'connected' && details?.source !== 'snapshot'
            && workflowDefinitionAutomationIds?.length
            ? { workflowDefinitionAutomationIds: Object.freeze([...new Set(workflowDefinitionAutomationIds)]) } : {}),
        ...(details?.deletedArtifactIds ? { deletedArtifactIds: Object.freeze([...new Set(details.deletedArtifactIds)]) } : {}),
        ...(details?.deletedArtifactTitles ? { deletedArtifactTitles: Object.freeze({ ...details.deletedArtifactTitles }) } : {}),
    });
    for (const [observer, { includeCatchUpPending, serverIds, usageSourcesMachineIds, reconnect, artifactKinds }] of [...homeAccountChangeObservers]) {
        if (serverIds.length > 0 && !serverIds.some(serverId => areServerProfileIdentifiersEquivalent(serverId, event.serverId))) continue;
        if (event.source === 'catch-up-pending' && !includeCatchUpPending) continue;
        if (includeCatchUpPending === 'recovery' && ((event.source === 'catch-up-pending' && event.entityIds !== undefined)
            || (event.source === 'socket' && event.changesCatchUp === true))) continue;
        if (artifactKinds !== undefined && !homeAccountChangeAffectsArtifactKinds(event, artifactKinds)) continue;
        if (usageSourcesMachineIds !== undefined) {
            if (event.source !== 'connected' && event.source !== 'snapshot'
                && !event.usageSourcesMachineIds?.some(machineId => usageSourcesMachineIds.includes(machineId))) continue;
        }
        try {
            if (!hearsHomeAccountChange(event, reconnect)) continue;
            observer(event);
        } catch {
            // One observer cannot suppress the wake for its siblings or for
            // this owner's own session-cache refresh.
        }
    }
    return event;
}
