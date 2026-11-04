import { storage } from '@/sync/domains/state/storageStore';
import { listSessionListLookupServerSessions } from '@/sync/domains/session/listing/sessionListLookupState';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { projectSessionSelectionRows, type SessionSelectionCandidate } from './projectSessionSelectionRows';
import { sortSessionSelectionCandidates } from './sortSessionSelectionCandidates';
import { getFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import { readSessionMruOrder } from '@/sync/domains/session/navigation/recentSessions';
import { isWritableSessionSelectionCandidate } from './sessionSelectionCandidates';
import { areSessionAddressesEqual } from '@/sync/domains/session/sessionAddress';
import type { SessionChooserPage } from './sessionChooserSource';

export type SessionChooserPageRequest = Readonly<{ query: string; offset: number; limit: number }>;

export function readSessionSelectionSnapshot(): readonly SessionSelectionCandidate[] {
    return listSessionListLookupServerSessions(storage.getState())
        .map(({ session, serverId }) => ({ ...session, serverId }));
}

/** A request-time snapshot, deliberately without a live subscription. */
export function readSessionChooserPage(request: SessionChooserPageRequest): SessionChooserPage {
    const query = request.query.trim().toLocaleLowerCase();
    const focusedSession = getFocusedSessionAddress();
    const candidates = sortSessionSelectionCandidates(readSessionSelectionSnapshot().filter(isWritableSessionSelectionCandidate).filter(session =>
        !query || getSessionName(session).toLocaleLowerCase().includes(query),
    ), { focusedSession, mruOrder: readSessionMruOrder() });
    const page = candidates.slice(request.offset, request.offset + request.limit);
    return { rows: projectSessionSelectionRows(page, {
        includeServerName: new Set(candidates.map(session => session.serverId)).size > 1, requireImageInput: true,
    }).map(row => ({ ...row, group: areSessionAddressesEqual(row.address, focusedSession) ? 'focused' : 'recent' })),
        total: candidates.length };
}
