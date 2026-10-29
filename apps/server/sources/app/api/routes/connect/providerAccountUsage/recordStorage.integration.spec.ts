import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import { buildProviderAccountUsageRecordId } from "@happier-dev/protocol";
import { buildProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { sealProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto';
import { PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { readProviderAccountUsagePageProjection, writeProviderAccountUsagePageProjection } from './pageProjectionStorage';

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    createProviderAccountUsageRecord,
    readProviderAccountUsageRecord,
    readProviderAccountUsageHistory,
    readProviderAccountUsageHistoryWitness,
    hasProviderAccountUsageHistory,
    projectProviderAccountUsageRecordV4,
    requestProviderAccountUsageRefresh,
    updateProviderAccountUsageRecordIfCurrent,
    upsertProviderAccountUsageRecord,
    writeProviderAccountUsageRecord,
} from "./recordStorage";
import {
    writeProviderAccountUsageRecordWithPolicy,
} from "./routeWritePolicy";
import {
    ProviderAccountUsagePayloadInvariantError,
} from "./types";

describe("provider account usage record storage (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-provider-account-usage-records-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it('acknowledges current-record mutations without reading a payload while its write lock is held', async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: 'plain' },
            select: { id: true },
        });
        const first = createUsageSnapshot({ fetchedAt: Date.now() - 3_000 });
        // This persistence boundary rejects the redundant roundtrip that used
        // to prolong the caller's credential/record locks. Verify actual rows
        // separately through the unwrapped database after acknowledgement.
        const write = (snapshot: typeof first) => ({
            accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: 'plain_json_v1' as const, status: 'ok' as const, snapshot,
            fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
        });
        const next = createUsageSnapshot({ fetchedAt: first.fetchedAtMs + 1_000, planLabel: 'changed' });
        await inTx(async tx => {
            const client = {
                providerAccountUsageRecord: new Proxy(tx.providerAccountUsageRecord, {
                    get(target, property, receiver) {
                        if (property === 'findUnique') return () => {
                            throw new Error('Payload read extends the current-record write lock');
                        };
                        return Reflect.get(target, property, receiver);
                    },
                }),
            };
            await expect(createProviderAccountUsageRecord(write(first), client)).resolves.toBeUndefined();
            await expect(updateProviderAccountUsageRecordIfCurrent(write(next), {
                fetchedAt: first.fetchedAtMs,
            }, client)).resolves.toBe(true);
            await expect(updateProviderAccountUsageRecordIfCurrent(write(first), {
                fetchedAt: first.fetchedAtMs,
            }, client)).resolves.toBe(false);
        });
        await expect(readProviderAccountUsageRecord({ accountId: account.id, recordId: first.recordId }))
            .resolves.toMatchObject({ fetchedAt: next.fetchedAtMs, snapshot: { planLabel: 'changed' } });
    });

    it('preserves the derived page projection across accepted latest updates without changing exact witnesses', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const first = createUsageSnapshot({ fetchedAt: Date.now() - 3000 });
        const write = (snapshot: typeof first) => writeProviderAccountUsageRecordWithPolicy({ accountId: account.id,
            recordId: first.recordId, recordKey: first.recordKey, payloadMode: 'plain_json_v1', status: 'ok',
            snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
        await write(first);
        const range = { startAtMs: first.fetchedAtMs, endAtMs: first.fetchedAtMs + 10_000 };
        const history = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId, history: { range, pageSize: 100 } });
        const witness = history.entries[0]!;
        const pageProjection = { recordId: first.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING, demand: { range, resolution: 'accepted_observations' as const },
            frontier: { id: witness.id, observedAtMs: witness.observedAtMs }, observationCount: 1,
            content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
                recordId: first.recordId, range, history: { entries: [{ id: witness.id, observedAtMs: witness.observedAtMs, snapshot: first }], nextCursor: null },
            }) }) };
        await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: first.recordId } },
            data: { metadata: { pageProjection } } });
        const { encoding: _superseded, ...superseded } = pageProjection;
        await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: first.recordId } },
            data: { metadata: { pageProjection: superseded } } });
        const readParams = { accountId: account.id, recordId: first.recordId };
        expect((await readProviderAccountUsageRecord(readParams))?.metadata?.pageProjection).toEqual(superseded);
        expect(await readProviderAccountUsagePageProjection({ ...readParams, projection: pageProjection.demand }, db))
            .toEqual({ projection: superseded, complete: true });
        await write({ ...first, fetchedAtMs: first.fetchedAtMs + 500, observedAtMs: first.observedAtMs + 500 });
        expect((await readProviderAccountUsageRecord(readParams))?.metadata?.pageProjection).toEqual(superseded);
        expect(await readProviderAccountUsageHistory({ ...readParams, history: { range, pageSize: 100 } })).toEqual(history);
        if (pageProjection.content.t !== 'plain') throw new Error('Expected plain fixture');
        const obsolete = { ...superseded, content: { t: 'plain',
            v: Object.fromEntries(Object.entries(pageProjection.content.v).filter(([key]) => key !== 'encoding')) } };
        await db.providerAccountUsageRecord.update({ where: { accountId_recordId: readParams }, data: { metadata: { pageProjection: obsolete } } });
        expect((await readProviderAccountUsageRecord(readParams))?.metadata?.pageProjection).toBeUndefined();
        expect(await readProviderAccountUsagePageProjection({ ...readParams, projection: pageProjection.demand }, db))
            .toEqual({ projection: null, complete: false });
        expect(await writeProviderAccountUsagePageProjection({ accountId: account.id, value: pageProjection }, db)).toEqual(pageProjection);
        expect(await readProviderAccountUsageHistory({ ...readParams, history: { range, pageSize: 100 } })).toEqual(history);
        await write({ ...first, planLabel: 'new plan', fetchedAtMs: first.fetchedAtMs + 1000, observedAtMs: first.observedAtMs + 1000 });
        const row = await db.providerAccountUsageRecord.findUniqueOrThrow({ where: { accountId_recordId: { accountId: account.id, recordId: first.recordId } } });
        expect(row.metadata).toMatchObject({ pageProjection });
        const accepted = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId,
            history: { range, pageSize: 100 } });
        expect(accepted.entries).toHaveLength(2);
        expect(accepted.entries[1]!.record.metadata).not.toHaveProperty('pageProjection');
        expect(await readProviderAccountUsageHistoryWitness({ accountId: account.id, recordId: first.recordId,
            witness: pageProjection.frontier })).toEqual(witness);
    });

    it('keeps an interior Pending reset witness after material changes and unchanged refreshes', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const first = createUsageSnapshot({ fetchedAt: Date.now() - 10_000 });
        const write = (offset: number, snapshot = first) => writeProviderAccountUsageRecordWithPolicy({ accountId: account.id,
            recordId: first.recordId, recordKey: first.recordKey, payloadMode: 'plain_json_v1', status: 'ok',
            fetchedAt: first.fetchedAtMs + offset, staleAfterMs: first.staleAfterMs,
            snapshot: { ...snapshot, fetchedAtMs: first.fetchedAtMs + offset, observedAtMs: first.observedAtMs + offset } });
        const middle = { ...first, planLabel: 'middle entitlement' };
        await write(0); await write(1000, middle);
        const history = { range: { startAtMs: first.fetchedAtMs, endAtMs: first.fetchedAtMs + 10_000 }, pageSize: 100 };
        const before = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId, history });
        expect(before.entries.map(entry => entry.observedAtMs)).toEqual([first.fetchedAtMs, first.fetchedAtMs + 1000]);
        const pinned = before.entries[1]!;
        const session = await db.session.create({ data: { accountId: account.id, tag: 'compact-witness', metadata: '{}', agentState: '{}' }, select: { id: true } });
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, authorAccountId: account.id,
            localId: 'held', position: 0, requestedAction: { v: 1, kind: 'reset_start', reset: {
                recordId: first.recordId, meterId: 'weekly', witness: { id: pinned.id, observedAtMs: pinned.observedAtMs },
                source: { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'connected-account' }, bindingKind: 'account' },
            } }, content: { t: 'plain', v: { text: 'held' } } } });
        const changed = { ...first, planLabel: 'changed entitlement' };
        await write(2000, changed); await write(3000, changed);
        const after = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId, history });
        expect(after.entries.map(entry => entry.observedAtMs)).toEqual([
            first.fetchedAtMs, first.fetchedAtMs + 1000, first.fetchedAtMs + 2000,
        ]);
        expect(await readProviderAccountUsageHistoryWitness({ accountId: account.id, recordId: first.recordId,
            witness: { id: pinned.id, observedAtMs: pinned.observedAtMs } })).toEqual(pinned);
    });

    it('validates each distinct projection prefix once and seeks only the remaining tail', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const first = createUsageSnapshot({ fetchedAt: Date.now() - 3000 });
        const write = (snapshot: typeof first) => writeProviderAccountUsageRecordWithPolicy({ accountId: account.id,
            recordId: first.recordId, recordKey: first.recordKey, payloadMode: 'plain_json_v1', status: 'ok',
            snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
        await write(first);
        await write({ ...first, fetchedAtMs: first.fetchedAtMs + 1000, planLabel: 'changed entitlement' });
        const params = { accountId: account.id, recordId: first.recordId };
        const range = { startAtMs: first.fetchedAtMs, endAtMs: first.fetchedAtMs + 2000 };
        const history = await readProviderAccountUsageHistory({ ...params, history: { range, pageSize: 100 } });
        const [oldest, last] = history.entries;
        if (!oldest || !last) throw new Error('Expected two accepted observations');
        expect(await hasProviderAccountUsageHistory(params, db)).toBe(true);
        const absent = { ...params, accountId: account.id + '-absent' };
        expect(await hasProviderAccountUsageHistory(absent, db)).toBe(false);
        expect(await readProviderAccountUsageHistory({ ...absent, history: { range, pageSize: 100 } }))
            .toEqual({ entries: [], nextCursor: null });
        expect(await readProviderAccountUsageHistoryWitness({ ...absent, witness: { id: last.id, observedAtMs: last.observedAtMs } })).toBeNull();
        const demand = { range, resolution: 'accepted_observations' as const };
        const projection = { recordId: first.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING, demand,
            observationCount: 2, frontier: { id: last.id, observedAtMs: last.observedAtMs },
            content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
                recordId: first.recordId, range, history: { entries: history.entries.map(entry => ({ id: entry.id,
                    observedAtMs: entry.observedAtMs, snapshot: entry.record.snapshot! })), nextCursor: null },
            }) }) };
        await db.providerAccountUsageRecord.update({ where: { accountId_recordId: params }, data: { metadata: { pageProjection: projection } } });
        const held = { demand, frontier: projection.frontier, observationCount: 2, contentMode: 'plain' as const };
        let countedRows = 0;
        // Observe the real database boundary's aggregate work. Recounting a
        // validated prefix on each polling read multiplied retained-row scans.
        const storage = { providerAccountUsageRecord: db.providerAccountUsageRecord,
            providerAccountUsageHistory: new Proxy(db.providerAccountUsageHistory, {
                get(target, property, receiver) {
                    if (property === 'count') return async (args: Pick<NonNullable<Parameters<typeof target.count>[0]>, 'where'>) => {
                        const count = await target.count(args);
                        countedRows += count;
                        return count;
                    };
                    return Reflect.get(target, property, receiver);
                },
            }) };
        const read = (heldProjection = held) => readProviderAccountUsagePageProjection({ ...params, projection: demand, heldProjection }, storage);
        expect(await read()).toMatchObject({ projection, complete: true, prefix: { complete: true } });
        expect(countedRows).toBe(2);
        countedRows = 0;
        expect(await writeProviderAccountUsagePageProjection({ accountId: account.id, value: projection }, storage)).toEqual(projection);
        expect(countedRows).toBe(2);
        const retained = await db.providerAccountUsageHistory.findUniqueOrThrow({ where: { id: last.id } });
        await db.providerAccountUsageHistory.create({ data: { ...params, id: 'zzzz-later-at-same-time',
            observedAt: retained.observedAt, payload: retained.payload! } });
        expect(await read()).toMatchObject({ projection, complete: false, prefix: { complete: false } });
        expect(await read({ ...held, observationCount: 1, frontier: { id: oldest.id, observedAtMs: oldest.observedAtMs } }))
            .toMatchObject({ projection, complete: false, prefix: { held: { observationCount: 1 }, complete: false } });
        await db.providerAccountUsageHistory.create({ data: { ...params, id: 'backdated',
            observedAt: new Date(first.fetchedAtMs + 500), payload: retained.payload! } });
        expect(await read()).toEqual({ projection: null, complete: false });
        await db.providerAccountUsageHistory.delete({ where: { id: 'backdated' } });
        await db.providerAccountUsageHistory.delete({ where: { id: oldest.id } });
        expect(await read()).toEqual({ projection: null, complete: false });
        await db.providerAccountUsageHistory.deleteMany({ where: params });
        expect(await hasProviderAccountUsageHistory(params, db)).toBe(false);
        const empty = { ...projection, observationCount: 0, frontier: null,
            content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
                recordId: first.recordId, range, history: { entries: [], nextCursor: null },
            }) }) };
        await db.providerAccountUsageRecord.update({ where: { accountId_recordId: params }, data: { metadata: { pageProjection: empty } } });
        const emptyRead = (endAtMs: number) => readProviderAccountUsagePageProjection({ ...params,
            projection: { ...demand, range: { ...range, endAtMs } },
            heldProjection: { ...held, observationCount: 0, frontier: null } }, storage);
        expect(await emptyRead(range.endAtMs)).toMatchObject({ projection: empty, complete: true, prefix: { complete: true } });
        await db.providerAccountUsageHistory.create({ data: { ...params, id: 'outside-original-range',
            observedAt: new Date(range.endAtMs), payload: retained.payload! } });
        expect(await emptyRead(range.endAtMs)).toMatchObject({ projection: empty, complete: true, prefix: { complete: true } });
        expect(await emptyRead(range.endAtMs + 1)).toMatchObject({ projection: empty, complete: false, prefix: { complete: false } });
    });

    it('reads existing uncompacted history with unknown persisted fields but keeps writes canonical', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() - 1000 });
        const write = { accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: 'plain_json_v1' as const, status: 'ok' as const, fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs, snapshot };
        await writeProviderAccountUsageRecordWithPolicy(write);
        const row = await db.providerAccountUsageHistory.findFirstOrThrow({ where: { accountId: account.id } });
        await db.providerAccountUsageHistory.update({ where: { id: row.id }, data: { payload: {
            ...write, unknownHistoryField: true, metadata: { unknownMetadata: true },
            snapshot: { ...snapshot, unknownSnapshotField: true, meters: snapshot.meters.map(meter => ({ ...meter, unknownMeterField: true })) },
        } } });
        const page = await readProviderAccountUsageHistory({ accountId: account.id, recordId: snapshot.recordId,
            history: { range: { startAtMs: snapshot.fetchedAtMs, endAtMs: snapshot.fetchedAtMs + 1 }, pageSize: 10 } });
        expect(page.entries[0]?.record.snapshot).toEqual(snapshot);
        expect(page.entries[0]?.record).not.toHaveProperty('unknownHistoryField');
        expect(await readProviderAccountUsageHistoryWitness({ accountId: account.id, recordId: snapshot.recordId,
            witness: { id: row.id, observedAtMs: snapshot.fetchedAtMs } })).toEqual(page.entries[0]);
        await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } },
            data: { recordKeyJson: { ...snapshot.recordKey, unknownKeyField: true },
                metadata: { unknownMetadata: true },
                snapshot: { ...snapshot, unknownSnapshotField: true,
                    meters: snapshot.meters.map(meter => ({ ...meter, unknownMeterField: true })) } } });
        expect((await readProviderAccountUsageRecord({ accountId: account.id, recordId: snapshot.recordId }))?.snapshot).toEqual(snapshot);
        const noncanonicalWrite = { ...write, snapshot: { ...snapshot, unknownSnapshotField: true } };
        await expect(upsertProviderAccountUsageRecord(noncanonicalWrite)).rejects.toThrow();
        for (const malformed of [
            { ...write, snapshot: { ...snapshot, staleAfterMs: 'invalid' } },
            { ...write, recordId: buildProviderAccountUsageRecordId({ ...snapshot.recordKey, accountSubjectId: 'other-account' }) },
            { ...write, payloadMode: 'sealed_account_scoped_v1' },
        ]) {
            await db.providerAccountUsageHistory.update({ where: { id: row.id }, data: { payload: malformed } });
            await expect(readProviderAccountUsageHistory({ accountId: account.id, recordId: snapshot.recordId,
                history: { range: { startAtMs: snapshot.fetchedAtMs, endAtMs: snapshot.fetchedAtMs + 1 }, pageSize: 10 } }))
                .rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);
            await expect(readProviderAccountUsageHistoryWitness({ accountId: account.id, recordId: snapshot.recordId,
                witness: { id: row.id, observedAtMs: snapshot.fetchedAtMs } }))
                .rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);
        }
    });


    it("reads predecessor plain recovery details from metadata into the intrinsic V4 snapshot", async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() - 3000 });
        const subscription = { status: "subscribed", renewal: "off", observedAtMs: snapshot.fetchedAtMs, staleAfterMs: 60000 };
        const recoveryCreditDetails = { reset_one: { remainingCount: 2, appliesToProviderLimitIds: ["weekly"] } };
        await upsertProviderAccountUsageRecord({
            accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1", status: "ok", fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs, snapshot,
        });
        // 0.2 recordStorage writes supplemental facts in metadata beside its strict base snapshot.
        await db.providerAccountUsageRecord.update({
            where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } },
            data: {
                snapshot: {
                    ...snapshot,
                    recoveryCredits: {
                        kind: "usage_limit_resets", availableCount: 1,
                        credits: [{ providerCreditId: "reset_one", kind: "rate_limit_reset", status: "available" }],
                    },
                },
                metadata: { subscription, recoveryCreditDetails },
            },
        });
        const record = await readProviderAccountUsageRecord({ accountId: account.id, recordId: snapshot.recordId });
        expect(record?.snapshot).toMatchObject({ subscription, recoveryCreditDetails, meters: snapshot.meters });
        expect(projectProviderAccountUsageRecordV4(record!, []).content)
            .toMatchObject({ t: "plain", v: { subscription, recoveryCreditDetails } });
        const nativeDetails = { reset_one: { remainingCount: 1, appliesToProviderLimitIds: [] } };
        const nativeSubscription = { ...subscription, renewal: "on" };
        await db.providerAccountUsageRecord.update({
            where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } },
            data: { snapshot: { ...snapshot, subscription: nativeSubscription, recoveryCreditDetails: nativeDetails } },
        });
        expect((await readProviderAccountUsageRecord({ accountId: account.id, recordId: snapshot.recordId }))?.snapshot)
            .toMatchObject({ subscription: nativeSubscription, recoveryCreditDetails: nativeDetails });
        const native = { ...snapshot, fetchedAtMs: snapshot.fetchedAtMs + 1000, observedAtMs: snapshot.observedAtMs + 1000 };
        await writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1", status: "ok", fetchedAt: native.fetchedAtMs,
            staleAfterMs: native.staleAfterMs, snapshot: native,
        });
        expect((await readProviderAccountUsageRecord({ accountId: account.id, recordId: snapshot.recordId }))?.snapshot)
            .not.toHaveProperty("recoveryCreditDetails");
    });

    it("preserves every credential alias when another source reports the same usage observation", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() - 3000 });
        const source = (index: number) => ({ serviceId: "openai-codex" as const, profileId: `profile-${index}`, bindingKind: "profile" as const });
        const sealed = { format: "account_scoped_v1" as const, ciphertext: "opaque-quota" };
        const write = {
            accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1" as const, status: "ok" as const, fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs, sealedPayload: { format: "account_scoped_v1" as const, ciphertext: "opaque-base" },
        };
        await upsertProviderAccountUsageRecord({ ...write, metadata: {
            materialFingerprint: "same-observation",
            legacyQuotaCompatibilityProjections: Array.from({ length: 100 }, (_, index) => ({
                source: source(index), providerAccountUsageFetchedAt: snapshot.fetchedAtMs, sealed,
            })),
        } });
        await expect(writeProviderAccountUsageRecordWithPolicy({ ...write,
            materialFingerprint: "same-observation",
            legacyQuotaCompatibility: { source: source(100), sealed },
        })).resolves.toBe("written");
        const retained = await readProviderAccountUsageRecord({ accountId: account.id, recordId: snapshot.recordId });
        const aliases = retained?.metadata?.legacyQuotaCompatibilityProjections;
        expect(aliases).toHaveLength(101);
        expect(aliases?.some(alias => alias.source.profileId === "profile-0")).toBe(true);
        expect(aliases?.some(alias => alias.source.profileId === "profile-100")).toBe(true);
    });

    it("preserves opaque recovery details in current and historical V4 encrypted projections", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() - 3000 });
        const recoveryCreditDetails = { ciphertext: "opaque-recovery-details" };
        await writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1", status: "ok", fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            sealedPayload: { format: "account_scoped_v1", ciphertext: "opaque-base", recoveryCreditDetails },
        });
        const storedSealed = { format: "account_scoped_v1", ciphertext: "opaque-base", unknownEnvelopeField: true,
            recoveryCreditDetails: { ...recoveryCreditDetails, unknownFacetField: true } };
        await db.providerAccountUsageRecord.update({
            where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } },
            data: { sealedPayload: storedSealed },
        });
        const accepted = await db.providerAccountUsageHistory.findFirstOrThrow({ where: { accountId: account.id } });
        await db.providerAccountUsageHistory.update({ where: { id: accepted.id }, data: { payload: {
            accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1", status: "ok", fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs, sealedPayload: storedSealed, unknownHistoryField: true,
        } } });
        const current = await readProviderAccountUsageRecord({ accountId: account.id, recordId: snapshot.recordId });
        expect(projectProviderAccountUsageRecordV4(current!, []).content)
            .toEqual({ t: "encrypted", c: "opaque-base", recoveryCreditDetails });
        const history = await readProviderAccountUsageHistory({
            accountId: account.id, recordId: snapshot.recordId,
            history: { range: { startAtMs: snapshot.fetchedAtMs, endAtMs: snapshot.fetchedAtMs + 1 }, pageSize: 10 },
        });
        expect(history.entries.map(entry => projectProviderAccountUsageRecordV4(entry.record, []).content))
            .toEqual([{ t: "encrypted", c: "opaque-base", recoveryCreditDetails }]);
    });

    it('retains material accepted history, omits refresh-only changes and pages the requested range', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const first = { ...createUsageSnapshot({ fetchedAt: Date.now() - 3000 }),
            diagnostics: [{ kind: 'provider_http' as const, status: 200, observedAtMs: 1, headers: { 'x-request-id': 'first' } }] };
        const write = (snapshot: typeof first, materialFingerprint: string) => writeProviderAccountUsageRecordWithPolicy({ accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, snapshot, materialFingerprint });
        await write(first, 'first');
        await write({ ...first, fetchedAtMs: first.fetchedAtMs + 1000, observedAtMs: first.observedAtMs + 1000,
            diagnostics: [{ kind: 'provider_http', status: 200, observedAtMs: 2, headers: { 'x-request-id': 'second' } }] }, 'first');
        const changed = { ...first, fetchedAtMs: first.fetchedAtMs + 2000, observedAtMs: first.observedAtMs + 2000, planLabel: 'changed entitlement' };
        await write(changed, 'changed');
        const range = { startAtMs: first.fetchedAtMs, endAtMs: changed.fetchedAtMs + 1 };
        const page = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId, history: { range, pageSize: 1 } });
        expect(page.entries.map(entry => entry.record.snapshot)).toEqual([first]);
        expect(page.nextCursor).not.toBeNull();
        const next = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId, history: { range, pageSize: 1, cursor: page.nextCursor! } });
        expect(next.entries.map(entry => entry.record.snapshot)).toEqual([changed]);
        expect(next.nextCursor).toBeNull();
    });

    it('retains reset-boundary witnesses even when plain readings have the same caller fingerprint', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const at = Date.now() - 3000;
        const base = createUsageSnapshot({ fetchedAt: at });
        const snapshots = [at, at + 1000, at + 2000].map(time => ({ ...base, observedAtMs: time, fetchedAtMs: time,
            meters: base.meters.map(meter => ({ ...meter, resetsAt: at + 1000, windowDurationMs: 10_000 })) }));
        for (const snapshot of snapshots) await writeProviderAccountUsageRecordWithPolicy({ accountId: account.id,
            recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok',
            snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, materialFingerprint: 'same-reading' });
        const history = await readProviderAccountUsageHistory({ accountId: account.id, recordId: base.recordId,
            history: { range: { startAtMs: at, endAtMs: at + 3000 }, pageSize: 10 } });
        expect(history.entries.map(entry => entry.record.snapshot)).toEqual(snapshots);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq).toBe(snapshots.length);
    });

    it('coalesces plain subscription-only observation refreshes without relying on caller fingerprints', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const first = { ...createUsageSnapshot({ fetchedAt: Date.now() - 3000 }), subscription: { status: 'subscribed' as const, renewal: 'on' as const, observedAtMs: Date.now() - 3000, staleAfterMs: 5000 } };
        const write = (snapshot: typeof first) => writeProviderAccountUsageRecordWithPolicy({ accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, snapshot });
        await write(first);
        const refreshed = { ...first, subscription: { ...first.subscription, observedAtMs: first.subscription.observedAtMs + 1000 } };
        await expect(write(refreshed)).resolves.toBe('written');
        await expect(readProviderAccountUsageRecord({ accountId: account.id, recordId: first.recordId })).resolves.toMatchObject({ snapshot: refreshed });
        await write(first);
        await expect(readProviderAccountUsageRecord({ accountId: account.id, recordId: first.recordId })).resolves.toMatchObject({ snapshot: refreshed });
        const page = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId, history: { range: { startAtMs: first.fetchedAtMs, endAtMs: first.fetchedAtMs + 3000 }, pageSize: 10 } });
        expect(page.entries.map(entry => entry.record.snapshot)).toEqual([first]);
    });

    it('retains the first actual accepted observation for pre-history latest records, without backfilling older observations', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const first = createUsageSnapshot({ fetchedAt: Date.now() - 3000 });
        await upsertProviderAccountUsageRecord({ accountId: account.id, recordId: first.recordId, recordKey: first.recordKey, payloadMode: 'plain_json_v1', status: 'ok', fetchedAt: first.fetchedAtMs, staleAfterMs: first.staleAfterMs, snapshot: first, metadata: { materialFingerprint: 'first' } });
        const observed = { ...first, fetchedAtMs: first.fetchedAtMs + 1000, observedAtMs: first.observedAtMs + 1000 };
        await writeProviderAccountUsageRecordWithPolicy({ accountId: account.id, recordId: observed.recordId, recordKey: observed.recordKey, payloadMode: 'plain_json_v1', status: 'ok', fetchedAt: observed.fetchedAtMs, staleAfterMs: observed.staleAfterMs, snapshot: observed, materialFingerprint: 'first' });
        const page = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId, history: { range: { startAtMs: first.fetchedAtMs, endAtMs: observed.fetchedAtMs + 1 }, pageSize: 10 } });
        expect(page.entries.map(entry => entry.record.snapshot)).toEqual([observed]);
    });

    it('persists accepted freshness without publishing material Account changes or retaining unchanged history', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const first = createUsageSnapshot({ fetchedAt: Date.now() - 3000 });
        const write = (snapshot: typeof first, materialFingerprint: string) => writeProviderAccountUsageRecordWithPolicy({ accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, snapshot, materialFingerprint });
        await write(first, 'first');
        const initial = await db.accountChange.findFirst({ where: { accountId: account.id, kind: 'account', entityId: 'provider-account-usage' } });
        expect(initial).toMatchObject({ hint: null });
        await write(first, 'first');
        await write({ ...first, fetchedAtMs: first.fetchedAtMs - 1, observedAtMs: first.observedAtMs - 1, planLabel: 'rejected old tier' }, 'older');
        const unchanged = await db.accountChange.findFirst({ where: { accountId: account.id, kind: 'account', entityId: 'provider-account-usage' } });
        expect(unchanged?.cursor).toEqual(initial?.cursor);
        const refreshed = { ...first, fetchedAtMs: first.fetchedAtMs + 1000, observedAtMs: first.observedAtMs + 1000 };
        await expect(write(refreshed, 'first')).resolves.toBe('written');
        await expect(readProviderAccountUsageRecord({ accountId: account.id, recordId: first.recordId })).resolves.toMatchObject({ fetchedAt: refreshed.fetchedAtMs, snapshot: refreshed });
        const freshnessChanged = await db.accountChange.findFirst({ where: { accountId: account.id, kind: 'account', entityId: 'provider-account-usage' } });
        expect(freshnessChanged?.cursor).toBe(initial!.cursor);
        const history = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId, history: { range: { startAtMs: first.fetchedAtMs, endAtMs: refreshed.fetchedAtMs + 1 }, pageSize: 10 } });
        expect(history.entries.map(entry => entry.record.snapshot)).toEqual([first]);
        await write({ ...first, fetchedAtMs: first.fetchedAtMs + 2000, observedAtMs: first.observedAtMs + 2000, planLabel: 'new tier' }, 'changed');
        const changed = await db.accountChange.findFirst({ where: { accountId: account.id, kind: 'account', entityId: 'provider-account-usage' } });
        expect(changed?.cursor).toBeGreaterThan(freshnessChanged!.cursor);
        expect(changed?.hint).toBeNull();
    });

    it("persists refresh-requested records without requiring a payload", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const recordKey = createProviderAccountUsageRecordKey();
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const refreshRequestedAt = Date.now();

        await expect(writeProviderAccountUsageRecord({
            accountId: account.id,
            recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            status: "refresh_requested",
            refreshRequestedAt,
        })).resolves.toMatchObject({
            recordId,
            status: "refresh_requested",
            refreshRequestedAt,
        });
        await expect(readProviderAccountUsageRecord({
            accountId: account.id,
            recordId,
        })).resolves.toMatchObject({
            recordId,
            status: "refresh_requested",
            refreshRequestedAt,
        });
    });

    it("rejects invalid payload-mode combinations", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        await expect(upsertProviderAccountUsageRecord({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            sealedPayload: {
                format: "account_scoped_v1",
                ciphertext: "sealed-payload",
            },
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        })).rejects.toBeInstanceOf(
            ProviderAccountUsagePayloadInvariantError,
        );
        await expect(upsertProviderAccountUsageRecord({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1",
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        })).rejects.toBeInstanceOf(
            ProviderAccountUsagePayloadInvariantError,
        );
    });

    it("rejects a payload mode that disagrees with the account mode", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "e2ee-provider-usage",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        })).rejects.toBeInstanceOf(
            ProviderAccountUsagePayloadInvariantError,
        );
        await expect(db.providerAccountUsageRecord.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    });

    it("preserves a sealed predecessor subscription when a newer quota write omits it", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const recordKey = createProviderAccountUsageRecordKey();
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const fetchedAt = Date.now() - 2_000;
        const subscription = { observedAtMs: fetchedAt - 1_000, ciphertext: "predecessor-subscription" };
        await writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id, recordId, recordKey,
            payloadMode: "sealed_account_scoped_v1", status: "ok",
            fetchedAt, staleAfterMs: 60_000,
            materialFingerprint: 'same-material',
            sealedPayload: { format: "account_scoped_v1", ciphertext: "old-quota", subscription },
        });

        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id, recordId, recordKey,
            payloadMode: "sealed_account_scoped_v1", status: "ok",
            fetchedAt: fetchedAt + 1_000, staleAfterMs: 60_000,
            materialFingerprint: 'same-material',
            sealedPayload: { format: "account_scoped_v1", ciphertext: "new-quota" },
        })).resolves.toBe("written");
        await expect(readProviderAccountUsageRecord({ accountId: account.id, recordId }))
            .resolves.toMatchObject({
                fetchedAt: fetchedAt + 1_000,
                sealedPayload: { ciphertext: "new-quota", subscription },
            });
        const history = { range: { startAtMs: fetchedAt, endAtMs: fetchedAt + 3000 }, pageSize: 10 };
        const knownMaterial = await readProviderAccountUsageHistory({ accountId: account.id, recordId, history });
        expect(knownMaterial.entries.map(entry => entry.observedAtMs)).toEqual([fetchedAt]);
        // A legacy opaque writer without a material witness cannot establish
        // equality. Keep its accepted observation rather than guessing it away.
        await writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id, recordId, recordKey,
            payloadMode: 'sealed_account_scoped_v1', status: 'ok',
            fetchedAt: fetchedAt + 1500, staleAfterMs: 60_000,
            sealedPayload: { format: 'account_scoped_v1', ciphertext: 'unknown-material-quota' },
        });
        const unknownMaterial = await readProviderAccountUsageHistory({ accountId: account.id, recordId, history });
        expect(unknownMaterial.entries.map(entry => entry.observedAtMs)).toEqual([fetchedAt, fetchedAt + 1500]);
    });

    it("preserves a plain subscription when a newer quota write omits it", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now() - 2_000;
        const subscription = {
            status: "subscribed" as const,
            renewal: "off" as const,
            observedAtMs: fetchedAt - 1_000,
            staleAfterMs: 60_000,
        };
        const previous = { ...createUsageSnapshot({ fetchedAt, planLabel: "old-quota" }), subscription };
        await writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id,
            recordId: previous.recordId,
            recordKey: previous.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt,
            staleAfterMs: previous.staleAfterMs,
            snapshot: previous,
        });
        const incoming = createUsageSnapshot({ fetchedAt: fetchedAt + 1_000, planLabel: "new-quota" });
        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id,
            recordId: incoming.recordId,
            recordKey: incoming.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt: incoming.fetchedAtMs,
            staleAfterMs: incoming.staleAfterMs,
            snapshot: incoming,
        })).resolves.toBe("written");
        await expect(readProviderAccountUsageRecord({ accountId: account.id, recordId: incoming.recordId }))
            .resolves.toMatchObject({
                fetchedAt: incoming.fetchedAtMs,
                snapshot: { planLabel: "new-quota", subscription },
            });
    });

    it("preserves refresh state and fences stale guarded updates", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now() - 30_000;
        const snapshot = createUsageSnapshot({
            fetchedAt,
            planLabel: "guarded-current",
        });
        await writeProviderAccountUsageRecord({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt,
            staleAfterMs: snapshot.staleAfterMs,
            metadata: { materialFingerprint: "same-material" },
        });
        await expect(requestProviderAccountUsageRefresh({
            accountId: account.id,
            recordId: snapshot.recordId,
        })).resolves.toBe("written");
        const refreshed = await readProviderAccountUsageRecord({
            accountId: account.id,
            recordId: snapshot.recordId,
        });
        expect(refreshed?.refreshRequestedAt).toEqual(expect.any(Number));

        const replacement = createUsageSnapshot({
            fetchedAt: fetchedAt + 10_000,
            recordKey: snapshot.recordKey,
            planLabel: "guarded-current-newer",
        });
        await expect(updateProviderAccountUsageRecordIfCurrent({
            accountId: account.id,
            recordId: replacement.recordId,
            recordKey: replacement.recordKey,
            payloadMode: "plain_json_v1",
            snapshot: replacement,
            status: "ok",
            fetchedAt: replacement.fetchedAtMs,
            staleAfterMs: replacement.staleAfterMs,
        }, {
            fetchedAt: fetchedAt - 1,
        })).resolves.toBe(false);
        await expect(readProviderAccountUsageRecord({
            accountId: account.id,
            recordId: snapshot.recordId,
        })).resolves.toMatchObject({
            snapshot: expect.objectContaining({
                planLabel: "guarded-current",
            }),
            refreshRequestedAt: refreshed?.refreshRequestedAt,
        });
    });

    it("rejects future-dated writes and lets a current observation replace a previously persisted future clock", async () => {
        const nowMs = Date.now();
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const recordKey = createProviderAccountUsageRecordKey();
        const future = createUsageSnapshot({ fetchedAt: nowMs + 600_000, recordKey, planLabel: "poisoned" });
        const current = createUsageSnapshot({ fetchedAt: nowMs, recordKey, planLabel: "recovered" });

        await writeProviderAccountUsageRecord({
            accountId: account.id,
            recordId: future.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            snapshot: future,
            status: "ok",
            fetchedAt: future.fetchedAtMs,
            staleAfterMs: future.staleAfterMs,
        });

        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id,
            recordId: current.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            snapshot: current,
            status: "ok",
            fetchedAt: current.fetchedAtMs,
            staleAfterMs: current.staleAfterMs,
        })).resolves.toBe("written");
        await expect(readProviderAccountUsageRecord({ accountId: account.id, recordId: current.recordId }))
            .resolves.toEqual(expect.objectContaining({
                fetchedAt: nowMs,
                snapshot: expect.objectContaining({ planLabel: "recovered" }),
            }));

        const futureOnlyKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_future_only" });
        const futureOnly = createUsageSnapshot({ fetchedAt: nowMs + 600_000, recordKey: futureOnlyKey, planLabel: "future-only" });
        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: account.id,
            recordId: futureOnly.recordId,
            recordKey: futureOnlyKey,
            payloadMode: "plain_json_v1",
            snapshot: futureOnly,
            status: "ok",
            fetchedAt: futureOnly.fetchedAtMs,
            staleAfterMs: futureOnly.staleAfterMs,
        })).rejects.toThrow(ProviderAccountUsagePayloadInvariantError);
        await expect(readProviderAccountUsageRecord({ accountId: account.id, recordId: futureOnly.recordId }))
            .resolves.toBeNull();
    });
});
