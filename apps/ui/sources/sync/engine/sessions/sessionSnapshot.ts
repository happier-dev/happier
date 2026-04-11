import { type V2SessionListResponse } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import type { Session } from '@/sync/domains/state/storageTypes';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { preserveSessionRuntimeLocalMetadata } from '@/sync/domains/session/preserveSessionRuntimeLocalMetadata';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';

import { parsePlainSessionAgentState, parsePlainSessionMetadata } from './parsePlainSessionPayload';
import { fetchSessionListPageCompat } from './sessionHttpCompat';

type SessionEncryption = {
    decryptAgentState: (version: number, value: string | null) => Promise<any>;
    decryptMetadata: (version: number, value: string) => Promise<any>;
};

export type SessionListEncryption = {
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: (sessionKeys: Map<string, Uint8Array | null>) => Promise<void>;
    getSessionEncryption: (sessionId: string) => SessionEncryption | null;
};

type SessionListRow = V2SessionListResponse['sessions'][number];

function normalizeAccessLevel(accessLevel: unknown): 'view' | 'edit' | 'admin' | undefined {
    return accessLevel === 'view' || accessLevel === 'edit' || accessLevel === 'admin' ? accessLevel : undefined;
}

function buildRenderableFromRowAndCache(
    row: SessionListRow,
    cachedEntry: SessionListCacheEntryV1 | undefined,
): SessionListRenderableSession {
    const agentStateMatches = cachedEntry?.agentStateVersion === row.agentStateVersion;

    const hasPendingPermissionRequests =
        typeof row.pendingPermissionRequestCount === 'number'
            ? row.pendingPermissionRequestCount > 0
            : agentStateMatches
                ? cachedEntry?.hasPendingPermissionRequests === true
                : undefined;
    const hasPendingUserActionRequests =
        typeof row.pendingUserActionRequestCount === 'number'
            ? row.pendingUserActionRequestCount > 0
            : agentStateMatches
                ? cachedEntry?.hasPendingUserActionRequests === true
                : undefined;
    const cachedRenderableMetadata = cachedEntry
        ? {
            name: cachedEntry.name,
            summaryText: cachedEntry.summaryText ?? null,
            path: cachedEntry.path,
            homeDir: cachedEntry.homeDir ?? null,
            host: cachedEntry.host ?? null,
            machineId: cachedEntry.machineId ?? null,
            flavor: cachedEntry.flavor ?? null,
            directSessionV1: cachedEntry.directSessionV1 ?? null,
            hiddenSystemSession: cachedEntry.hiddenSystemSession === true,
        }
        : null;

    return {
        id: row.id,
        seq: row.seq,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        active: row.active,
        activeAt: row.activeAt,
        archivedAt: row.archivedAt ?? null,
        pendingCount: row.pendingCount,
        pendingVersion: row.pendingVersion,
        metadataVersion: row.metadataVersion,
        agentStateVersion: row.agentStateVersion,
        metadata: cachedRenderableMetadata,
        thinking: false,
        thinkingAt: 0,
        presence: row.active ? 'online' : row.activeAt,
        accessLevel: normalizeAccessLevel(row.share?.accessLevel),
        canApprovePermissions: row.share?.canApprovePermissions ?? undefined,
        hasPendingPermissionRequests,
        hasPendingUserActionRequests,
    };
}

function buildRenderableFromCachedEntry(cachedEntry: SessionListCacheEntryV1): SessionListRenderableSession {
    return {
        id: cachedEntry.sessionId,
        seq: 0,
        createdAt: cachedEntry.createdAt,
        updatedAt: cachedEntry.updatedAt,
        active: cachedEntry.active,
        activeAt: cachedEntry.activeAt,
        archivedAt: cachedEntry.archivedAt ?? null,
        pendingCount: cachedEntry.pendingCount,
        pendingVersion: cachedEntry.pendingVersion,
        metadataVersion: cachedEntry.metadataVersion,
        agentStateVersion: cachedEntry.agentStateVersion,
        metadata: {
            name: cachedEntry.name,
            summaryText: cachedEntry.summaryText ?? null,
            path: cachedEntry.path,
            homeDir: cachedEntry.homeDir ?? null,
            host: cachedEntry.host ?? null,
            machineId: cachedEntry.machineId ?? null,
            flavor: cachedEntry.flavor ?? null,
            directSessionV1: cachedEntry.directSessionV1 ?? null,
            hiddenSystemSession: cachedEntry.hiddenSystemSession === true,
        },
        thinking: false,
        thinkingAt: 0,
        presence: cachedEntry.active ? 'online' : cachedEntry.activeAt,
        accessLevel: cachedEntry.accessLevel,
        canApprovePermissions: cachedEntry.canApprovePermissions,
        hasPendingPermissionRequests: cachedEntry.hasPendingPermissionRequests,
        hasPendingUserActionRequests: cachedEntry.hasPendingUserActionRequests,
    };
}

