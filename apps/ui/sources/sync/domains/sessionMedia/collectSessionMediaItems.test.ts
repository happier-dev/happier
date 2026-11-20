import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { collectSessionMediaItems } from './collectSessionMediaItems';

function mediaMeta(path: string, role: 'input' | 'output' = 'output', sha: string | null | undefined = undefined): unknown {
    return {
        happier: {
            kind: 'session_media.v1',
            payload: {
                media: [{
                    id: `id-${path}`,
                    role,
                    category: role === 'input' ? 'attachment' : 'generated',
                    mediaKind: 'image',
                    name: path.split('/').pop(),
                    path,
                    mimeType: 'image/png',
                    sizeBytes: 10,
                    ...(sha === null ? {} : { sha256: sha ?? Buffer.from(path).toString('hex').padEnd(64, '0').slice(0, 64) }),
                    origin: { source: role === 'input' ? 'user-upload' : 'provider-generated' },
                }],
            },
        },
    };
}

function agentMessage(id: string, seq: number, meta?: unknown): Message {
    return {
        kind: 'agent-text', id, seq, localId: null, createdAt: seq * 1000, text: '', meta: meta as Message['meta'],
    } as Message;
}

describe('collectSessionMediaItems', () => {
    it('returns an empty list when no message carries media', () => {
        expect(collectSessionMediaItems([agentMessage('m1', 1)])).toEqual([]);
    });

    it('lists media newest message first and keeps the source message for jumping', () => {
        const items = collectSessionMediaItems([
            agentMessage('m1', 1, mediaMeta('.happier/uploads/a.png', 'input')),
            agentMessage('m2', 2),
            agentMessage('m3', 3, mediaMeta('.happier/uploads/b.png')),
        ]);

        expect(items.map((item) => [item.media.path, item.messageId, item.seq])).toEqual([
            ['.happier/uploads/b.png', 'm3', 3],
            ['.happier/uploads/a.png', 'm1', 1],
        ]);
    });

    it('reads media from tool-call children and shows a repeated file once, at its first message', () => {
        const nested = {
            kind: 'tool-call', id: 't1', seq: 2, localId: null, createdAt: 2000, tool: {}, children: [
                agentMessage('c1', 2, mediaMeta('.happier/uploads/a.png')),
            ],
        } as unknown as Message;

        const items = collectSessionMediaItems([
            agentMessage('m1', 1, mediaMeta('.happier/uploads/a.png', 'input')),
            nested,
        ]);

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ messageId: 'm1', seq: 1 });
    });

    it('shows one tile when the same file is referenced with and without a checksum, but two for different checksums', async () => {
        const path = '.happier/uploads/a.png';
        const sameFile = collectSessionMediaItems([
            agentMessage('m1', 1, mediaMeta(path, 'input', 'a'.repeat(64))),
            agentMessage('m2', 2, mediaMeta(path, 'output', null)),
        ]);
        expect(sameFile).toHaveLength(1);

        const regenerated = collectSessionMediaItems([
            agentMessage('m1', 1, mediaMeta(path, 'output', 'a'.repeat(64))),
            agentMessage('m2', 2, mediaMeta(path, 'output', 'b'.repeat(64))),
        ]);
        expect(regenerated).toHaveLength(2);
    });

    it('reuses the records of unchanged messages when a new message arrives', () => {
        const first = agentMessage('m1', 1, mediaMeta('.happier/uploads/a.png'));
        const before = collectSessionMediaItems([first]);
        const after = collectSessionMediaItems([first, agentMessage('m2', 2)]);

        expect(after[0]).toBe(before[0]);
    });
});
