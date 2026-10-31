import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '@/storage/prisma';
import { buildProviderAccountUsagePageProjectionV1, PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { sealProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { readProviderAccountUsagePageProjection, writeProviderAccountUsagePageProjection } from './pageProjectionStorage';
import { logger } from '@/utils/logging/log';
import { ProviderAccountUsagePayloadInvariantError } from './types';

const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
    providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 1, fetchedAtMs: 1,
    staleAfterMs: 100, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
const demand = { range: { startAtMs: 0, endAtMs: 3 }, resolution: 'accepted_observations' as const };
const frontier = { id: 'accepted', observedAtMs: 1 };
const value = { recordId: snapshot.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING, demand, frontier, observationCount: 1,
    content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
        recordId: snapshot.recordId, range: demand.range, history: { entries: [{ ...frontier, snapshot }], nextCursor: null },
    }) }) };

function storedRecord(metadata: unknown) {
    return { accountId: 'owner', recordId: snapshot.recordId, recordKeyJson: recordKey,
        payloadMode: 'plain_json_v1', status: 'ok', snapshot, sealedPayload: null,
        fetchedAt: new Date(snapshot.fetchedAtMs), staleAfterMs: snapshot.staleAfterMs,
        refreshRequestedAt: null, metadata };
}

function databaseBoundary() {
    const findUnique = vi.fn().mockResolvedValue(storedRecord({ materialFingerprint: 'retained', pageProjection: value }));
    const count = vi.fn().mockResolvedValue(1);
    const findFirst = vi.fn().mockImplementation(async args => args.select.observedAt
        ? { id: frontier.id, observedAt: new Date(frontier.observedAtMs) } : null);
    const update = vi.fn().mockResolvedValue({ count: 1 });
    // Prisma is the genuine database boundary. The integration suite owns SQL,
    // transaction/source admission and exact immutable witness verification.
    const storage = { providerAccountUsageRecord: { findUnique, update, updateMany: update }, providerAccountUsageHistory: { count, findFirst } } as unknown as
        Pick<TransactionClient, 'providerAccountUsageRecord' | 'providerAccountUsageHistory'>;
    return { storage, findUnique, count, findFirst, update };
}

