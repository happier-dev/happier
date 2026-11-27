import { describe, expect, it } from 'vitest';

import { readTranscriptForExport } from './readTranscriptForExport';

function row(seq: number, text: string, sidechainId: string | null = null) {
    return {
        id: `m${seq}`,
        seq,
        localId: null,
        sidechainId,
        createdAt: 1000 + seq,
        updatedAt: 1000 + seq,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text } } },
    };
}

describe('readTranscriptForExport', () => {
    it('selects messages across older pages and includes standalone subagent history', async () => {
        const cursors: Array<string | null> = [];
        const json = await readTranscriptForExport({
            sessionId: 'session',
            seqs: [1, 3],
            format: 'json',
            encryptionMode: 'plain',
            getSessionEncryption: () => null,
            request: async (path) => {
                const cursor = new URL(path, 'https://home.example').searchParams.get('beforeSeq');
                cursors.push(cursor);
                return cursor === null
                    ? Response.json({ messages: [row(3, 'subagent', 'side'), row(2, 'skip')], nextBeforeSeq: 2, hasMore: true })
                    : Response.json({ messages: [row(1, 'earlier')], nextBeforeSeq: null, hasMore: false });
            },
        });
        expect(cursors).toEqual([null, '2']);
        expect(JSON.parse(json)).toMatchObject([{ seq: 1, text: 'earlier' }, { seq: 3, text: 'subagent' }]);
    });
});
