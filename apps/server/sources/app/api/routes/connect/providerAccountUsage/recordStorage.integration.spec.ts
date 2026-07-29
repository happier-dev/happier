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
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    readProviderAccountUsageRecord,
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
});
