import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptRawRecordV1Schema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { HOME_SEARCH_SESSION_CONSTRAINT_BATCH_SIZE, openHomeSearchDb } from './homeSearchDb';
import { createHomeSearchIndexer, type HomeSearchCanonicalMessage } from './homeSearchIndexer';

function pagedReader(readRows: () => readonly Parameters<ReturnType<typeof createHomeSearchIndexer>['notify']>[0][]) {
    return async ({ afterId, limit, sessionIds }: { afterId?: string; limit: number; sessionIds: readonly string[] }) => {
        const rows = [...readRows()].filter(row => sessionIds.includes(row.sessionId)).sort((left, right) => left.id.localeCompare(right.id));
        const messages = rows.filter((row) => !afterId || row.id > afterId).slice(0, limit);
        const nextAfterId = messages.length === limit ? messages.at(-1)?.id : undefined;
        return { messages, ...(nextAfterId ? { nextAfterId } : {}) };
    };
}

describe('Home search indexer', () => {
    it('pages each demanded scope batch without losing Sessions beyond the SQLite binding boundary', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-scope-batches-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        const rows = Array.from({ length: HOME_SEARCH_SESSION_CONSTRAINT_BATCH_SIZE + 1 }, (_, index) => ({
            id: `scope-${String(index).padStart(4, '0')}`, sessionId: `session-${index}`, seq: 1, createdAtMs: index,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'bounded scope phrase' } } },
        }));
        const pages: number[] = [];
        const indexer = createHomeSearchIndexer({ db, readCanonicalMessagesPage: async input => {
            pages.push(input.sessionIds.length);
            expect(input.limit).toBe(250);
            return pagedReader(() => rows)(input);
        } });
        try {
            const result = await indexer.reconcile(rows.map(row => row.sessionId));
            expect(result.indexed).toBe(rows.length);
            expect(db.count()).toBe(rows.length);
            expect(pages).toEqual([HOME_SEARCH_SESSION_CONSTRAINT_BATCH_SIZE, HOME_SEARCH_SESSION_CONSTRAINT_BATCH_SIZE, 1]);
        } finally { await indexer.stop(); db.close(); }
    });

    it('reconciles canonical plain content and removes deleted rows', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-'));
        const path = join(root, 'search.sqlite');
        let rows = [{ id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 10, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'first token' } } } }];
        const db = await openHomeSearchDb({ dbPath: path });
        const indexer = createHomeSearchIndexer({ db, readCanonicalMessagesPage: pagedReader(() => rows) });
        await expect(indexer.reconcile(['s-1'])).resolves.toEqual({ indexed: 1, removed: 0 });
        expect(db.search({ query: 'first' })).toHaveLength(1);

        rows = [];
        await expect(indexer.reconcile(['s-1'])).resolves.toEqual({ indexed: 0, removed: 1 });
        expect(db.search({ query: 'first' })).toEqual([]);
        await indexer.stop();
        db.close();
    });

    it('reconciles edits so only current canonical text stays searchable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-edit-'));
        const path = join(root, 'search.sqlite');
        let rows = [{ id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 10, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'original wording' } } } }];
        const db = await openHomeSearchDb({ dbPath: path });
        const indexer = createHomeSearchIndexer({ db, readCanonicalMessagesPage: pagedReader(() => rows) });
        await indexer.reconcile(['s-1']);

        rows = [{ id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 10, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'revised wording' } } } }];
        await indexer.reconcile(['s-1']);
        expect(db.search({ query: 'original' })).toEqual([]);
        expect(db.search({ query: 'revised' })).toHaveLength(1);
        await indexer.stop();
        db.close();
    });

    it('extracts nested plaintext message content and removes a row when an edit becomes empty', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-nested-'));
        const path = join(root, 'search.sqlite');
        const rows = [{
            id: 'm-nested',
            sessionId: 's-1',
            seq: 1,
            createdAtMs: 10,
            content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'nested phrase' } } },
        }];
        const db = await openHomeSearchDb({ dbPath: path });
        const indexer = createHomeSearchIndexer({ db, readCanonicalMessagesPage: pagedReader(() => rows) });
        await indexer.reconcile(['s-1']);
        expect(db.search({ query: 'nested' })).toHaveLength(1);

        indexer.notify({ ...rows[0]!, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: '' } } } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(db.search({ query: 'nested' })).toEqual([]);
        await indexer.stop();
        db.close();
    });

    it('indexes canonical ACP and Codex plaintext bodies stored beneath content.data', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-native-agent-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        const rows = [
            {
                id: 'm-acp',
                sessionId: 's-1',
                seq: 1,
                createdAtMs: 10,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            agentId: 'agent',
                            data: { type: 'text', text: 'native acp phrase' },
                        },
                    },
                },
            },
            {
                id: 'm-codex',
                sessionId: 's-1',
                seq: 2,
                createdAtMs: 20,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'codex',
                            data: { type: 'message', message: 'released codex phrase' },
                        },
                    },
                },
            },
        ];
        const indexer = createHomeSearchIndexer({ db, readCanonicalMessagesPage: pagedReader(() => rows) });

        await expect(indexer.reconcile(['s-1'])).resolves.toEqual({ indexed: 2, removed: 0 });
        expect(db.search({ query: 'native' }).map((hit) => hit.id)).toEqual(['m-acp']);
        expect(db.search({ query: 'released' }).map((hit) => hit.id)).toEqual(['m-codex']);

        await indexer.stop();
        db.close();
    });

    it('indexes protocol-accepted assistant text stored beneath data.message.content', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-assistant-message-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'canonical nested phrase' }],
                    },
                },
            },
        };
        expect(TranscriptRawRecordV1Schema.safeParse(rawRecord).success).toBe(true);
        const rows = [{
            id: 'm-assistant', sessionId: 's-1', seq: 1, createdAtMs: 10,
            content: { t: 'plain', v: rawRecord },
        }];
        const indexer = createHomeSearchIndexer({ db, readCanonicalMessagesPage: pagedReader(() => rows) });

        await expect(indexer.reconcile(['s-1'])).resolves.toEqual({ indexed: 1, removed: 0 });
        expect(db.search({ query: 'canonical' }).map((hit) => hit.id)).toEqual(['m-assistant']);

        await indexer.stop();
        db.close();
    });

    it('indexes protocol-accepted ACP tool-result text through the canonical semantic projection', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-acp-tool-result-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'opencode',
                data: {
                    type: 'tool-result',
                    callId: 'call-1',
                    id: 'tool-result-1',
                    output: [{ type: 'text', text: 'protocol visible tool evidence' }],
                },
            },
        };
        expect(TranscriptRawRecordV1Schema.safeParse(rawRecord).success).toBe(true);
        const indexer = createHomeSearchIndexer({
            db,
            readCanonicalMessagesPage: pagedReader(() => [{
                id: 'm-tool-result',
                sessionId: 's-1',
                seq: 1,
                createdAtMs: 10,
                content: { t: 'plain', v: rawRecord },
            }]),
        });

        await expect(indexer.reconcile(['s-1'])).resolves.toEqual({ indexed: 1, removed: 0 });
        expect(db.search({ query: 'protocol visible' }).map((hit) => hit.id)).toEqual(['m-tool-result']);

        await indexer.stop();
        db.close();
    });

    it('normalizes only the FTS projection while preserving sanitized canonical plaintext in results', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-normalization-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        const originalText = '  Full-width ＡＰＩ＿ＫＥＹ\u0000 remains visible  ';
        const indexer = createHomeSearchIndexer({
            db,
            readCanonicalMessagesPage: pagedReader(() => [{
                id: 'm-normalized',
                sessionId: 's-1',
                seq: 1,
                createdAtMs: 10,
                content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: originalText } } },
            }]),
        });

        await expect(indexer.reconcile(['s-1'])).resolves.toEqual({ indexed: 1, removed: 0 });
        const hit = db.search({ query: 'API_KEY' })[0];
        expect(hit).toMatchObject({
            id: 'm-normalized',
            text: 'Full-width ＡＰＩ＿ＫＥＹ remains visible',
        });
        expect(hit?.snippet).toContain('ＡＰＩ＿ＫＥＹ');
        expect(hit?.snippet).not.toContain('\u0000');

        await indexer.stop();
        db.close();
    });

    it('indexes only explicitly plain envelopes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-envelope-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        const rows = [
            { id: 'plain', sessionId: 's-1', seq: 1, createdAtMs: 1, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'allowed phrase' } } } },
            { id: 'encrypted', sessionId: 's-1', seq: 2, createdAtMs: 2, content: { t: 'encrypted', c: 'forbidden phrase' } },
            { id: 'unwrapped', sessionId: 's-1', seq: 3, createdAtMs: 3, content: { type: 'text', text: 'malformed phrase' } },
        ];
        const indexer = createHomeSearchIndexer({ db, readCanonicalMessagesPage: pagedReader(() => rows) });
        await indexer.reconcile(['s-1']);
        expect(db.search({ query: 'allowed' })).toHaveLength(1);
        expect(db.search({ query: 'forbidden' })).toEqual([]);
        expect(db.search({ query: 'malformed' })).toEqual([]);
        await indexer.stop();
        db.close();
    });

    it('reconciles a bounded large transcript across many pages without truncating message content', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-scale-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        const largeTailToken = 'tailTokenZZQ9';
        const fillerLine = 'const value = computeModuleBoundaries(offsetIndex); // routine source line\n';
        const largeText = fillerLine.repeat(2000) + `export const ${largeTailToken} = true;`;
        const rows: HomeSearchCanonicalMessage[] = [];
        for (let i = 0; i < 1200; i += 1) {
            rows.push({
                id: `m-${String(i).padStart(5, '0')}`,
                sessionId: `s-${i % 3}`,
                seq: i,
                createdAtMs: i,
                content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: `routine transcript entry ${i} with searchable marker` } } },
            });
        }
        rows.push({
            id: 'm-large', sessionId: 's-0', seq: 1201, createdAtMs: 1201,
            content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: largeText } } },
        });
        const indexer = createHomeSearchIndexer({ db, readCanonicalMessagesPage: pagedReader(() => rows) });

        // 1,201 rows over three sessions force several 250-row reconciliation pages.
        await expect(indexer.reconcile(['s-0', 's-1', 's-2'])).resolves.toEqual({ indexed: 1201, removed: 0 });
        // The unique token lives at the very end of the largest message: indexing had no size cap.
        expect(db.search({ query: largeTailToken }).map((hit) => hit.id)).toEqual(['m-large']);
        expect(db.search({ query: 'routine transcript entry', maxResults: 5 })).toHaveLength(5);
        await indexer.stop();
        db.close();
    }, 60_000);

    it('refuses deliveries before the lifecycle settles the startup projection and applies live deliveries after', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-settle-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        const indexer = createHomeSearchIndexer({
            db,
            readCanonicalMessagesPage: pagedReader(() => [
                { id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'startup row' } } } },
            ]),
        });
        // Pre-settlement catch-up is owned by the search lifecycle's bounded dirty projection;
        // silent indexer-side buffering retained an unbounded event list.
        expect(() => indexer.notify({ id: 'm-2', sessionId: 's-1', seq: 2, createdAtMs: 2, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'early row' } } } }))
            .toThrowError(/settles the startup projection/iu);
        indexer.start(['s-1']);
        await indexer.whenReady();
        expect(db.search({ query: 'early' })).toEqual([]);
        expect(db.search({ query: 'startup' })).toHaveLength(1);

        indexer.notify({ id: 'm-2', sessionId: 's-1', seq: 2, createdAtMs: 2, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'first live row' } } } });
        indexer.notify({ id: 'm-3', sessionId: 's-1', seq: 3, createdAtMs: 3, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'second settled row' } } } });
        await indexer.whenIdle();
        expect(db.search({ query: 'first live' })).toHaveLength(1);
        expect(db.search({ query: 'second settled' })).toHaveLength(1);
        await indexer.stop();
        db.close();
    });
});
