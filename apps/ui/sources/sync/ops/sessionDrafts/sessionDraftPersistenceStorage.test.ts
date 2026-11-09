import { describe, expect, it } from 'vitest';
import { createSessionDraftPersistenceStorage } from './sessionDraftPersistenceStorage';
import { sessionDraftRowKey } from './sessionDraftSerializedScope';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const scopeKey = 'session-drafts-repository-v1:scope';
const draftKey = sessionDraftRowKey(scopeKey, 'draft');
const siblingKey = sessionDraftRowKey(scopeKey, 'sibling');
const replica = (text: string) => JSON.stringify({ text });
const legacyScope = (replicas: Record<string, string>) => JSON.stringify({ v: 2,
    replicas: Object.fromEntries(Object.entries(replicas).map(([key, text]) => [key, { text }])) });

function setup() {
    const legacy = new Map<string, string>([[scopeKey, legacyScope({ draft: 'valuable draft' })]]);
    const durable = new Map<string, string>();
    let fail = false;
    let transactions = 0;
    let readGate: Promise<void> | undefined;
    const readStarted = createDeferred<void>();
    const storage = createSessionDraftPersistenceStorage({
        legacy: {
            getAllKeys: () => [...legacy.keys()],
            getString: (key) => legacy.get(key),
            delete: (key) => { legacy.delete(key); },
        },
        records: {
            list: async () => new Map(durable),
            read: async key => { const value = durable.get(key); readStarted.resolve(); await readGate; return value; },
            // IndexedDB boundary: one transaction applies every change or none.
            updateMany: async (keys, update) => {
                if (fail) throw new Error('disk full');
                transactions++;
                const next = update(new Map(keys.map((key) => [key, durable.get(key)])));
                for (const [key, value] of next.values) {
                    if (value === undefined) durable.delete(key);
                    else durable.set(key, value);
                }
                return next.result;
            },
        },
    });
    return { storage, legacy, durable, setFail: (value: boolean) => { fail = value; }, transactions: () => transactions,
        holdRead: (gate: Promise<void>) => { readGate = gate; }, readStarted: readStarted.promise };
}

