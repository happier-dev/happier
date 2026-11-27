import type { ActionOperationProgressV1 } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { serializeTranscript, type TranscriptExportFormat } from '@/sync/api/session/serializeTranscript';
import { saveFileBytes, saveFileStream } from '@/sync/runtime/files/saveFileBytes';
import { t } from '@/text';

/** What one export covers. Each entry point offers the scopes it can reach. */
export type TranscriptExportScope =
    | Readonly<{ kind: 'selection'; sessionId: string; messages: readonly Message[] }>
    | Readonly<{ kind: 'session'; sessionId: string; seqs?: readonly number[] }>
    | Readonly<{ kind: 'everything'; retrySessionIds?: readonly string[] }>;

export type TranscriptExportProgress = Readonly<{ done: number; failed: number }>;

export type TranscriptExportStep =
    | Readonly<{ step: 'reading'; loaded: number; total: number | null; progress: ActionOperationProgressV1 }>
    | Readonly<{ step: 'formatting' | 'saving'; progress: ActionOperationProgressV1 }>;

export type TranscriptExportResult = Readonly<{
    fileName: string;
    byteCount: number;
    /** Everything only: hosted transcripts that could not be read, for "Try these again". */
    failedSessionIds: readonly string[];
    /** Everything only: direct (machine-held) sessions the archive leaves out. */
    skippedExternalCount: number;
}>;

function sessionFileStem(sessionId: string): string {
    return `happier-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function archiveName(retry: boolean, nowMs: number): string {
    const day = new Date(nowMs);
    const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    return `happier-export-${stamp}${retry ? '-retry' : ''}.zip`;
}

/**
 * Runs one export on this device: reads (and decrypts) through the sync owner, serializes with the
 * one transcript serializer, and hands the file to the platform save path (download, save dialog or
 * share sheet). Cancellation goes through `signal`; a canceled run rejects and saves nothing.
 */
export async function runTranscriptExport(params: Readonly<{
    scope: TranscriptExportScope;
    format: TranscriptExportFormat;
    includeSubagents: boolean;
    dialogTitle: string;
    signal: AbortSignal;
    onProgress: (progress: TranscriptExportProgress) => void;
    onStepProgress?: (update: TranscriptExportStep) => void;
}>): Promise<TranscriptExportResult> {
    const { scope, format, includeSubagents } = params;
    const json = format === 'json';
    if (scope.kind === 'everything') {
        const { sync } = await import('@/sync/sync');
        const fileName = archiveName(Boolean(scope.retrySessionIds), Date.now());
        let byteCount = 0;
        const result = await saveFileStream({ name: fileName, mimeType: 'application/zip', dialogTitle: params.dialogTitle }, async (sink) => {
            const archived = await sync.exportAccountTranscripts({
                format,
                includeSubagents,
                retrySessionIds: scope.retrySessionIds,
                signal: params.signal,
                onProgress: params.onProgress,
                write: async (bytes) => {
                    byteCount += bytes.byteLength;
                    await sink(bytes);
                },
            });
            // Every transcript is in the archive; what is left is the platform's download or share sheet.
            params.onStepProgress?.({
                step: 'saving',
                progress: { kind: 'phase', phase: 'saving', label: t('transcriptExport.savingSession') },
            });
            return archived;
        });
        return { fileName, byteCount, failedSessionIds: result.failedSessionIds, skippedExternalCount: result.skippedExternalCount };
    }

    const reportReading = (loaded: number, total: number | null) => {
        const label = t('transcriptExport.readingSession');
        params.onStepProgress?.({
            step: 'reading', loaded, total,
            progress: total !== null && total > 0
                ? { kind: 'determinate', label, current: loaded, total }
                : { kind: 'phase', phase: 'reading', label },
        });
    };
    const reportFormatting = async () => {
        if (!params.onStepProgress) return;
        params.onStepProgress({
            step: 'formatting',
            progress: { kind: 'phase', phase: 'formatting', label: t('transcriptExport.formattingSession') },
        });
        // Reduction and formatting are synchronous. Let the sheet render the new phase first.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };

    if (params.signal.aborted) throw new Error('Transcript export canceled');
    let text: string;
    if (scope.kind === 'selection') {
        await reportFormatting();
        if (params.signal.aborted) throw new Error('Transcript export canceled');
        text = serializeTranscript(scope.messages, format, { includeSubagents });
    } else {
        reportReading(0, null);
        const { sync } = await import('@/sync/sync');
        text = await sync.exportSessionTranscript(scope.sessionId, format, {
            includeSubagents,
            signal: params.signal,
            seqs: scope.seqs,
            onReadProgress: reportReading,
            onFormatting: reportFormatting,
        });
    }
    if (params.signal.aborted) throw new Error('Transcript export canceled');
    const bytes = new TextEncoder().encode(text);
    const selection = scope.kind === 'selection' || scope.seqs !== undefined;
    const fileName = `${sessionFileStem(scope.sessionId)}${selection ? '-selection' : ''}.${json ? 'json' : 'md'}`;
    params.onStepProgress?.({
        step: 'saving',
        progress: { kind: 'phase', phase: 'saving', label: t('transcriptExport.savingSession') },
    });
    await saveFileBytes({ name: fileName, bytes, mimeType: json ? 'application/json' : 'text/markdown', dialogTitle: params.dialogTitle });
    params.onProgress({ done: 1, failed: 0 });
    return { fileName, byteCount: bytes.byteLength, failedSessionIds: [], skippedExternalCount: 0 };
}
