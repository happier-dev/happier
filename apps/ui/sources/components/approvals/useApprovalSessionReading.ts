import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { useSessionListRenderableWithServerScope } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListHomeObservation } from '@/sync/domains/session/listing/sessionListHomeObservation';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';

/**
 * The requesting session's name as every approval surface (page, Inbox row, title) reads it: the
 * canonical Session title, withheld while this device may not show the session's content. A locked
 * session's cached name stays private, so the surface says where the session lives instead.
 */
export function readApprovalSessionName(
    session: SessionListRenderableSession | Session,
    serverId: string | null,
    nowMs: number = Date.now(),
): string | null {
    if (!readSessionRecordingVisibility()({ sessionId: session.id, serverId })) return null;
    const encryption = projectUiSessionAwareness(session, nowMs).encryption;
    return encryption !== 'unknown' && isSessionAwarenessContentReadableV1(encryption)
        ? getSessionName(session, serverId)
        : null;
}

export type ApprovalSessionReadingStatus = 'none' | 'resolving' | 'ready' | 'unavailable';
export type ApprovalSessionReading = Readonly<{
    status: ApprovalSessionReadingStatus;
    session: SessionListRenderableSession | null;
    name: string | null;
    machineId: string;
    homeObservation: SessionListHomeObservation | null;
}>;

/**
 * One exact-Home requester reading for approval titles, fields and the detail context.
 *
 * A Home's Session list only settles once every page is read, and a page opened by a link mounts no
 * list. The detail therefore asks for `exactRead`: one read of the requesting Session from its Home,
 * which settles it as named or absent. Inbox rows leave their many requesters to the list.
 */
export function useApprovalSessionReading(serverId: string | null, value: string,
    resolution?: ServerCredentialAccountScopeResolution,
    options?: Readonly<{
        exactRead?: boolean;
        /** The detail already knows its Home cannot be reached: a requester it has not read cannot be read now. */
        homeUnavailable?: boolean;
    }>): ApprovalSessionReading {
    // An unresolved approval Home must not borrow the active Home's session names.
    const candidate = serverId?.trim() ? value : '';
    const row = useSessionListRenderableWithServerScope(serverId, candidate);
    const isRecordingVisible = useSessionRecordingVisibility();
    // The detail already captures a credential resolution for its decisions.
    // Fence retained rows while that authority is resolving or has retired;
    // list references keep their existing authorized-cache path without a new
    // credential read for every Inbox row.
    const session = resolution && resolution.kind !== 'bound' ? null : row;
    const scopeServerId = serverId ? resolveServerProfileScopeIdForIdentifier(serverId) : null;
    const needsExactRead = options?.exactRead === true && options.homeUnavailable !== true && Boolean(candidate && serverId) && !row
        && (!resolution || resolution.kind === 'bound') && Boolean(serverId && getServerProfileById(serverId));
    const exactRead = useHydrateSession(needsExactRead ? value : '', 'approvals.requesterSession',
        { ...(serverId ? { serverId } : {}), hydrateMessages: false });
    // Read the list owner's exact Home fact. Other Homes and non-session references
    // must not subscribe this reading to the complete Home observation map.
    const homeObservation = storage(state => !candidate || !serverId ? null
        : state.concurrentSessionListCacheByServerId[serverId]?.listObservation
            ?? (scopeServerId ? state.concurrentSessionListCacheByServerId[scopeServerId]?.listObservation : null) ?? null);
    const status: ApprovalSessionReadingStatus = !value ? 'none'
        : !candidate || !serverId ? 'unavailable'
        : session ? 'ready'
        // An unreachable Home settles the reading: waiting on it would hold a skeleton for good.
        : options?.homeUnavailable === true ? 'unavailable'
        : resolution?.kind === 'resolving' ? 'resolving'
        : (resolution && resolution.kind !== 'bound') || !getServerProfileById(serverId) ? 'unavailable'
        // A first read in flight is still resolving. One that failed and is retrying has settled for now:
        // the reference reads by where it lives until a later attempt names it, never "Loading" for good.
        : needsExactRead ? (exactRead.kind === 'loading' ? 'resolving' : 'unavailable')
        : !homeObservation || (homeObservation.lastSuccessAt === null
            && (homeObservation.phase === 'idle' || homeObservation.phase === 'loading' || homeObservation.phase === 'refreshing'))
            ? 'resolving' : 'unavailable';
    const context = { status, session, homeObservation };
    if (!session) return { ...context, name: null, machineId: '' };
    return {
        ...context,
        name: isRecordingVisible({ sessionId: session.id, serverId }) ? readApprovalSessionName(session, serverId) : null,
        machineId: readDisplayMachineIdForSession({
            serverId,
            sessionId: session.id,
            metadata: readSessionOwnerMetadataView(session),
        }),
    };
}
