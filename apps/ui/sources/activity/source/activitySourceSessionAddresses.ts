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
