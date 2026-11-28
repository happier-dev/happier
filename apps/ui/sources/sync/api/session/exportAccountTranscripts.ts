import type { Encryption } from '@/sync/encryption/encryption';
import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { fetchSessionListPageCompat } from '@/sync/engine/sessions/sessionHttpCompat';

import { readListedSessionMetadata } from './readListedSessionMetadata';
import { exportTranscript } from './sessionMessagesApi';
import type { TranscriptExportFormat } from './serializeTranscript';
import { writeTranscriptArchive, type TranscriptArchiveSession } from './writeTranscriptArchive';

type AccountTranscriptRequest = Parameters<typeof fetchSessionListPageCompat>[0]['request'];

export function exportAccountTranscripts(params: Readonly<{
    format: TranscriptExportFormat;
    token: string;
    request: AccountTranscriptRequest;
    encryption: Encryption;
    serverId: string;
    retrySessionIds?: readonly string[];
    includeSubagents?: boolean;
    shouldContinue: () => boolean;
    write: (bytes: Uint8Array) => Promise<void>;
    onProgress?: (progress: Readonly<{ done: number; failed: number }>) => void;
}>) {
    const wanted = params.retrySessionIds ? new Set(params.retrySessionIds) : null;
    async function* accountSessions(): AsyncGenerator<TranscriptArchiveSession> {
        let cursor: string | null = null;
        do {
            if (!params.shouldContinue()) throw new Error('Transcript export canceled');
            const page = await fetchSessionListPageCompat({
                request: params.request,
                token: params.token,
                cursor,
                limit: 50,
            });
            for (const row of page.sessions) {
                if (wanted && !wanted.delete(row.id)) continue;
                yield {
                    id: row.id,
                    read: async () => {
                        if (row.cloudCopyLeftAt != null) return null;
                        const encryptionMode = row.encryptionMode === 'plain' ? 'plain' : 'e2ee';
                        const { metadata, sessionEncryption } = await readListedSessionMetadata(row, params.encryption, params.serverId);
                        if (!metadata) throw new Error('Could not read transcript metadata');
                        if (getSessionStorageKind({ metadata }) === 'direct') return null;
                        return exportTranscript({
                            sessionId: row.id,
                            format: params.format,
                            includeSubagents: params.includeSubagents,
                            encryptionMode,
                            request: (path) => params.request(path, { method: 'GET' }),
                            getSessionEncryption: () => sessionEncryption,
                            shouldContinue: params.shouldContinue,
                        });
                    },
                };
            }
            if (!page.hasNext || wanted?.size === 0) break;
            if (!page.nextCursor || page.nextCursor === cursor) throw new Error('Session list paging did not advance');
            cursor = page.nextCursor;
        } while (cursor);
        for (const id of wanted ?? []) {
            yield { id, read: async () => { throw new Error('Session is no longer available'); } };
        }
    }
    return writeTranscriptArchive({ ...params, sessions: accountSessions() });
}
