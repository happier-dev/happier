import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openHomeSearchDb } from './homeSearchDb';
import { createHomeSearchService } from './homeSearchService';

describe('Home search service', () => {
    it('fails closed for encrypted homes and exposes identity on plain hits', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-service-'));
        const encrypted = await createHomeSearchService({ dbPath: join(root, 'encrypted.sqlite'), homeServerIdentityId: 'srv_test', storagePolicy: 'e2ee' });
        expect(encrypted.capability()).toMatchObject({ enabled: false, provider: 'daemon' });
        expect(encrypted.search({ v: 1, query: 'x', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: false, errorCode: 'memory_disabled' });
        encrypted.close();

        const path = join(root, 'plain.sqlite');
        const index = await openHomeSearchDb({ dbPath: path });
        index.upsert({ id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, text: 'plain message' });
        index.close();
        const plain = await createHomeSearchService({ dbPath: path, homeServerIdentityId: 'srv_test', storagePolicy: 'plaintext_only' });
        expect(plain.search({ v: 1, query: 'plain', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [expect.objectContaining({ homeServerIdentityId: 'srv_test' })] });
        expect(plain.search({ v: 1, query: 'plain', scope: { type: 'global' }, mode: 'auto' }, { visibleSessionIds: [] })).toMatchObject({ ok: true, hits: [] });
        expect(plain.search({ v: 1, query: 'plain', scope: { type: 'session', sessionId: 'other' }, mode: 'auto' }, { visibleSessionIds: ['s-1'] })).toMatchObject({ ok: true, hits: [] });
        plain.close();
    });
});
