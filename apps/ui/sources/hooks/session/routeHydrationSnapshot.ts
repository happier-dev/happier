import { storage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { hasAuthoritativeSessionRouteData, isHydratedSessionCurrentForListState } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionFullPublicationUpdatedAt } from '@/sync/domains/session/sessionRuntimeObservation';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';
import type { Encryption } from '@/sync/encryption/encryption';

export type SessionRouteEncryptionReader = () => ReturnType<Encryption['getSessionEncryption']>;

function readHydratedRouteServerId(sessionId: string, serverId: string | undefined, readSessionEncryption?: SessionRouteEncryptionReader): string | undefined | null {
    const state = storage.getState();
    const session = state.sessions[sessionId] ?? null;
    if (!hasAuthoritativeSessionRouteData(session) || !session) return null;
    const storedServerId = String(session.serverId ?? '').trim();
    if (serverId && !areServerProfileIdentifiersEquivalent(storedServerId, serverId)) return null;
    const rowServerId = serverId || storedServerId;
    const listRow = rowServerId
        ? readSessionListRowForServerId(state.sessionListRowsByServerId, rowServerId, sessionId)
        : null;
    if (listRow && !isHydratedSessionCurrentForListState(session, () => listRow,
        readSessionFullPublicationUpdatedAt(session))) {
        return null;
    }
    if (session.encryptionMode !== 'plain'
        && !hasAuthoritativeSessionRouteData(session, { hasSessionEncryption: false })) {
        // Only the applied Home can borrow Sync's focused reader. A foreign
        // cached row must first reach the canonical scoped hydration owner.
        if (!readSessionEncryption && rowServerId
            && !areServerProfileIdentifiersEquivalent(rowServerId, getAppliedActiveServerSnapshot().serverId)) return null;
        try {
            if (!hasAuthoritativeSessionRouteData(session, {
                hasSessionEncryption: Boolean(readSessionEncryption
                    ? readSessionEncryption()
                    : sync.encryption?.getSessionEncryption?.(sessionId)),
            })) return null;
        } catch {
            if (!hasAuthoritativeSessionRouteData(session, { hasSessionEncryption: false })) return null;
        }
    }
    return serverId || storedServerId || undefined;
}

export function readHydratedRouteSnapshot(sessionId: string, serverId?: string, readSessionEncryption?: SessionRouteEncryptionReader): boolean {
    return readHydratedRouteServerId(sessionId, serverId, readSessionEncryption) !== null;
}

export function readHydratedRouteServerSnapshot(sessionId: string, serverId?: string, readSessionEncryption?: SessionRouteEncryptionReader): string | undefined | null {
    return readHydratedRouteServerId(sessionId, serverId, readSessionEncryption);
}

export function resolveHydratedServerIdForRouteResult(
    sessionId: string,
    routeServerId: string | undefined,
    result: Extract<EnsureSessionVisibleForRouteResult, { kind: 'available' }>,
    readSessionEncryption?: SessionRouteEncryptionReader,
): string | undefined | null {
    if (result.sessionId !== sessionId) return null;
    const resultServerId = String(result.serverId ?? '').trim();
    if (routeServerId && resultServerId && !areServerProfileIdentifiersEquivalent(routeServerId, resultServerId)) return null;
    // Reuse the owner's captured reader, including for future store publications.
    return readHydratedRouteServerId(sessionId, routeServerId || resultServerId || undefined, readSessionEncryption);
}
