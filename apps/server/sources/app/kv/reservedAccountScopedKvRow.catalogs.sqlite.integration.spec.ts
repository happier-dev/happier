import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { listReservedAccountScopedKvRowsInTx, mutateReservedAccountScopedKvRowsInTx, type ReservedAccountScopedKvRowDomain } from './reservedAccountScopedKvRow';

type Envelope = { t: 'plain'; v: { id: string } } | { t: 'encrypted'; c: string };
const domain: ReservedAccountScopedKvRowDomain<Envelope> = {
    label: 'catalog paging test',
    parseStoredEnvelope(value) {
        if (typeof value !== 'object' || value === null) return null;
        const envelope = value as { t?: unknown; v?: { id?: unknown }; c?: unknown };
        if (envelope.t === 'encrypted' && typeof envelope.c === 'string') return { t: 'encrypted', c: envelope.c };
        if (envelope.t === 'plain' && typeof envelope.v?.id === 'string') return { t: 'plain', v: { id: envelope.v.id } };
        return null;
    },
    parseCandidateEnvelope(value) { return this.parseStoredEnvelope(value); },
    assertEnvelopeForMode(envelope, mode) {
        if ((mode === 'plain') !== (envelope.t === 'plain')) throw new Error('mode mismatch');
    },
};
const guardDomain: ReservedAccountScopedKvRowDomain<never> = {
    label: 'profile reference guard',
    parseStoredEnvelope() { return null; },
    parseCandidateEnvelope() { return null; },
    assertEnvelopeForMode() { throw new Error('guard must be a tombstone'); },
};

