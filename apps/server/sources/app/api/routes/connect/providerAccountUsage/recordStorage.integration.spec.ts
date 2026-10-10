import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import { buildProviderAccountUsageRecordId } from "@happier-dev/protocol";

import { db } from "@/storage/db";
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
    readProviderAccountUsageRecord,
    readProviderAccountUsageHistory,
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


    it('retains material accepted history, omits refresh-only changes and pages the requested range', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const first = createUsageSnapshot({ fetchedAt: Date.now() - 3000 });
        const write = (snapshot: typeof first, materialFingerprint: string) => writeProviderAccountUsageRecordWithPolicy({ accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, snapshot, materialFingerprint });
        await write(first, 'first');
        await write({ ...first, fetchedAtMs: first.fetchedAtMs + 1000, observedAtMs: first.observedAtMs + 1000 }, 'first');
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

    it('publishes a content-free Account change for accepted current freshness without retaining unchanged history', async () => {
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
        expect(freshnessChanged?.cursor).toBeGreaterThan(initial!.cursor);
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
        })).resolves.toBeNull();
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
