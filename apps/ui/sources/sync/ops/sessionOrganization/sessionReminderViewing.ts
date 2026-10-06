import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveSessionReminderPresentation } from '@/sync/domains/session/organization/attentionStanding';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { resolveSessionOrganizationMutationScope } from './sessionOrganizationMutationOwner';
import { getStorage } from '@/sync/domains/state/storageStore';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { setSessionAttentionStanding } from './setSessionAttentionStanding';

/** A focused opening is reminder acknowledgement, independently of transcript read state. */
export function beginSessionReminderViewing(
    address: SessionAddress,
): () => void {
    const store = getStorage();
    if (store.getState().settings.sessionReminderAutoClearOnOpen === false) return () => {};
    const normalized = normalizeSessionAddress(address.serverId, address.sessionId);
    if (!normalized) return () => {};
    const { sessionId } = normalized;
    const serverId = resolveServerProfileScopeIdForIdentifier(normalized.serverId);
    if (!serverId) return () => {};
    const sessionKey = buildSessionOrganizationSessionKey(serverId, sessionId);
    const openedAt = Date.now();

    const acknowledge = () => {
        const state = store.getState();
        const record = state.sessionOrganizationAttentionStandingsBySessionKey[sessionKey];
        if (state.settings.sessionReminderAutoClearOnOpen === false || !record
            || resolveSessionReminderPresentation(record, openedAt)?.state !== 'due') return;
        fireAndForget((async () => {
            const resolved = await resolveSessionOrganizationMutationScope(serverId);
            if (!resolved.ok) throw new Error(`Cannot clear due session reminder: missing ${resolved.reason}`);
            // Credential lookup yields: preserve replacements and another pane's acknowledgement,
            // but accept an unchanged reminder whose object was refreshed by a server snapshot.
            const current = store.getState();
            const latestRecord = current.sessionOrganizationAttentionStandingsBySessionKey[sessionKey];
            if (current.settings.sessionReminderAutoClearOnOpen === false
                || !latestRecord
                || latestRecord.remindAt !== record.remindAt
                || latestRecord.standing !== record.standing
                || latestRecord.updatedAt !== record.updatedAt) return;
            await setSessionAttentionStanding({ ...resolved.scope, sessionId, remindAt: null });
        })(), { tag: 'sessionReminderViewing.clearDueReminder' });
    };

    const state = store.getState();
    if (state.sessionOrganizationAttentionStandingsBySessionKey[sessionKey]
        || state.sessionOrganizationSnapshotVersionByServerId[serverId] !== undefined) {
        acknowledge();
        return () => {};
    }
    // Cold deep links can open before organization hydration. Observe its existing load once;
    // ordinary hydrated openings need no subscription, fetch, timer, or list scan.
    const unsubscribe = store.subscribe((next) => {
        if (next.sessionOrganizationSnapshotVersionByServerId[serverId] === undefined) return;
        unsubscribe();
        acknowledge();
    });
    return unsubscribe;
}
