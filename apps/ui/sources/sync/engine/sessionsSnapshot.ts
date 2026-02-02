import type { AuthCredentials } from '@/auth/tokenStorage';
import { HappyError } from '@/utils/errors';
import { getServerUrl } from '../serverConfig';
import type { Session } from '../storageTypes';
import type { Metadata } from '../storageTypes';

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
    applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
    repairInvalidReadStateV1: (params: { sessionId: string; sessionSeqUpperBound: number }) => Promise<void>;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { credentials, encryption, sessionDataKeys, applySessions, repairInvalidReadStateV1, log } = params;

    const API_ENDPOINT = getServerUrl();
    const SESSION_LIST_LIMIT = 150;
    const sessions: Array<{
        id: string;
        seq: number;
        metadata: string;
        metadataVersion: number;
        agentState: string | null;
        agentStateVersion: number;
        dataEncryptionKey: string | null;
        active: boolean;
        activeAt: number;
        createdAt: number;
        updatedAt: number;
        share?: {
            accessLevel: 'view' | 'edit' | 'admin';
            canApprovePermissions: boolean;
        } | null;
    }> = [];

    let cursor: string | null = null;
    while (sessions.length < SESSION_LIST_LIMIT) {
        const pageLimit = Math.min(200, SESSION_LIST_LIMIT - sessions.length);
        const url = new URL(`${API_ENDPOINT}/v2/sessions`);
        url.searchParams.set('limit', String(pageLimit));
        if (cursor) url.searchParams.set('cursor', cursor);

        const response = await fetch(url.toString(), {
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
        const pageSessions = (data as any)?.sessions;
        if (!Array.isArray(pageSessions)) {
            throw new Error('Invalid /v2/sessions response');
        }

        for (const raw of pageSessions) {
            if (!raw || typeof raw !== 'object') continue;
            sessions.push(raw);
        }

        const hasNext = (data as any)?.hasNext === true;
        const nextCursor = typeof (data as any)?.nextCursor === 'string' ? (data as any).nextCursor : null;
        if (!hasNext || !nextCursor) break;
        cursor = nextCursor;
    }

    // Initialize all session encryptions first
    const sessionKeys = new Map<string, Uint8Array | null>();
    for (const session of sessions) {
        if (session.dataEncryptionKey) {
            const decrypted = await encryption.decryptEncryptionKey(session.dataEncryptionKey);
            if (!decrypted) {
                console.error(`Failed to decrypt data encryption key for session ${session.id}`);
                sessionKeys.set(session.id, null);
                sessionDataKeys.delete(session.id);
                continue;
            }
            sessionKeys.set(session.id, decrypted);
            sessionDataKeys.set(session.id, decrypted);
        } else {
            sessionKeys.set(session.id, null);
            sessionDataKeys.delete(session.id);
        }
    }
    await encryption.initializeSessions(sessionKeys);

    // Decrypt sessions
    const decryptedSessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[] = [];
    for (const session of sessions) {
        // Get session encryption (should always exist after initialization)
        const sessionEncryption = encryption.getSessionEncryption(session.id);
        if (!sessionEncryption) {
            console.error(`Session encryption not found for ${session.id} - this should never happen`);
            continue;
        }

        // Decrypt metadata using session-specific encryption
        const metadata = await sessionEncryption.decryptMetadata(session.metadataVersion, session.metadata);

        // Decrypt agent state using session-specific encryption
        const agentState = await sessionEncryption.decryptAgentState(session.agentStateVersion, session.agentState);

        // Put it all together
        decryptedSessions.push({
            ...session,
            thinking: false,
            thinkingAt: 0,
            metadata,
            agentState,
            accessLevel: session.share?.accessLevel ?? undefined,
            canApprovePermissions: session.share?.canApprovePermissions ?? undefined,
        });
    }

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