function needsWarmHydration(params: {
    row: SessionListRow;
    cachedEntry: SessionListCacheEntryV1 | undefined;
    existingSession?: Session | null | undefined;
}): boolean {
    if (!params.existingSession) return true;
    const { row, cachedEntry } = params;
    if (!cachedEntry) return true;
    if (cachedEntry.metadataVersion !== row.metadataVersion) return true;
    if (cachedEntry.agentStateVersion !== row.agentStateVersion) return true;
    return false;
}

function orderRowsForWarmHydration(params: {
    rows: SessionListRow[];
    prioritizedSessionIds?: ReadonlyArray<string>;
    eagerHydrationCount?: number;
}): SessionListRow[] {
    if (params.rows.length <= 1) return params.rows;

    const prioritizedSessionIds = (params.prioritizedSessionIds ?? [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);
    const prioritizedIndexById = new Map(prioritizedSessionIds.map((id, index) => [id, index]));
    const eagerHydrationCount = Math.max(0, Math.trunc(params.eagerHydrationCount ?? 0));

    const prioritizedRows = params.rows
        .filter((row) => prioritizedIndexById.has(row.id))
        .sort((left, right) => (prioritizedIndexById.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (prioritizedIndexById.get(right.id) ?? Number.MAX_SAFE_INTEGER));

    const remainingRows = params.rows.filter((row) => !prioritizedIndexById.has(row.id));
    if (eagerHydrationCount <= 0) {
        return [...prioritizedRows, ...remainingRows];
    }

    return [
        ...prioritizedRows,
        ...remainingRows.slice(0, eagerHydrationCount),
        ...remainingRows.slice(eagerHydrationCount),
    ];
}

async function decryptSessionRow(
    row: SessionListRow,
    encryption: SessionListEncryption,
    serverId?: string | null,
    cachedEntry?: SessionListCacheEntryV1,
): Promise<(Omit<Session, 'presence'> & { presence?: 'online' | number }) | null> {
    const encryptionMode: 'e2ee' | 'plain' = row.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = encryption.getSessionEncryption(row.id);
    if (encryptionMode === 'e2ee' && !sessionEncryption) {
        console.error(`Session encryption not found for ${row.id} - this should never happen`);
        return null;
    }

    try {
        const metadata =
            encryptionMode === 'plain'
                ? parsePlainSessionMetadata(row.metadata)
                : await sessionEncryption!.decryptMetadata(row.metadataVersion, row.metadata);
        const mergedMetadata = preserveSessionRuntimeLocalMetadata(
            cachedEntry
                ? {
                    path: cachedEntry.path,
                    homeDir: cachedEntry.homeDir ?? undefined,
                    host: cachedEntry.host ?? undefined,
                    machineId: cachedEntry.machineId ?? undefined,
                    flavor: cachedEntry.flavor ?? undefined,
                    directSessionV1: cachedEntry.directSessionV1 ?? undefined,
                }
                : null,
            metadata,
        );

        const agentState =
            encryptionMode === 'plain'
                ? parsePlainSessionAgentState(row.agentState)
                : await sessionEncryption!.decryptAgentState(row.agentStateVersion, row.agentState);

        return {
            ...row,
            serverId: typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : undefined,
            encryptionMode,
            thinking: false,
            thinkingAt: 0,
            metadata: mergedMetadata,
            agentState,
            accessLevel: normalizeAccessLevel(row.share?.accessLevel),
            canApprovePermissions: row.share?.canApprovePermissions ?? undefined,
            presence: row.active ? 'online' : row.activeAt,
        };
    } catch (error) {
        console.error(`[sessionsSnapshot] Failed to decrypt session ${row.id}`, error);
        return null;
    }
}

function applyHydratedSessions(params: {
    sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>;
    applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
    getExistingSession?: (sessionId: string) => Session | null | undefined;
}): void {
    if (params.sessions.length === 0) return;
    const previousSessionsById = new Map<string, Session | null | undefined>();
    for (const session of params.sessions) {
        previousSessionsById.set(session.id, params.getExistingSession?.(session.id));
    }
    params.applySessions(params.sessions);
    for (const session of params.sessions) {
        reportNewAgentRequestsFromSessionTransition(previousSessionsById.get(session.id), session as Session);
    }
}

function scheduleReadStateRepair(params: {
    sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>;
    repairInvalidReadStateV1: (params: { sessionId: string; sessionSeqUpperBound: number }) => Promise<void>;
}): void {
    void (async () => {
        for (const session of params.sessions) {
            try {
                const readState = session.metadata?.readStateV1;
                if (!readState) continue;
                if (readState.sessionSeq <= (session.seq ?? 0)) continue;
                await params.repairInvalidReadStateV1({ sessionId: session.id, sessionSeqUpperBound: session.seq ?? 0 });
            } catch (err) {
                console.error('[sessionsSnapshot] Failed to repair invalid readStateV1', { sessionId: session.id, err });
            }
        }
    })().catch((err) => {
        console.error('[sessionsSnapshot] Invalid readStateV1 repair loop failed', { err });
    });
}

export async function fetchAndApplySessions(params: {
    serverId?: string | null;
    credentials: AuthCredentials;
    encryption: SessionListEncryption;
    sessionDataKeys: Map<string, Uint8Array>;
    request?: (path: string, init: RequestInit) => Promise<Response>;
    applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
    onSnapshotFetched?: (sessionIds: string[]) => void;
    applySessionListRenderables?: (sessions: SessionListRenderableSession[], options?: { replace?: boolean }) => void;
    cachedSessionListEntries?: Record<string, SessionListCacheEntryV1>;
    prioritizeSessionIds?: ReadonlyArray<string>;
    sessionListEagerHydrationCount?: number;
    sessionListHydrationConcurrencyLimit?: number;
    getExistingSession?: (sessionId: string) => Session | null | undefined;
    shouldContinue?: () => boolean;
    repairInvalidReadStateV1: (params: { sessionId: string; sessionSeqUpperBound: number }) => Promise<void>;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { credentials, encryption, sessionDataKeys, applySessions, repairInvalidReadStateV1, log } = params;
    const request =
        params.request
        ?? ((path: string, init: RequestInit) => serverFetch(path, init, { includeAuth: false }));

    const SESSION_LIST_LIMIT = 150;
    const sessions: V2SessionListResponse['sessions'] = [];
    const concurrencyLimit = Math.max(1, Math.trunc(params.sessionListHydrationConcurrencyLimit ?? 4));
    let usedLegacyV1Snapshot = false;

    let cursor: string | null = null;
    while (sessions.length < SESSION_LIST_LIMIT) {
        const pageLimit = Math.min(200, SESSION_LIST_LIMIT - sessions.length);
        const page = await fetchSessionListPageCompat({
            request,
            token: credentials.token,
            cursor,
            limit: pageLimit,
        });

        for (const row of page.sessions) {
            sessions.push(row);
        }
        if (page.source === 'v1') {
            usedLegacyV1Snapshot = true;
        }

        if (!page.hasNext || !page.nextCursor || page.source === 'v1') break;
        cursor = page.nextCursor;
    }

    const sessionKeys = new Map<string, Uint8Array | null>();
    const keyResults = await runTasksWithLimit(
        sessions.map((session) => async () => {
            if (!session.dataEncryptionKey) {
                return { sessionId: session.id, decryptedKey: null as Uint8Array | null, hasEnvelope: false };
            }
            try {
                const decryptedKey = await encryption.decryptEncryptionKey(session.dataEncryptionKey);
                return { sessionId: session.id, decryptedKey, hasEnvelope: true };
            } catch (error) {
                console.error(`[sessionsSnapshot] Failed to decrypt session data key for ${session.id}`, error);
                return { sessionId: session.id, decryptedKey: null as Uint8Array | null, hasEnvelope: true };
            }
        }),
        concurrencyLimit,
    );

    for (const result of keyResults) {
        sessionKeys.set(result.sessionId, result.decryptedKey);
        if (result.decryptedKey) {
            sessionDataKeys.set(result.sessionId, result.decryptedKey);
        } else if (result.hasEnvelope) {
            sessionDataKeys.delete(result.sessionId);
        } else {
            sessionDataKeys.delete(result.sessionId);
        }
    }
    const cachedSessionListEntries = params.cachedSessionListEntries ?? {};
    const fetchedSessionIds = sessions.map((session) => session.id);
    const fetchedSessionIdSet = new Set(fetchedSessionIds);
    const retainedCachedSessionIds = usedLegacyV1Snapshot
        ? Object.keys(cachedSessionListEntries).filter((sessionId) => !fetchedSessionIdSet.has(sessionId))
        : [];
    params.onSnapshotFetched?.([...fetchedSessionIds, ...retainedCachedSessionIds]);
    await encryption.initializeSessions(sessionKeys);

    const shouldApplyRenderables = typeof params.applySessionListRenderables === 'function';
    const shouldContinue = params.shouldContinue ?? (() => true);

    if (shouldApplyRenderables) {
        const renderables = [
            ...sessions.map((row) => buildRenderableFromRowAndCache(row, cachedSessionListEntries[row.id])),
            ...retainedCachedSessionIds.map((sessionId) => buildRenderableFromCachedEntry(cachedSessionListEntries[sessionId]!)),
        ];
        params.applySessionListRenderables!(renderables, { replace: true });

        const rowsNeedingHydration = orderRowsForWarmHydration({
            rows: sessions.filter((row) => needsWarmHydration({
                row,
                cachedEntry: cachedSessionListEntries[row.id],
                existingSession: params.getExistingSession?.(row.id),
            })),
            prioritizedSessionIds: params.prioritizeSessionIds,
            eagerHydrationCount: params.sessionListEagerHydrationCount,
        });
        if (rowsNeedingHydration.length > 0) {
            void runTasksWithLimit(
                rowsNeedingHydration.map((row) => async () => {
                    if (!shouldContinue()) return null;
                    const decryptedSession = await decryptSessionRow(
                        row,
                        encryption,
                        params.serverId,
                        cachedSessionListEntries[row.id],
                    );
                    if (!shouldContinue()) return null;
                    if (!decryptedSession) return null;
                    applyHydratedSessions({
                        sessions: [decryptedSession],
                        applySessions,
                        getExistingSession: params.getExistingSession,
                    });
                    if (shouldContinue()) {
                        scheduleReadStateRepair({
                            sessions: [decryptedSession],
                            repairInvalidReadStateV1,
                        });
                    }
                    return decryptedSession;
                }),
                concurrencyLimit,
            ).catch((error) => {
                console.error('[sessionsSnapshot] Background hydration failed', error);
            });
        }

        log.log(`📥 fetchSessions completed - rendered ${renderables.length} session list rows before selective hydration`);
        return;
    }

    const decryptedResults = await runTasksWithLimit(
        sessions.map((row) => async () => decryptSessionRow(
            row,
            encryption,
            params.serverId,
            cachedSessionListEntries[row.id],
        )),
        concurrencyLimit,
    );
    const decryptedSessions = decryptedResults.filter((session): session is NonNullable<typeof session> => Boolean(session));

    applyHydratedSessions({
        sessions: decryptedSessions,
        applySessions,
        getExistingSession: params.getExistingSession,
    });
    scheduleReadStateRepair({
        sessions: decryptedSessions,
        repairInvalidReadStateV1,
    });

    log.log(`📥 fetchSessions completed - processed ${decryptedSessions.length} sessions`);
}
