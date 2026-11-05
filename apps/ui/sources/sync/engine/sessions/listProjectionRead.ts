import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { log } from '@/log';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';
import { sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Encryption } from '@/sync/encryption/encryption';
import { createOperationAccountCurrentnessSource, fetchSessionByIdWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import { captureSessionListRetirementFence, wasSessionRetiredSinceFence } from '@/sync/store/domains/sessions';
import { createSessionReadObservation } from './snapshotMembership';
import type { SessionListRowPublication } from './sessionById';

/** Shared ongoing-read inventory; full-route consumers never borrow a list projection. */
export type SessionReadInFlightEntry = Readonly<{
    sessionId: string;
    serverId: string | undefined;
    accountId: string;
    encryption: Encryption | null;
    isCurrent(): boolean;
    invalidate(): void;
} & (
    | { kind: 'full'; promise: Promise<EnsureSessionVisibleForRouteResult>;
        readSessionEncryption(): ReturnType<Encryption['getSessionEncryption']> }
    | { kind: 'list-projection'; promise: Promise<void> }
)>;

type ScopedRead = Parameters<typeof fetchSessionByIdWithServerScope>[0];
type ListProjectionReadInput = Pick<ScopedRead,
    'sessionDataKeys' | 'sessionDataKeyEnvelopes' | 'activeReadTransport' | 'authority'> & Readonly<{
    activeCredentials: AuthCredentials;
    activeEncryption: Encryption | null;
    activeRequest: NonNullable<ScopedRead['activeRequest']>;
    applySessions: NonNullable<ScopedRead['applySessions']>;
}>;

function applyRows(entries: readonly SessionListRowPublication[]): void {
    const byServer = new Map<string, SessionListRenderableSession[]>();
    for (const { serverId, row } of entries) {
        const rows = byServer.get(serverId) ?? [];
        rows.push(row);
        byServer.set(serverId, rows);
    }
    for (const [serverId, rows] of byServer) storage.getState().applyServerScopedSessionListRows(serverId, rows, {
        source: 'rowOnly', mode: 'append',
    });
}

/** Exact offscreen reads share the full-route snapshot/access lifetime without opening content. */
export async function refreshSessionListProjection(params: Readonly<{
    serverId: string;
    sessionId: string;
    accountId: string;
    contentDemand?: 'list-projection' | 'list-display';
    read: ListProjectionReadInput;
    pendingReads: Map<string, SessionReadInFlightEntry>;
    isScopeCurrent(): boolean;
    retireSession(): void;
    deferHydration(): void;
    currentnessSource?: ReturnType<typeof createOperationAccountCurrentnessSource>;
}>): Promise<void> {
    const { serverId, sessionId, accountId } = params;
    const inFlightKey = `${params.contentDemand ?? 'list-projection'}:${JSON.stringify([serverId, accountId, sessionId])}`;
    const existing = params.pendingReads.get(inFlightKey);
    if (existing?.kind === 'list-projection') {
        if (existing.isCurrent()) return existing.promise;
        existing.invalidate();
    }
    const snapshotRead = createSessionReadObservation();
    const retirementFence = captureSessionListRetirementFence();
    let readCurrent = true;
    const currentness = params.currentnessSource ?? createOperationAccountCurrentnessSource({
        credentials: params.read.activeCredentials, request: params.read.activeRequest, serverId,
    });
    const isReadScopeCurrent = () => readCurrent && params.isScopeCurrent();
    const isCurrent = () => isReadScopeCurrent()
        && currentness.isCurrent() && !wasSessionRetiredSinceFence(retirementFence, serverId, sessionId);
    const readExistingSession = (id: string): Session | null => {
        const session = storage.getState().sessions[id];
        return session && areServerProfileIdentifiersEquivalent(session.serverId, serverId) ? session : null;
    };
    const inFlight = (async () => {
        try {
            const result = await fetchSessionByIdWithServerScope({
                ...params.read, sessionId, serverId, contentDemand: params.contentDemand ?? 'list-projection',
                accountCurrentnessSource: currentness, includeTurnsProjection: false,
                applySessions: sessions => { if (isCurrent()) params.read.applySessions(sessions); },
                applySessionListRows: applyRows,
                getExistingSession: readExistingSession,
                getCurrentSessionListRenderable: id => readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, serverId, id),
                onSessionObservation: snapshotRead.observe, isCurrent, log,
            });
            if (!isReadScopeCurrent()) return;
            if (!isCurrent()) throw new Error('Session projection AccountChange scope changed during refresh');
            if (!result.ok) {
                if (result.errorCode === 'not_found') { params.retireSession(); return; }
                throw new Error(`Session projection refresh failed: ${result.errorCode ?? 'unknown'}`);
            }
            if (!result.sessionListRenderable) throw new Error('Session projection refresh returned no row');
            const cursor = snapshotRead.read()?.observationCursor;
            const address = normalizeSessionAddress(serverId, sessionId);
            if (address && cursor !== undefined) sessionRuntimeObservations.recordServerObservation(address, cursor, result.sessionListRenderable, accountId);
            if (readExistingSession(sessionId)) params.deferHydration();
        } catch (error) {
            // A replacement owns the next publication. Local demand/scope
            // retirement yields; current Account/access failures still reject.
            if (isReadScopeCurrent()) throw error;
        } finally { if (!params.currentnessSource) currentness.dispose(); }
    })();
    const entry: SessionReadInFlightEntry = Object.freeze({
        kind: 'list-projection', sessionId, serverId, accountId, encryption: params.read.activeEncryption,
        isCurrent, promise: inFlight,
        invalidate: () => { readCurrent = false; },
    });
    params.pendingReads.set(inFlightKey, entry);
    try { await inFlight; }
    finally { if (params.pendingReads.get(inFlightKey) === entry) params.pendingReads.delete(inFlightKey); }
}
