import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { fetchSessionListPageCompat } from '@/sync/engine/sessions/sessionHttpCompat';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

import { readTranscriptForExport } from './readTranscriptForExport';
import type { TranscriptExportFormat } from './serializeTranscript';
import { writeTranscriptArchive, type TranscriptArchiveSession } from './writeTranscriptArchive';

type ExportOptions = Readonly<{
    scope: ServerAccountScope;
    format: TranscriptExportFormat;
    signal?: AbortSignal;
    includeSubagents?: boolean;
}>;

function withTranscriptExport<T>(options: ExportOptions, work: (read: {
    accountSessions: (retrySessionIds?: readonly string[]) => AsyncGenerator<TranscriptArchiveSession>;
    transcript: (sessionId: string, seqs?: readonly number[]) => Promise<string | null>;
    check: () => void;
}) => Promise<T>): Promise<T> {
    const staleError = () => new Error('Transcript export Account changed');
    return runWithServerAccountScopeRequestGuard({ scope: options.scope, signal: options.signal, staleError }, guard =>
        runWithServerRequestAuthorityForServerAccountScope({
            scope: options.scope,
            signal: guard.signal,
            activeRequest: async () => { throw staleError(); },
        }, async authority => {
            const { credentials, encryption } = authority.context;
            if (!credentials) throw staleError();
            const { token } = credentials;
            const encryptionCurrentness = captureEncryptionGenerationCurrentness(encryption, options.scope);
            const check = () => {
                guard.check();
                if (!encryptionCurrentness.isCurrent()) throw staleError();
            };
            const isCurrent = () => {
                check();
                return true;
            };
            const request = (path: string, init?: RequestInit) => {
                check();
                return authority.request(path, { ...init, signal: guard.signal });
            };
            const transcript = async (sessionId: string, seqs?: readonly number[]) => {
                const { session } = await readSessionSnapshotForAuthority({
                    authority, sessionId, includeTurns: false, includeMetadataTupleMutationSnapshot: false,
                    isCurrent, signal: guard.signal,
                });
                check();
                if (session.currentStorageState === 'machine_only' || getSessionStorageKind(session) === 'direct') return null;
                if (!session.access?.capabilities.readTranscript) throw new Error('Transcript access denied');
                if (session.encryptionMode !== 'plain' && session.encryptionMode !== 'e2ee') throw new Error('Transcript encryption unavailable');
                return await readTranscriptForExport({
                    sessionId, seqs, format: options.format, includeSubagents: options.includeSubagents, encryptionMode: session.encryptionMode,
                    request, getSessionEncryption: (id) => encryption?.getSessionEncryption(id) ?? null, shouldContinue: isCurrent,
                });
            };
            async function* accountSessions(retrySessionIds?: readonly string[]): AsyncGenerator<TranscriptArchiveSession> {
                const wanted = retrySessionIds ? new Set(retrySessionIds) : null;
                let cursor: string | null = null;
                while (wanted?.size !== 0) {
                    const page = await fetchSessionListPageCompat({ request, token, cursor, limit: 50 });
                    check();
                    if (page.metadataUpgradeRequiredCount > 0) throw new Error('Session metadata upgrade required for export');
                    for (const row of page.sessions) {
                        if (wanted && !wanted.delete(row.id)) continue;
                        yield { id: row.id, read: () => row.currentStorageState === 'machine_only' ? Promise.resolve(null) : transcript(row.id) };
                    }
                    if (!page.hasNext) break;
                    if (!page.nextCursor || page.nextCursor === cursor) throw new Error('Session list paging did not advance');
                    cursor = page.nextCursor;
                }
                for (const id of wanted ?? []) {
                    yield { id, read: async () => { throw new Error('Session is no longer available'); } };
                }
            }
            return await work({ transcript, accountSessions, check });
        }));
}

export function exportSessionTranscript(options: ExportOptions & Readonly<{
    sessionId: string;
    seqs?: readonly number[];
}>): Promise<string | null> {
    return withTranscriptExport(options, ({ transcript }) => transcript(options.sessionId, options.seqs));
}

export function exportAccountTranscripts(options: ExportOptions & Readonly<{
    retrySessionIds?: readonly string[];
    write: (bytes: Uint8Array) => Promise<void>;
    onProgress?: (progress: Readonly<{ done: number; failed: number }>) => void;
}>) {
    return withTranscriptExport(options, ({ accountSessions, check }) => writeTranscriptArchive({
        format: options.format,
        sessions: accountSessions(options.retrySessionIds),
        write: async bytes => { check(); await options.write(bytes); },
        shouldContinue: () => { check(); return true; },
        onProgress: options.onProgress,
    }));
}