describe('browser draft persistence', () => {
    it('retains sibling typing while reacquiring a returning draft before its next edit', async () => {
        const env = setup();
        env.legacy.set(scopeKey, legacyScope({ draft: 'before move', sibling: 'sibling before typing' }));
        await env.storage.prepare();
        env.durable.set(draftKey, replica('returned from window'));
        const gate = createDeferred<void>();
        env.holdRead(gate.promise);
        const refreshing = env.storage.refresh(draftKey);
        await env.readStarted;
        env.storage.set(siblingKey, replica('sibling typed during read'));
        gate.resolve();
        await refreshing;
        expect(env.storage.getString(draftKey)).toBe(replica('returned from window'));
        await env.storage.flush();
        env.storage.set(draftKey, replica('continued in main'));
        await env.storage.flush();
        expect(env.durable.get(draftKey)).toBe(replica('continued in main'));
        expect(env.durable.get(siblingKey)).toBe(replica('sibling typed during read'));
    });

    it('keeps unseen sibling window edits when only the returned draft is reacquired', async () => {
        const env = setup();
        env.legacy.set(scopeKey, legacyScope({ draft: 'before move', sibling: 'before sibling move' }));
        await env.storage.prepare();
        env.durable.set(draftKey, replica('returned from window'));
        env.durable.set(siblingKey, replica('sibling still edited in window'));
        await env.storage.refresh(draftKey);
        env.storage.set(draftKey, replica('continued in main'));
        await env.storage.flush();
        expect(env.durable.get(draftKey)).toBe(replica('continued in main'));
        expect(env.durable.get(siblingKey)).toBe(replica('sibling still edited in window'));
    });

    it('re-reads the prior presenter after local flush without writing the durable draft', async () => {
        const env = setup();
        await env.storage.prepare();
        env.durable.set(draftKey, replica('edited in destination window'));
        const transactions = env.transactions();
        await env.storage.refresh(draftKey);
        expect(env.storage.getString(draftKey)).toBe(replica('edited in destination window'));
        expect(env.transactions()).toBe(transactions);
        env.storage.set(draftKey, replica('continued in main'));
        await env.storage.flush();
        expect(env.durable.get(draftKey)).toBe(replica('continued in main'));
    });

    it('discards queued autosaves during explicit data clearing instead of writing them back afterwards', async () => {
        const env = setup();
        await env.storage.prepare();
        env.storage.set(draftKey, replica('queued before logout'));
        await env.storage.discardPendingWrites();
        env.durable.clear();
        await env.storage.flush();
        expect(env.durable.size).toBe(0);
        expect(env.storage.getString(draftKey)).toBeUndefined();
    });

    it('retains legacy drafts until migration commits and refuses premature empty reads', async () => {
        const env = setup();
        expect(() => env.storage.getString(draftKey)).toThrow();
        env.setFail(true);
        await expect(env.storage.prepare()).rejects.toThrow('disk full');
        expect(env.legacy.size).toBe(1);
        env.setFail(false);
        await env.storage.prepare();
        expect(env.storage.getString(draftKey)).toBe(replica('valuable draft'));
        expect(env.durable.get(draftKey)).toBe(replica('valuable draft'));
        expect(env.durable.has(scopeKey)).toBe(false);
        expect(env.legacy.size).toBe(0);
    });

    it('moves a whole-scope IndexedDB record into per-draft records in one transaction, keeping envelope fields', async () => {
        const env = setup();
        env.legacy.clear();
        env.durable.set(scopeKey, JSON.stringify({ v: 2, ordinaryEntryDraftId: 'entry', replicas: {
            draft: { text: 'from 0.2' }, sibling: { text: 'other 0.2 draft' },
        } }));
        await env.storage.prepare();
        expect(env.transactions()).toBe(1);
        expect(Object.fromEntries(env.durable)).toEqual({
            [scopeKey]: JSON.stringify({ ordinaryEntryDraftId: 'entry', v: 3 }),
            [draftKey]: replica('from 0.2'),
            [siblingKey]: replica('other 0.2 draft'),
        });
        // A second tab that listed the old record before this migration committed changes nothing.
        const durableAfter = new Map(env.durable);
        const second = setup();
        second.legacy.clear();
        second.durable.set(scopeKey, JSON.stringify({ ordinaryEntryDraftId: 'entry', v: 3 }));
        await second.storage.prepare();
        expect(new Map(env.durable)).toEqual(durableAfter);
    });

    it('coalesces input writes, surfaces failed durability, and retains the latest value for retry', async () => {
        const env = setup();
        await env.storage.prepare();
        const migrated = env.transactions();
        env.setFail(true);
        env.storage.set(draftKey, replica('first'));
        env.storage.set(draftKey, replica('latest'));
        await expect(env.storage.flush()).rejects.toThrow('disk full');
        expect(env.storage.getString(draftKey)).toBe(replica('latest'));
        expect(env.durable.get(draftKey)).toBe(replica('valuable draft'));
        env.setFail(false);
        await env.storage.flush();
        expect(env.durable.get(draftKey)).toBe(replica('latest'));
        expect(env.transactions() - migrated).toBe(1);
    });

    it('keeps both copies of a divergent legacy draft in that scope and still starts', async () => {
        const env = setup();
        env.durable.set(draftKey, replica('newer draft'));
        await env.storage.prepare();
        expect(env.durable.get(draftKey)).toBe(replica('newer draft'));
        // The Web Storage copy moves unmigrated into the scope record, which the repository reads
        // as unreadable retained custody of this scope only.
        expect(env.durable.get(scopeKey)).toBe(legacyScope({ draft: 'valuable draft' }));
        expect(env.legacy.size).toBe(0);
    });

    it('does not expose an unrecognized committed record as an empty draft scope', async () => {
        for (const unknown of ['{"v":99,"replicas":{}}', 'not JSON']) {
            const env = setup();
            env.legacy.clear();
            env.durable.set(scopeKey, unknown);
            await expect(env.storage.prepare()).rejects.toThrow();
            expect(env.durable.get(scopeKey)).toBe(unknown);
        }
    });

    it('preserves another tab edit of the same draft when it was cached before its first use', async () => {
        const env = setup();
        await env.storage.prepare();
        env.durable.set(draftKey, replica('other tab edit'));
        env.storage.set(draftKey, replica('my stale edit'));
        await expect(env.storage.flush()).rejects.toThrow();
        expect(env.durable.get(draftKey)).toBe(replica('other tab edit'));
        expect(env.storage.getString(draftKey)).toBe(replica('my stale edit'));
    });

    it('commits nothing from a batch when one of its drafts was changed by another tab', async () => {
        const env = setup();
        await env.storage.prepare();
        env.durable.set(draftKey, replica('other tab edit'));
        env.storage.set(siblingKey, replica('my new sibling'));
        env.storage.set(draftKey, replica('my stale edit'));
        await expect(env.storage.flush()).rejects.toThrow();
        expect(env.durable.has(siblingKey)).toBe(false);
    });

    it('keeps unrelated concurrent drafts across repeated writes and writes only the changed record', async () => {
        const env = setup();
        await env.storage.prepare();
        env.durable.set(siblingKey, replica('another tab'));
        env.storage.set(draftKey, replica('first edit'));
        await env.storage.flush();
        env.storage.set(draftKey, replica('second edit'));
        await env.storage.flush();
        expect(env.durable.get(draftKey)).toBe(replica('second edit'));
        expect(env.durable.get(siblingKey)).toBe(replica('another tab'));
    });
});
