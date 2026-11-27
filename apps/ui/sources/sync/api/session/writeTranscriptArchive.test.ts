import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { expect, it } from 'vitest';

import { writeTranscriptArchive } from './writeTranscriptArchive';

it('archives hosted transcripts and records failed or skipped sessions', async () => {
    const chunks: BlobPart[] = [];
    const result = await writeTranscriptArchive({
        format: 'markdown',
        sessions: [
            { id: '../hosted', read: async () => '# transcript\n' },
            { id: 'machine', read: async () => null },
            { id: 'unavailable', read: async () => { throw new Error('offline'); } },
        ],
        write: async bytes => { chunks.push(new Uint8Array(bytes)); },
    });
    expect(result).toEqual({ failedSessionIds: ['unavailable'], skippedExternalCount: 1 });
    const reader = new ZipReader(new BlobReader(new Blob(chunks)), { useWebWorkers: false, useCompressionStream: false });
    try {
        const entries = await reader.getEntries();
        expect(entries.map(entry => entry.filename)).toEqual(['..%2Fhosted.md', 'README.txt']);
        expect(await entries[0]?.getData?.(new TextWriter())).toBe('# transcript\n');
        expect(await entries[1]?.getData?.(new TextWriter())).toContain('unavailable');
    } finally {
        await reader.close();
    }
});
