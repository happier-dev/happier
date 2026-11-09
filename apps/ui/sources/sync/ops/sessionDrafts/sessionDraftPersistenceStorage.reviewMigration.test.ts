import { describe, expect, it } from 'vitest';
import { createSessionDraftPersistenceStorage } from './sessionDraftPersistenceStorage';
import { sessionDraftRowKey } from './sessionDraftSerializedScope';

// P03-REVIEW-DRAFT-WRITE discriminating tests for the whole-scope -> per-draft migration.
const scopeA = 'session-drafts-repository-v1:3:srv1:a';
const scopeB = 'session-drafts-repository-v1:3:srv1:b';
const replica = (text: string) => JSON.stringify({ text });
const legacyScope = (replicas: Record<string, string>) => JSON.stringify({ v: 2, ordinaryEntryDraftId: null,
    replicas: Object.fromEntries(Object.entries(replicas).map(([key, text]) => [key, { text }])) });

function setup(durable: Map<string, string>, afterList?: () => void) {
    return createSessionDraftPersistenceStorage({
        legacy: { getAllKeys: () => [], getString: () => undefined, delete: () => {} },
        records: {
            list: async () => { const snapshot = new Map(durable); const hook = afterList; afterList = undefined; hook?.(); return snapshot; },
            read: async (key) => durable.get(key),
            // IndexedDB boundary: the transaction reads only the requested keys; all-or-nothing.
            updateMany: async (keys, update) => {
                const next = update(new Map(keys.map((key) => [key, durable.get(key)])));
                for (const [key, value] of next.values) {
                    if (value === undefined) durable.delete(key);
                    else durable.set(key, value);
                }
                return next.result;
            },
        },
    });
}

describe('draft migration review', () => {
    it('a divergent legacy record in one scope does not stop every other scope (and app boot) from loading', async () => {
        // Scope A: a whole-scope v2 record re-created by an older writer for an address whose
        // per-draft row already holds a newer draft. Scope B is unrelated and healthy.
        const durable = new Map<string, string>([
            [scopeA, legacyScope({ 'session/s1': 'older copy' })],
            [sessionDraftRowKey(scopeA, 'session/s1'), replica('newer row')],
            [sessionDraftRowKey(scopeB, 'session/s2'), replica('unrelated draft')],
        ]);
        const storage = setup(durable);
        await expect(storage.prepare()).resolves.toBeUndefined();
        expect(storage.getString(sessionDraftRowKey(scopeB, 'session/s2'))).toBe(replica('unrelated draft'));
    });

    it('never overwrites an existing row for a replica that appears in the legacy record only after listing', async () => {
        const siblingRow = sessionDraftRowKey(scopeA, 'session/s2');
        const durable = new Map<string, string>([[scopeA, legacyScope({ 'session/s1': 'draft one' })]]);
        const storage = setup(durable, () => {
            // Between list and the migration transaction a sibling writer rewrites the legacy
            // record (now also holding s2) while a newer s2 row already exists.
            durable.set(scopeA, legacyScope({ 'session/s1': 'draft one', 'session/s2': 'older s2' }));
            durable.set(siblingRow, replica('newer s2 row'));
        });
        await storage.prepare().catch(() => {});
        expect(durable.get(siblingRow)).toBe(replica('newer s2 row'));
    });
});
