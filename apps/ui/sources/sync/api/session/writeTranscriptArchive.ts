import type { TranscriptExportFormat } from './serializeTranscript';

export type TranscriptArchiveSession = Readonly<{
    id: string;
    read: () => Promise<string | null>;
}>;

export async function writeTranscriptArchive(params: Readonly<{
    format: TranscriptExportFormat;
    sessions: AsyncIterable<TranscriptArchiveSession> | Iterable<TranscriptArchiveSession>;
    write: (chunk: Uint8Array) => Promise<void>;
    shouldContinue?: () => boolean;
    /** After each hosted transcript is written or fails; skipped external sessions are not reported. */
    onProgress?: (progress: Readonly<{ done: number; failed: number }>) => void;
}>): Promise<{ failedSessionIds: string[]; skippedExternalCount: number }> {
    const { TextReader, ZipWriter } = await import('@zip.js/zip.js');
    const writer = new ZipWriter(new WritableStream<Uint8Array>({ write: params.write }));
    const addEntry = (name: string, text: string) => writer.add(name, new TextReader(text), {
        useWebWorkers: false,
        useCompressionStream: false,
    });
    const failedSessionIds: string[] = [];
    const skippedExternalIds: string[] = [];
    const fileExtension = params.format === 'json' ? 'json' : 'md';
    const seen = new Set<string>();
    let done = 0;
    for await (const session of params.sessions) {
        if (params.shouldContinue?.() === false) throw new Error('Transcript export canceled');
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        let text: string | null;
        try {
            text = await session.read();
        } catch {
            if (params.shouldContinue?.() === false) throw new Error('Transcript export canceled');
            failedSessionIds.push(session.id);
            params.onProgress?.({ done: ++done, failed: failedSessionIds.length });
            continue;
        }
        if (text === null) {
            skippedExternalIds.push(session.id);
        } else {
            await addEntry(`${encodeURIComponent(session.id)}.${fileExtension}`, text);
            params.onProgress?.({ done: ++done, failed: failedSessionIds.length });
        }
    }
    if (params.shouldContinue?.() === false) throw new Error('Transcript export canceled');
    await addEntry('README.txt', [
        'Happier transcript export',
        'Attachments are referenced in the transcript. Attachment files are stored separately.',
        `External sessions skipped: ${skippedExternalIds.length}`,
        ...skippedExternalIds.map((id) => encodeURIComponent(id)),
        `Hosted transcripts that could not be exported: ${failedSessionIds.length}`,
        ...failedSessionIds.map((id) => encodeURIComponent(id)),
        '',
    ].join('\n'));
    await writer.close();
    return { failedSessionIds, skippedExternalCount: skippedExternalIds.length };
}
