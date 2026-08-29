import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openHomeSearchDb } from './homeSearchDb';

describe('Home search FTS5 owner', () => {
    it('indexes Unicode and code identifiers, returns snippets, and persists watermarks', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-search-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'derived', 'search.sqlite') });
        db.upsert({
            id: 'm-1', sessionId: 's-1', seq: 3, createdAtMs: 1_000, role: 'agent',
            text: 'Réponse — 東京 API_KEY_42',
        });
        db.setWatermark('s-1', 3);
        expect(db.getWatermark('s-1')).toBe(3);
        expect(db.search({ query: '東京' })).toEqual([
            expect.objectContaining({ sessionId: 's-1', seqFrom: 3, snippet: expect.stringContaining('東京') }),
        ]);
        expect(db.search({ query: 'API_KEY_42' })).toHaveLength(1);
        expect(db.search({ query: 'API_KEY_*' })).toHaveLength(1);
        db.close();
        expect((await readFile(join(root, 'derived', 'search.sqlite'))).byteLength).toBeGreaterThan(0);
    });

    it('replaces edits and removes deleted messages without touching canonical data', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-search-edit-'));
        const db = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        db.upsert({ id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, text: 'old unique token' });
        db.upsert({ id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, text: 'new unique token' });
        expect(db.search({ query: 'old' })).toEqual([]);
        expect(db.search({ query: 'new' })).toHaveLength(1);
        db.remove('m-1');
        expect(db.search({ query: 'new' })).toEqual([]);
        db.close();
    });
});
