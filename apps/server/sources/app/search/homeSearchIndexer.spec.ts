import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openHomeSearchDb } from './homeSearchDb';
import { createHomeSearchIndexer } from './homeSearchIndexer';

describe('Home search indexer', () => {
    it('reconciles canonical plain content and removes deleted rows', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-indexer-'));
        const path = join(root, 'search.sqlite');
        let rows = [{ id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 10, content: { t: 'plain', v: { type: 'text', text: 'first token' } } }];
        const indexer = await createHomeSearchIndexer({ dbPath: path, readCanonicalMessages: async () => rows });
        await expect(indexer.reconcile()).resolves.toEqual({ indexed: 1, removed: 0 });
        let db = await openHomeSearchDb({ dbPath: path });
        expect(db.search({ query: 'first' })).toHaveLength(1);
        db.close();

        rows = [];
        await expect(indexer.reconcile()).resolves.toEqual({ indexed: 0, removed: 1 });
        db = await openHomeSearchDb({ dbPath: path });
        expect(db.search({ query: 'first' })).toEqual([]);
        db.close();
        indexer.close();
    });
});
