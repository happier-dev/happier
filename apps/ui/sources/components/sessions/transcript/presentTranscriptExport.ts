import { t } from '@/text';
import type { TranscriptExportFormat } from '@/sync/api/session/serializeTranscript';
import { runTranscriptExport } from '@/components/sessions/export/transcriptExportJob';

/**
 * Headless saves for the client-side `session.export` Action. People export through `ExportSheet`;
 * both go through the one export job, so a file is named, read and saved the same way either way.
 */

const noProgress = () => {};

export async function saveSessionTranscriptExport(
    sessionId: string,
    format: TranscriptExportFormat,
    options: Readonly<{ seqs?: readonly number[]; signal?: AbortSignal }> = {},
) {
    return runTranscriptExport({
        scope: { kind: 'session', sessionId, ...(options.seqs ? { seqs: options.seqs } : {}) },
        format,
        includeSubagents: true,
        dialogTitle: t('transcriptExport.session'),
        signal: options.signal ?? new AbortController().signal,
        onProgress: noProgress,
    });
}

export async function saveAccountTranscriptExport(
    format: TranscriptExportFormat,
    options: Readonly<{ retrySessionIds?: readonly string[]; signal?: AbortSignal }> = {},
) {
    return runTranscriptExport({
        scope: { kind: 'everything', ...(options.retrySessionIds ? { retrySessionIds: options.retrySessionIds } : {}) },
        format,
        includeSubagents: true,
        dialogTitle: t('transcriptExport.everything'),
        signal: options.signal ?? new AbortController().signal,
        onProgress: noProgress,
    });
}
