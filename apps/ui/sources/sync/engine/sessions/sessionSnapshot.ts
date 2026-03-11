import { V2SessionListResponseSchema, type V2SessionListResponse } from '@happier-dev/protocol';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { serverFetch } from '@/sync/http/client';
import { AgentStateSchema, MetadataSchema, type Session } from '@/sync/domains/state/storageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

type SessionEncryption = {
    decryptAgentState: (version: number, value: string | null) => Promise<any>;
    decryptMetadata: (version: number, value: string) => Promise<any>;
};

export type SessionListEncryption = {
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: (sessionKeys: Map<string, Uint8Array | null>) => Promise<void>;
    getSessionEncryption: (sessionId: string) => SessionEncryption | null;
};

export async function fetchAndApplySessions(params: {
    credentials: AuthCredentials;
    encryption: SessionListEncryption;
    sessionDataKeys: Map<string, Uint8Array>;
    request?: (path: string, init: RequestInit) => Promise<Response>;
    applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
    repairInvalidReadStateV1: (params: { sessionId: string; sessionSeqUpperBound: number }) => Promise<void>;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { credentials, encryption, sessionDataKeys, applySessions, repairInvalidReadStateV1, log } = params;
    const request =
        params.request
        ?? ((path: string, init: RequestInit) => serverFetch(path, init, { includeAuth: false }));

    const SESSION_LIST_LIMIT = 150;
    const sessions: V2SessionListResponse['sessions'] = [];

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

    // Decrypt all session keys in parallel
    const sessionKeys = new Map<string, Uint8Array | null>();
    const keyResults = await Promise.all(
        sessions.map(async (session) => {
            try {
                if (session.dataEncryptionKey) {
                    const decrypted = await encryption.decryptEncryptionKey(session.dataEncryptionKey);
                    return { id: session.id, decrypted, hasKey: true };
                }
                return { id: session.id, decrypted: null, hasKey: false };
            } catch (err) {
                console.error(`Failed to decrypt encryption key for session ${session.id}`, err);
                return { id: session.id, decrypted: null, hasKey: true };
            }
        }),
    );
    for (const { id, decrypted, hasKey } of keyResults) {
        if (hasKey && !decrypted) {
            console.error(`Failed to decrypt data encryption key for session ${id}`);
            sessionKeys.set(id, null);
            sessionDataKeys.delete(id);
        } else if (hasKey && decrypted) {
            sessionKeys.set(id, decrypted);
            sessionDataKeys.set(id, decrypted);
        } else {
            sessionKeys.set(id, null);
            sessionDataKeys.delete(id);
        }
    }
    await encryption.initializeSessions(sessionKeys);

    // Decrypt all sessions in parallel
    const parsePlainMetadata = (value: string): Metadata | null => {
        try {
            const parsedJson = JSON.parse(value);
            const parsed = MetadataSchema.safeParse(parsedJson);
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    };

    const parsePlainAgentState = (value: string | null): unknown => {
        if (!value) return {};
        try {
            const parsedJson = JSON.parse(value);
            const parsed = AgentStateSchema.safeParse(parsedJson);
            return parsed.success ? parsed.data : {};
        } catch {
            return {};
        }
    };

    const decryptedSessionResults = await Promise.all(
        sessions.map(async (session) => {
            try {
                const encryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';

                const sessionEncryption = encryption.getSessionEncryption(session.id);
                if (encryptionMode === 'e2ee' && !sessionEncryption) {
                    console.error(`Session encryption not found for ${session.id} - this should never happen`);
                    return null;
                }

                const metadata =
                    encryptionMode === 'plain'
                        ? parsePlainMetadata(session.metadata)
                        : await sessionEncryption!.decryptMetadata(session.metadataVersion, session.metadata);

                const agentState =
                    encryptionMode === 'plain'
                        ? parsePlainAgentState(session.agentState)
                        : await sessionEncryption!.decryptAgentState(session.agentStateVersion, session.agentState);

                const accessLevel = session.share?.accessLevel;
                const normalizedAccessLevel =
                    accessLevel === 'view' || accessLevel === 'edit' || accessLevel === 'admin' ? accessLevel : undefined;
                return {
                    ...session,
                    encryptionMode,
                    thinking: false,
                    thinkingAt: 0,
                    metadata,
                    agentState,
                    accessLevel: normalizedAccessLevel,
                    canApprovePermissions: session.share?.canApprovePermissions ?? undefined,
                };
            } catch (err) {
                console.error(`Failed to decrypt session ${session.id}`, err);
                return null;
            }
        }),
    );
    const decryptedSessions = decryptedSessionResults.filter(
        (s): s is NonNullable<typeof s> => s !== null,
    );

    // Apply to storage
    applySessions(decryptedSessions);
    log.log(`📥 fetchSessions completed - processed ${decryptedSessions.length} sessions`);

    void (async () => {
        for (const session of decryptedSessions) {
            try {
                const readState = (session.metadata as Metadata | null)?.readStateV1;
                if (!readState) continue;
                if (readState.sessionSeq <= (session.seq ?? 0)) continue;
                await repairInvalidReadStateV1({ sessionId: session.id, sessionSeqUpperBound: session.seq ?? 0 });
            } catch (err) {
                console.error('[sessionsSnapshot] Failed to repair invalid readStateV1', { sessionId: session.id, err });
            }
        }
    })().catch((err) => {
        console.error('[sessionsSnapshot] Invalid readStateV1 repair loop failed', { err });
    });
}
