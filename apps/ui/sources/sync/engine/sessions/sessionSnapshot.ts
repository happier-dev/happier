import { V2SessionListResponseSchema, type V2SessionListResponse } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { serverFetch } from '@/sync/http/client';
import type { Session } from '@/sync/domains/state/storageTypes';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';

import { parsePlainSessionAgentState, parsePlainSessionMetadata } from './parsePlainSessionPayload';

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
    const metadataMatches = cachedEntry?.metadataVersion === row.metadataVersion;
    const agentStateMatches = cachedEntry?.agentStateVersion === row.agentStateVersion;

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
        metadata: metadataMatches && cachedEntry
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
            : null,
        thinking: false,
        thinkingAt: 0,
        presence: row.active ? 'online' : row.activeAt,
        accessLevel: normalizeAccessLevel(row.share?.accessLevel),
        canApprovePermissions: row.share?.canApprovePermissions ?? undefined,
        hasPendingPermissionRequests: agentStateMatches
            ? cachedEntry?.hasPendingPermissionRequests === true
            : undefined,
        hasPendingUserActionRequests: agentStateMatches
            ? cachedEntry?.hasPendingUserActionRequests === true
            : undefined,
    };
}

function needsWarmHydration(row: SessionListRow, cachedEntry: SessionListCacheEntryV1 | undefined): boolean {
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

        const agentState =
            encryptionMode === 'plain'
                ? parsePlainSessionAgentState(row.agentState)
                : await sessionEncryption!.decryptAgentState(row.agentStateVersion, row.agentState);

        return {
            ...row,
            encryptionMode,
            thinking: false,
            thinkingAt: 0,
            metadata,
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

    let cursor: string | null = null;
    while (sessions.length < SESSION_LIST_LIMIT) {
        const pageLimit = Math.min(200, SESSION_LIST_LIMIT - sessions.length);
        const url = new URL('/v2/sessions', 'http://placeholder.local');
        url.searchParams.set('limit', String(pageLimit));
        if (cursor) url.searchParams.set('cursor', cursor);

        const response = await request(url.pathname + url.search, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw new HappyError(`Failed to fetch sessions (${response.status})`, false);
            }
            throw new Error(`Failed to fetch sessions: ${response.status}`);
        }

        const data = await response.json();
        const parsed = V2SessionListResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new Error('Invalid /v2/sessions response');
        }

        for (const row of parsed.data.sessions) {
            sessions.push(row);
        }

        const hasNext = parsed.data.hasNext === true;
        const nextCursor = typeof parsed.data.nextCursor === 'string' ? parsed.data.nextCursor : null;
        if (!hasNext || !nextCursor) break;
        cursor = nextCursor;
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
    params.onSnapshotFetched?.(sessions.map((session) => session.id));
    await encryption.initializeSessions(sessionKeys);

    const cachedSessionListEntries = params.cachedSessionListEntries ?? {};
    const shouldApplyRenderables = typeof params.applySessionListRenderables === 'function';

    if (shouldApplyRenderables) {
        const renderables = sessions.map((row) => buildRenderableFromRowAndCache(row, cachedSessionListEntries[row.id]));
        params.applySessionListRenderables!(renderables, { replace: true });

        const rowsNeedingHydration = orderRowsForWarmHydration({
            rows: sessions.filter((row) => needsWarmHydration(row, cachedSessionListEntries[row.id])),
            prioritizedSessionIds: params.prioritizeSessionIds,
            eagerHydrationCount: params.sessionListEagerHydrationCount,
        });
        if (rowsNeedingHydration.length > 0) {
            void runTasksWithLimit(
                rowsNeedingHydration.map((row) => async () => {
                    const decryptedSession = await decryptSessionRow(row, encryption);
                    if (!decryptedSession) return null;
                    applyHydratedSessions({
                        sessions: [decryptedSession],
                        applySessions,
                        getExistingSession: params.getExistingSession,
                    });
                    scheduleReadStateRepair({
                        sessions: [decryptedSession],
                        repairInvalidReadStateV1,
                    });
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
        sessions.map((row) => async () => decryptSessionRow(row, encryption)),
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
