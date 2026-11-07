import { listSessionListLookupServerSessions } from '@/sync/domains/session/listing/sessionListLookupState';
import { isSessionListQueryHomeCoverageComplete } from '@/sync/domains/session/listing/sessionListHomeObservation';
import { normalizeSessionAddress, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { SessionListRenderableDelta } from '@/sync/store/domains/sessionListIndexFinalization';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { readActivityPersonalRuleSnapshot } from './readActivitySessionRulePolicies';

function createAddressAdmission(source: ActivityAttentionSource) {
    const personal = new Map(Object.entries(source.personalSessionListMembershipByServerId ?? {}).map(([serverId, ids]) => [serverId, new Set(ids)]));
    const authoritative = new Set<string>();
    for (const serverId of Object.keys(source.personalSessionListMembershipByServerId ?? {})) {
        const state = source.personalSessionListQueryStatesByServerId?.[serverId];
        if (state && isSessionListQueryHomeCoverageComplete({ state, requestedQueryKey: state.requestedQueryKey })) authoritative.add(serverId);
    }
    const ruleSource = { personalFollowRulesByServerId: source.personalFollowRulesByServerId };
    const rule = new Map(Object.entries(source.ruleSessionMembershipByServerId ?? {}).flatMap(([serverId, ids]) => {
        const snapshot = readActivityPersonalRuleSnapshot(ruleSource, serverId);
        const scope = source.audienceScopes?.get(serverId);
        if (snapshot?.status !== 'ready' || scope && snapshot.accountId !== scope.accountId
            || !snapshot.rules.some(candidate => candidate.receiver.kind === 'account' && candidate.definition.enabled)) return [];
        return [[serverId, new Set(ids)] as const];
    }));
    const ordinaryAdmitted = (address: SessionAddress) => {
        if (!authoritative.has(address.serverId) || personal.get(address.serverId)?.has(address.sessionId)) return true;
        const rules = readActivityPersonalRuleSnapshot(ruleSource, address.serverId);
        return rules?.status === 'ready' && (rules.rules.some(rule => rule.receiver.kind === 'account' && rule.definition.enabled)
            || Object.values(rules.defaultPreferences ?? {}).some(Boolean));
    };
    return { personal, rule, ordinaryAdmitted };
}

function voiceAddress(source: ActivityAttentionSource, sessionId: string) {
    const session = source.sessionsById[sessionId];
    return session && isVoiceConversationCustodySessionMetadata(readSessionOwnerMetadataView(session))
        ? normalizeSessionAddress(session.serverId ?? (source.activeServer?.serverId ?? source.activeServerId), session.id) : null;
}

function collectAddresses(source: ActivityAttentionSource, includeWarmSourceWhenNotReady: boolean, admission: ReturnType<typeof createAddressAdmission>) {
    const addresses = new Map<string, SessionAddress>();
    const add = (address: SessionAddress) => { addresses.set(sessionAddressKey(address), address); };
    if (source.isDataReady || includeWarmSourceWhenNotReady) {
        for (const entry of listSessionListLookupServerSessions({ sessions: source.sessionsById,
            sessionListRowsByServerId: source.sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId: source.ordinarySessionListMembershipByServerId,
            sessionListIndexByServerId: source.sessionListIndexByServerId,
            concurrentSessionListCacheByServerId: source.concurrentSessionListCacheByServerId })) {
            const address = normalizeSessionAddress(entry.serverId, entry.session.id);
            if (address && admission.ordinaryAdmitted(address)) add(address);
        }
        for (const [serverId, ids] of admission.personal) for (const id of ids) {
            const address = normalizeSessionAddress(serverId, id);
            if (address) add(address);
        }
        for (const [serverId, ids] of admission.rule) for (const id of ids) {
            const address = normalizeSessionAddress(serverId, id);
            if (address) add(address);
        }
        for (const id in source.sessionsById) if (Object.prototype.hasOwnProperty.call(source.sessionsById, id)) {
            const address = voiceAddress(source, id);
            if (address) add(address);
        }
    }
    return [...addresses.values()];
}

/** The same exact-Home candidacy policy for complete discovery and changed-address reads. */
export function createActivitySourceSessionAddressProjection(source: ActivityAttentionSource, includeWarmSourceWhenNotReady: boolean) {
    const admission = createAddressAdmission(source);
    const ordinary = new Map(Object.entries(source.ordinarySessionListMembershipByServerId ?? {}).map(([serverId, ids]) => [serverId, new Set(ids)]));
    const addressesById = new Map<string, Map<string, SessionAddress>>();
    const addressesInOrder = new Map<string, SessionAddress>();
    const add = (address: SessionAddress) => {
        const homes = addressesById.get(address.sessionId) ?? new Map<string, SessionAddress>();
        homes.set(address.serverId, address);
        addressesById.set(address.sessionId, homes);
        addressesInOrder.set(sessionAddressKey(address), address);
    };
    for (const address of collectAddresses(source, includeWarmSourceWhenNotReady, admission)) add(address);
    return {
        all: () => [...addressesInOrder.values()],
        /** Delta metadata is produced by the membership writer, never inferred from a cached row. */
        update(next: ActivityAttentionSource, delta: SessionListRenderableDelta) {
            const ids = new Set([...delta.changedSessionIds, ...delta.removedSessionIds]);
            const affectedHomes = new Map<string, Set<string>>();
            for (const change of delta.ordinaryMembershipChanges ?? []) {
                const membership = ordinary.get(change.serverId) ?? new Set<string>();
                ordinary.set(change.serverId, membership);
                for (const id of change.removedSessionIds) membership.delete(id);
                for (const id of change.addedSessionIds) membership.add(id);
                for (const id of [...change.addedSessionIds, ...change.removedSessionIds]) {
                    ids.add(id);
                    const homes = affectedHomes.get(id) ?? new Set<string>();
                    homes.add(change.serverId);
                    affectedHomes.set(id, homes);
                }
            }
            const changed: SessionAddress[] = [];
            const removed: SessionAddress[] = [];
            for (const id of ids) {
                const before = addressesById.get(id);
                const voice = voiceAddress(next, id);
                const homes = new Set([...(before?.keys() ?? []), ...(affectedHomes.get(id) ?? []), ...(voice ? [voice.serverId] : [])]);
                for (const serverId of homes) {
                    const address = normalizeSessionAddress(serverId, id);
                    if (!address) continue;
                    const candidate = admission.personal.get(serverId)?.has(id) || admission.rule.get(serverId)?.has(id)
                        || voice?.serverId === serverId
                        || ordinary.get(serverId)?.has(id) && next.sessionListRowsByServerId[serverId]?.[id] && admission.ordinaryAdmitted(address);
                    if (candidate) { add(address); changed.push(address); }
                    else if (before?.has(serverId)) {
                        before.delete(serverId);
                        addressesInOrder.delete(sessionAddressKey(address));
                        removed.push(address);
                    }
                }
                if (addressesById.get(id)?.size === 0) addressesById.delete(id);
            }
            return { addresses: changed, removed };
        },
    };
}

export function collectActivitySourceSessionAddresses(source: ActivityAttentionSource, includeWarmSourceWhenNotReady: boolean): readonly SessionAddress[] {
    return collectAddresses(source, includeWarmSourceWhenNotReady, createAddressAdmission(source));
}

/** Row collections the store's changed-id publication describes; every other source fact is policy. */
const ACTIVITY_SOURCE_ROW_FIELDS: ReadonlySet<string> = new Set<keyof ActivityAttentionSource>([
    'sessionsById', 'sessionListRowsByServerId', 'ordinarySessionListMembershipByServerId', 'sessionListIndexByServerId',
    // Rebuilt from the concurrent cache and query states, which are compared as policy.
    'sessionListHomeObservationByServerId',
]);

function isSameActivitySourcePolicy(previous: ActivityAttentionSource, next: ActivityAttentionSource): boolean {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof ActivityAttentionSource>;
    for (const key of keys) {
        if (!ACTIVITY_SOURCE_ROW_FIELDS.has(key) && !Object.is(previous[key], next[key])) return false;
    }
    return true;
}

type ActivitySourceAddressDeltaState = Readonly<{ sessionListRenderableDelta?: SessionListRenderableDelta }>;

/**
 * One Activity projection kept per Session address. A store publication whose policy is unchanged and
 * whose changed-id revision is the next one re-classifies only the changed addresses through the same
 * address owner; anything else (a policy change, a revision gap, a row change without a revision step)
 * rebuilds from complete discovery. `classify` decides an exact address subset and returns an entry
 * for every admitted address; an address it leaves out is no longer a candidate.
 */
export function createActivitySourceAddressTable<T>(params: Readonly<{
    includeWarmSourceWhenNotReady: boolean;
    classify: (source: ActivityAttentionSource, addresses: readonly SessionAddress[]) => ReadonlyMap<string, T>;
    /** An equal re-classification keeps the previous entry, so consumers keep its identity. */
    isSame?: (previous: T, next: T) => boolean;
    /** Every entry that is added, replaced or removed. */
    onChange?: (key: string, previous: T | undefined, next: T | undefined) => void;
}>) {
    let previousSource: ActivityAttentionSource | null = null;
    let previousRevision: number | null = null;
    let projection: ReturnType<typeof createActivitySourceSessionAddressProjection> | null = null;
    const entries = new Map<string, T>();
    let moved = false;
    const set = (key: string, next: T | undefined) => {
        const previous = entries.get(key);
        if (previous === next || (previous !== undefined && next !== undefined && params.isSame?.(previous, next))) return;
        moved = true;
        if (next === undefined) entries.delete(key);
        else entries.set(key, next);
        params.onChange?.(key, previous, next);
    };
    return {
        entries: (): ReadonlyMap<string, T> => entries,
        /** The source owner found nothing Activity reads in this publication: the table is current at its revision. */
        observeUnchangedSource(state: ActivitySourceAddressDeltaState): void {
            if (previousSource) previousRevision = state.sessionListRenderableDelta?.revision ?? null;
        },
        /** Returns whether any entry changed. */
        update(source: ActivityAttentionSource, state: ActivitySourceAddressDeltaState): boolean {
            const delta = state.sessionListRenderableDelta;
            const revision = delta?.revision ?? null;
            if (previousSource === source) {
                // The source owner found nothing Activity reads in these rows: the table is current at this revision.
                previousRevision = revision;
                return false;
            }
            const incremental = previousSource !== null && projection !== null && delta !== undefined
                && previousRevision !== null && revision === previousRevision + 1
                && isSameActivitySourcePolicy(previousSource, source)
                && (delta.ordinaryMembershipChanges !== undefined
                    || previousSource.ordinarySessionListMembershipByServerId === source.ordinarySessionListMembershipByServerId);
            previousSource = source;
            previousRevision = revision;
            moved = false;
            if (incremental && projection && delta) {
                // A hydrated Session can change what its address resolves to without a row change.
                const changed = projection.update(source, delta.hydratedSessionIds?.length
                    ? { ...delta, changedSessionIds: [...delta.changedSessionIds, ...delta.hydratedSessionIds] } : delta);
                const classified = params.classify(source, changed.addresses);
                for (const address of [...changed.addresses, ...changed.removed]) {
                    const key = sessionAddressKey(address);
                    set(key, classified.get(key));
                }
                return moved;
            }
            projection = createActivitySourceSessionAddressProjection(source, params.includeWarmSourceWhenNotReady);
            const classified = params.classify(source, projection.all());
            for (const key of [...entries.keys()]) if (!classified.has(key)) set(key, undefined);
            for (const [key, value] of classified) set(key, value);
            return moved;
        },
    };
}
