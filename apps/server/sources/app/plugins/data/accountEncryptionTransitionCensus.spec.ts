import { describe, expect, it, vi } from "vitest";

import { PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX } from "@/app/kv/accountScopedKv";
import type { Tx } from "@/storage/inTx";

vi.mock("@/storage/prisma", () => ({
    getActivePrismaRuntime: () => ({ JsonNull: "json-null" }),
}));

import { inspectPluginAccountDataForEncryptionTransitionInTx } from "./accountEncryptionTransitionCensus";

function createTx(input: Readonly<{
    account?: null | Readonly<{ id: string }>;
    accountStorage?: null | Readonly<{ id: string }>;
    liveCollection?: null | Readonly<{ id: string }>;
    residualTombstone?: null | Readonly<{ id: string }>;
}> = {}) {
    const tx = {
        account: {
            findUnique: vi.fn(async () => (
                input.account === undefined ? { id: "account-1" } : input.account
            )),
        },
        userKVStore: {
            findFirst: vi.fn(async () => input.accountStorage ?? null),
        },
        pluginCollectionRow: {
            findFirst: vi.fn(async (query: Readonly<{
                where: Readonly<{ deletedAt?: unknown }>;
            }>) => {
                if (query.where.deletedAt === null) {
                    return input.liveCollection ?? null;
                }
                return input.residualTombstone ?? null;
            }),
        },
    };
    // Narrow persistence-boundary fixture; this helper only reads these delegates.
    return { tx: tx as unknown as Tx, ...tx };
}

describe("plugin Account data encryption-transition census", () => {
    it("preserves account_not_found without reading Data rows", async () => {
        const fixture = createTx({ account: null });

        await expect(inspectPluginAccountDataForEncryptionTransitionInTx(
            fixture.tx,
            "missing-account",
        )).resolves.toEqual({ status: "account_not_found" });

        expect(fixture.userKVStore.findFirst).not.toHaveBeenCalled();
        expect(fixture.pluginCollectionRow.findFirst).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "a live plugin Account-KV envelope",
            accountStorage: { id: "kv-1" },
            liveCollection: null,
            residualTombstone: null,
            expected: {
                status: "nonempty",
                accountStorage: true,
                collections: false,
                hasLiveCollection: false,
            },
        },
        {
            name: "a live Collection row",
            accountStorage: null,
            liveCollection: { id: "collection-row-1" },
            residualTombstone: null,
            expected: {
                status: "nonempty",
                accountStorage: false,
                collections: "live",
                hasLiveCollection: true,
            },
        },
        {
            name: "a residual tombstone private envelope",
            accountStorage: null,
            liveCollection: null,
            residualTombstone: { id: "collection-row-1" },
            expected: {
                status: "nonempty",
                accountStorage: false,
                collections: "invalid_tombstone",
                hasLiveCollection: false,
            },
        },
        {
            name: "both Data stores",
            accountStorage: { id: "kv-1" },
            liveCollection: { id: "collection-row-1" },
            residualTombstone: null,
            expected: {
                status: "nonempty",
                accountStorage: true,
                collections: "live",
                hasLiveCollection: true,
            },
        },
        {
            name: "a live Collection beside a residual tombstone private envelope",
            accountStorage: null,
            liveCollection: { id: "collection-row-live" },
            residualTombstone: { id: "collection-row-tombstone" },
            expected: {
                status: "nonempty",
                accountStorage: false,
                collections: "invalid_tombstone",
                hasLiveCollection: true,
            },
        },
    ])("fails PEP1 closed for $name", async ({
        accountStorage,
        liveCollection,
        residualTombstone,
        expected,
    }) => {
        const fixture = createTx({
            accountStorage,
            liveCollection,
            residualTombstone,
        });

        await expect(inspectPluginAccountDataForEncryptionTransitionInTx(
            fixture.tx,
            "account-1",
        )).resolves.toEqual(expected);

        expect(fixture.userKVStore.findFirst).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                key: { startsWith: PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX },
                value: { not: null },
            },
            select: { id: true },
        });
        expect(fixture.pluginCollectionRow.findFirst).toHaveBeenCalledWith({
            where: { accountId: "account-1", deletedAt: null },
            select: { id: true },
        });
        expect(fixture.pluginCollectionRow.findFirst).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                deletedAt: { not: null },
                contentEnvelope: { not: "json-null" },
            },
            select: { id: true },
        });
    });

    it("ignores a content-free historical tombstone while checking every live Data participant", async () => {
        const fixture = createTx();

        await expect(inspectPluginAccountDataForEncryptionTransitionInTx(
            fixture.tx,
            "account-1",
        )).resolves.toEqual({ status: "empty" });

        expect(fixture.userKVStore.findFirst).toHaveBeenCalledOnce();
        expect(fixture.pluginCollectionRow.findFirst).toHaveBeenCalledTimes(2);
    });
});
