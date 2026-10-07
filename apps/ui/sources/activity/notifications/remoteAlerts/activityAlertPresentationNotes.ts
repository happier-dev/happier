import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveActivityTranscriptLocalIdEventIdentityV1 } from '@happier-dev/protocol/activity/eventIdentity';

import type { ActivityAlertEventKind } from './activityRemoteAlertRouting';

/**
 * Which leg last showed this device an alert for one committed event.
 *
 * This is an in-process note, not a delivery receipt: it proves nothing
 * about display, acknowledges no frontier, never advances read or Voice state,
 * says nothing about other devices, and makes no exactly-once claim. Its only
 * job is that one committed event does not produce two visible alerts on the
 * same device when a Home/rich push and this device's own local notification
 * observe it (Lane 09C §10.4 C5b step 6).
 *
 * A note exists only for a canonical committed-event identity and suppresses at
 * most one alert from the *other* leg. A ready message's existing localId and
 * committed sequence may name the same note; consumption retires both.
 * Identityless state observations are
 * deliberately never recorded or consumed: they must re-run current
 * eligibility and policy instead of being conflated by Session/category.
 */
export type ActivityAlertPresentationSource = 'home_remote_alert' | 'rich_push' | 'local_notification';

type PresentationNoteKeys = readonly [string] | readonly [string, string];
type PresentationNote = Readonly<{ source: ActivityAlertPresentationSource; keys: PresentationNoteKeys }>;

const notes = new Map<string, PresentationNote>();

function noteKey(address: SessionAddress, accountId: string, event: ActivityAlertEventKind, identity: string): string {
    return JSON.stringify([sessionAddressKey(address), accountId, event, identity]);
}

type PresentationIdentity = Readonly<{
    address: SessionAddress;
    accountId: string;
    event: ActivityAlertEventKind;
    identity: string;
    /** The same ready message's existing transport identity, not a new event id. */
    committedLocalId?: string;
    source: ActivityAlertPresentationSource;
}>;

function noteKeys(params: PresentationIdentity): PresentationNoteKeys {
    const key = noteKey(params.address, params.accountId, params.event, params.identity);
    if (params.event !== 'ready' || !params.committedLocalId) return [key];
    const localKey = noteKey(params.address, params.accountId, params.event, resolveActivityTranscriptLocalIdEventIdentityV1(params.committedLocalId));
    return key === localKey ? [key] : [key, localKey];
}

function removeNote(note: PresentationNote): void {
    for (const key of note.keys) {
        if (notes.get(key) === note) notes.delete(key);
    }
}

export function noteActivityAlertPresented(params: PresentationIdentity): void {
    // Current-state observations have no committed occurrence identity. They
    // must never create a cross-leg suppression note by accidentally folding
    // every observation into the same `undefined` key.
    if (!params.identity || !params.accountId) return;
    const keys = noteKeys(params);
    for (const key of keys) {
        const existing = notes.get(key);
        if (existing) removeNote(existing);
    }
    const note = { source: params.source, keys };
    for (const key of keys) notes.set(key, note);
}

/**
 * True when the other leg already showed this device an alert for this exact
 * event. The note is consumed, so it can never suppress a second time.
 */
export function consumeOtherLegActivityAlertPresentation(params: PresentationIdentity): boolean {
    if (!params.identity || !params.accountId) return false;
    for (const key of noteKeys(params)) {
        const note = notes.get(key);
        if (!note || note.source === params.source) continue;
        removeNote(note);
        return true;
    }
    return false;
}

export function resetActivityAlertPresentationNotesForTests(): void {
    notes.clear();
}