describe('B page projection persistence', () => {
    it('distinguishes null-ingress branches without logging protected content', async () => {
        // Logging is the process output boundary; storage and its branch logic remain real.
        const output = vi.spyOn(logger, 'info').mockImplementation(() => {});
        try {
            const db = databaseBoundary();
            const params = { accountId: 'owner', recordId: snapshot.recordId, projection: demand };
            db.findUnique.mockResolvedValueOnce({ metadata: {} });
            await readProviderAccountUsagePageProjection(params, db.storage);
            if (value.content.t !== 'plain') throw new Error('Expected plain fixture');
            db.findUnique.mockResolvedValueOnce({ metadata: { pageProjection: { ...value,
                demand: { ...demand, range: { startAtMs: 1, endAtMs: 3 } },
                content: { ...value.content, v: { ...value.content.v, range: { startAtMs: 1, endAtMs: 3 } } } } } });
            await readProviderAccountUsagePageProjection(params, db.storage);
            db.count.mockResolvedValue(2);
            await readProviderAccountUsagePageProjection(params, db.storage);
            const diagnostics = output.mock.calls.map(([entry]) => entry);
            expect(diagnostics).toEqual(['absent', 'range', 'prefix'].map(reason => ({
                module: 'provider-account-usage', event: 'page_projection_read', recordId: snapshot.recordId,
                reason, range: demand.range,
            })));
        } finally { output.mockRestore(); }
    });
    it('refuses unsupported development bodies as invalid content without writing a replacement', async () => {
        const db = databaseBoundary();
        if (value.content.t !== 'plain') throw new Error('Expected plain fixture');
        const unsupported = { ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'encoding')),
            content: { t: 'plain', v: Object.fromEntries(Object.entries(value.content.v).filter(([key]) => key !== 'encoding')) } };
        db.findUnique.mockResolvedValue(storedRecord({ materialFingerprint: 'retained', pageProjection: unsupported }));
        await expect(readProviderAccountUsagePageProjection({ accountId: 'owner', recordId: snapshot.recordId, projection: demand }, db.storage))
            .rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);
        expect(db.update).not.toHaveBeenCalled();
    });
    it('reuses a complete admitted prefix and distinguishes a new tail from a changed prefix', async () => {
        const db = databaseBoundary();
        const params = { accountId: 'owner', recordId: snapshot.recordId, projection: demand };
        expect(await readProviderAccountUsagePageProjection(params, db.storage)).toEqual({ projection: value, complete: true });
        db.findFirst.mockResolvedValueOnce({ id: frontier.id, observedAt: new Date(frontier.observedAtMs) })
            .mockResolvedValueOnce({ id: 'tail', observedAt: new Date(2) });
        expect(await readProviderAccountUsagePageProjection(params, db.storage)).toEqual({ projection: value, complete: false });
        db.count.mockReset().mockResolvedValue(2);
        expect(await readProviderAccountUsagePageProjection(params, db.storage)).toEqual({ projection: null, complete: false });
        expect(await readProviderAccountUsagePageProjection({ ...params, projection: { ...demand, range: { startAtMs: 0, endAtMs: 5 } } }, db.storage))
            .toEqual({ projection: null, complete: false });
    });

    it('admits only the complete accepted count/frontier and preserves sibling metadata', async () => {
        const db = databaseBoundary();
        const metadata = { materialFingerprint: 'retained', futureField: { retained: true } };
        db.findUnique.mockResolvedValue(storedRecord(metadata));
        expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value }, db.storage)).toEqual(value);
        expect(db.update.mock.calls[0]?.[0].data.metadata).toEqual({ ...metadata, pageProjection: value });
        db.update.mockClear();
        db.count.mockResolvedValue(2);
        expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value }, db.storage)).toBeNull();
        expect(db.update).not.toHaveBeenCalled();
        db.count.mockResolvedValue(1);
        db.findFirst.mockResolvedValue({ id: 'different', observedAt: new Date(1) });
        expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value }, db.storage)).toBeNull();
        expect(db.update).not.toHaveBeenCalled();
    });

    it('does not rewrite accepted coverage even when another client reseals it or extends an empty tail', async () => {
        const db = databaseBoundary();
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const projection = buildProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId,
            range: demand.range, history: { entries: [{ ...frontier, snapshot }], nextCursor: null } });
        const sealed = { ...value, content: sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'e2ee', material,
            randomBytes: length => new Uint8Array(length).fill(1) }) };
        db.findUnique.mockResolvedValue(storedRecord({ pageProjection: sealed }));
        for (let index = 0; index < 10; index++) {
            const range = { ...demand.range, endAtMs: demand.range.endAtMs + index };
            expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value: { ...sealed,
                demand: { ...demand, range },
                content: sealProviderAccountUsagePageProjectionV1({ projection: { ...projection, range }, accountMode: 'e2ee', material,
                    randomBytes: length => new Uint8Array(length).fill(index + 2) }) } }, db.storage)).toEqual(sealed);
        }
        expect(db.update).not.toHaveBeenCalled();
        db.count.mockResolvedValue(2);
        db.findFirst.mockResolvedValue({ id: 'next', observedAt: new Date(2) });
        expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value: { ...sealed,
            observationCount: 2, frontier: { id: 'next', observedAtMs: 2 },
            content: sealProviderAccountUsagePageProjectionV1({ projection: buildProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId,
                range: demand.range, history: { entries: [{ ...frontier, snapshot }, { id: 'next', observedAtMs: 2,
                    snapshot: { ...snapshot, observedAtMs: 2, fetchedAtMs: 2 } }], nextCursor: null } }), accountMode: 'e2ee', material,
                randomBytes: length => new Uint8Array(length).fill(20) }) } }, db.storage)).toMatchObject({ observationCount: 2, frontier: { id: 'next', observedAtMs: 2 } });
        expect(db.update).toHaveBeenCalledTimes(1);
    });

    it('transfers the retained projection metadata once when acknowledging unchanged accepted history', async () => {
        const db = databaseBoundary();
        const metadata = { materialFingerprint: 'retained', pageProjection: value };
        let transferredBytes = 0;
        // Prisma transport is the boundary: the loaded QA record carries a multi-MB
        // ciphertext here. Re-reading that body amplifies I/O inside its transaction.
        db.findUnique.mockImplementation(async () => {
            transferredBytes += new TextEncoder().encode(JSON.stringify(metadata)).length;
            return storedRecord(metadata);
        });
        expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value }, db.storage)).toEqual(value);
        expect(transferredBytes).toBe(new TextEncoder().encode(JSON.stringify(metadata)).length);
        expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects retained coverage belonging to another record even when its range and frontier match', async () => {
        const db = databaseBoundary();
        const alternateKey = { ...recordKey, accountSubjectId: 'another-account' };
        const alternate = { ...snapshot, recordKey: alternateKey, recordId: buildProviderAccountUsageRecordId(alternateKey) };
        const wrongRecord = { ...value, recordId: alternate.recordId,
            content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
                recordId: alternate.recordId, range: demand.range,
                history: { entries: [{ ...frontier, snapshot: alternate }], nextCursor: null },
            }) }) };
        db.findUnique.mockResolvedValue(storedRecord({ pageProjection: wrongRecord }));
        await expect(writeProviderAccountUsagePageProjection({ accountId: 'owner', value }, db.storage))
            .rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);
        expect(db.update).not.toHaveBeenCalled();
    });

    it('replaces a retained envelope that does not match the admitted write mode', async () => {
        const db = databaseBoundary();
        db.findUnique.mockResolvedValue(storedRecord({ pageProjection: { ...value, content: { t: 'encrypted', c: 'opaque' } } }));
        expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value }, db.storage)).toEqual(value);
        expect(db.update).toHaveBeenCalledTimes(1);
    });
});
