import { describe, expect, it } from 'vitest';

import { strFromU8, unzipSync } from 'fflate';

import { writeTranscriptArchive } from './writeTranscriptArchive';

describe('writeTranscriptArchive', () => {
    it('continues after one unavailable transcript and writes the next transcript before completing', async () => {
        const attempts: string[] = [];
        const chunks: Uint8Array[] = [];
        const result = await writeTranscriptArchive({
            format: 'json',
            sessions: [
                { id: 'one', read: async () => { attempts.push('one'); throw new Error('offline'); } },
                { id: 'moved', read: async () => null },
                { id: 'two', read: async () => { attempts.push('two'); return '[{"text":"kept"}]'; } },
            ],
            write: async (chunk: Uint8Array) => { chunks.push(chunk); },
        });
        expect(attempts).toEqual(['one', 'two']);
        expect(result).toEqual({ failedSessionIds: ['one'], skippedExternalCount: 1 });
        const entries = unzipSync(Buffer.concat(chunks));
        expect(JSON.parse(strFromU8(entries['two.json']!))).toEqual([{ text: 'kept' }]);
        expect(strFromU8(entries['README.txt']!)).toContain('one');
    });

    it('reports each hosted transcript as it finishes, counting failures and not skipped external sessions', async () => {
        const progress: Array<Readonly<{ done: number; failed: number }>> = [];
        await writeTranscriptArchive({
            format: 'markdown',
            sessions: [
                { id: 'a', read: async () => '## User\n\nhi' },
                { id: 'external', read: async () => null },
                { id: 'b', read: async () => { throw new Error('offline'); } },
            ],
            write: async () => {},
            onProgress: (next) => progress.push(next),
        });
        expect(progress).toEqual([{ done: 1, failed: 0 }, { done: 2, failed: 1 }]);
    });
});