describe('reserved catalog paging and diagnostics (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-private-catalog-' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('pages every row without truncating the complete Account inventory', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const prefix = '@happier/account/profiles/v1/';
        await db.userKVStore.createMany({ data: ['a', 'b', 'c'].map(id => ({
            accountId: account.id, key: prefix + id, version: 0,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { id } })),
        })) });
        const first = await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, { accountId: account.id, physicalPrefix: prefix, domain, limit: 2 }));
        expect(first).toMatchObject({ status: 'listed', rows: [{ physicalKey: prefix + 'a' }, { physicalKey: prefix + 'b' }], nextCursor: prefix + 'b', complete: true });
        if (first.status !== 'listed') throw new Error(first.status);
        const second = await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, { accountId: account.id, physicalPrefix: prefix, domain, limit: 2, cursor: first.nextCursor! }));
        expect(second).toMatchObject({ status: 'listed', rows: [{ physicalKey: prefix + 'c' }], nextCursor: null });
        // A valid page size beyond the retired 256-row ceiling must reach Prisma;
        // this is not a test of Prisma's signed-Int argument boundary.
        const large = await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, { accountId: account.id, physicalPrefix: prefix, domain, limit: 257 }));
        expect(large).toMatchObject({ status: 'listed', rows: [{ physicalKey: prefix + 'a' }, { physicalKey: prefix + 'b' }, { physicalKey: prefix + 'c' }], nextCursor: null, complete: true });
    });

    it('returns usable independent neighbors and explicit incomplete diagnostics, but refuses mode mismatch', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const prefix = '@happier/account/profiles/v1/';
        await db.userKVStore.createMany({ data: [
            { accountId: account.id, key: prefix + 'a', version: 0, value: new TextEncoder().encode('{"t":"plain","v":{"id":"a"}}') },
            { accountId: account.id, key: prefix + 'b', version: 4, value: new TextEncoder().encode('malformed') },
            { accountId: account.id, key: prefix + 'c', version: 7, value: null },
        ] });
        expect(await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, { accountId: account.id, physicalPrefix: prefix, domain }))).toEqual({ status: 'invalid-stored-content' });
        expect(await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, { accountId: account.id, physicalPrefix: prefix, domain, diagnostics: true }))).toMatchObject({
            status: 'listed', rows: [{ physicalKey: prefix + 'a' }, { physicalKey: prefix + 'c', revision: 7, envelope: null }], complete: false,
            diagnostics: [{ physicalKey: prefix + 'b', revision: 4, reason: 'invalid-stored-content' }],
        });
        expect(await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, { accountId: account.id, physicalPrefix: prefix, domain, cursor: prefix + 'a', limit: 1, diagnostics: true }))).toEqual({
            status: 'listed', rows: [], nextCursor: prefix + 'b', complete: false,
            diagnostics: [{ physicalKey: prefix + 'b', revision: 4, reason: 'invalid-stored-content' }],
        });
        expect(await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, { accountId: account.id, physicalPrefix: prefix, domain, cursor: prefix + 'b', limit: 1, diagnostics: true }))).toEqual({
            status: 'listed', rows: [{ physicalKey: prefix + 'c', revision: 7, envelope: null }], nextCursor: null, complete: true, diagnostics: [],
        });
        await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: prefix + 'a' } }, data: { value: new TextEncoder().encode('{"t":"encrypted","c":"opaque"}') } });
        expect(await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, { accountId: account.id, physicalPrefix: prefix, domain, diagnostics: true }))).toEqual({ status: 'account-mode-mismatch' });
    });

    it('selects an exact singleton without admitting ordinary keys sharing its prefix', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const physicalKey = '@happier/account/profile-transfer/v1';
        await db.userKVStore.createMany({ data: [
            { accountId: account.id, key: physicalKey, version: 3, value: new TextEncoder().encode('{"t":"plain","v":{"id":"control"}}') },
            { accountId: account.id, key: physicalKey + '-user', version: 11, value: new TextEncoder().encode('ordinary user content') },
        ] });
        expect(await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, {
            accountId: account.id, physicalPrefix: physicalKey, physicalKey, domain, limit: 1,
        }))).toEqual({ status: 'listed', rows: [{ physicalKey, revision: 3, envelope: { t: 'plain', v: { id: 'control' } } }],
            nextCursor: null, complete: true, diagnostics: [] });
        expect(await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, {
            accountId: account.id, physicalPrefix: physicalKey, physicalKey, domain, cursor: physicalKey, limit: 1,
        }))).toEqual({ status: 'listed', rows: [], nextCursor: null, complete: true, diagnostics: [] });
        expect(await inTx(tx => listReservedAccountScopedKvRowsInTx(tx, {
            accountId: account.id, physicalPrefix: physicalKey, domain,
        }))).toEqual({ status: 'invalid-stored-content' });
    });

    it('commits heterogeneous profile and reference-guard rows together and refuses a stale guard without writes', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const profileKey = '@happier/account/profiles/v1/a';
        const guardKey = '@happier/account/profile-reference-guard/v1';
        const markChanged = async () => 1;
        expect(await inTx(tx => mutateReservedAccountScopedKvRowsInTx(tx, {
            accountId: account.id,
            mutations: [
                { physicalKey: profileKey, expectedRevision: 'absent', envelope: { t: 'plain', v: { id: 'a' } }, domain },
                { physicalKey: guardKey, expectedRevision: 'absent', envelope: null, domain: guardDomain },
            ],
            markChanged,
        }))).toEqual({ status: 'updated', rows: [
            { physicalKey: profileKey, revision: 0, cursor: 1 },
            { physicalKey: guardKey, revision: 0, cursor: 1 },
        ] });
        expect(await inTx(tx => mutateReservedAccountScopedKvRowsInTx(tx, {
            accountId: account.id,
            mutations: [
                { physicalKey: profileKey, expectedRevision: 0, envelope: null, domain },
                { physicalKey: guardKey, expectedRevision: 'absent', envelope: null, domain: guardDomain },
            ],
            markChanged,
        }))).toEqual({ status: 'conflict', physicalKey: guardKey, revision: 0 });
        const rows = await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } });
        expect(rows.map(row => ({ key: row.key, version: row.version, deleted: row.value === null }))).toEqual([
            { key: guardKey, version: 0, deleted: true },
            { key: profileKey, version: 0, deleted: false },
        ]);
    });

    it('validates every existing row and guard candidate before writing any batch row', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const validKey = '@happier/account/profiles/v1/a';
        const corruptKey = '@happier/account/profiles/v1/b';
        await db.userKVStore.create({ data: { accountId: account.id, key: corruptKey, version: 0, value: new TextEncoder().encode('malformed') } });
        const result = await inTx(tx => mutateReservedAccountScopedKvRowsInTx(tx, {
            accountId: account.id,
            mutations: [
                { physicalKey: validKey, expectedRevision: 'absent', envelope: { t: 'plain', v: { id: 'a' } }, domain },
                { physicalKey: corruptKey, expectedRevision: 0, envelope: null, domain },
            ],
            markChanged: async () => 1,
        }));
        expect(result).toEqual({ status: 'invalid-stored-content' });
        expect(await db.userKVStore.count({ where: { accountId: account.id, key: validKey } })).toBe(0);
        expect(await inTx(tx => mutateReservedAccountScopedKvRowsInTx(tx, {
            accountId: account.id,
            mutations: [{ physicalKey: '@happier/account/profile-reference-guard/v1', expectedRevision: 'absent', envelope: { t: 'plain', v: { id: 'a' } }, domain: guardDomain }],
            markChanged: async () => 1,
        }))).toEqual({ status: 'invalid-stored-content' });
        expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(1);
    });
});
