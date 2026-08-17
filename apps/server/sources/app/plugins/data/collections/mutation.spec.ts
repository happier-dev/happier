import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    tx: null as unknown,
}));

vi.mock("@/storage/inTx", () => ({
    inTx: async (callback: (tx: unknown) => Promise<unknown>) => await callback(state.tx),
}));

import {
    measurePluginCollectionCandidateRowEncodedBytes,
    measurePluginCollectionStoredRowEncodedBytes,
    mutatePluginCollection,
} from "./mutation";

function createTx() {
    return {
        $executeRawUnsafe: vi.fn(async () => 1),
        $queryRawUnsafe: vi.fn(async () => [{ id: "account-1" }]),
        account: {
            findUnique: vi.fn(async () => ({
                publicKey: null,
                seq: 1,
                encryptionMode: "plain",
                contentPublicKey: null,
                contentPublicKeySig: null,
                settings: null,
                settingsVersion: 0,
            })),
        },
        accountPluginIntent: {
            findUnique: vi.fn(async () => null),
        },
    };
}

describe("plugin Collection mutation", () => {
    it("measures the complete stored row with UTF-8 bytes and canonical projection ordering", () => {
        expect(measurePluginCollectionStoredRowEncodedBytes({
            rowId: "row-🙂",
            contentEnvelope: {
                t: "plain",
                v: { zebra: "quoted \"text\"", emoji: "🙂" },
            },
            projections: [
                { fieldId: "zeta", typedEncodedValue: "\"é\"" },
                { fieldId: "alpha", typedEncodedValue: "null" },
            ],
        })).toBe(210);
    });

    it("measures a mutation candidate through the same stored-row metric", () => {
        expect(measurePluginCollectionCandidateRowEncodedBytes({
            rowId: "row-🙂",
            contentEnvelope: {
                t: "plain",
                v: { zebra: "quoted \"text\"", emoji: "🙂" },
            },
            projection: {
                zeta: "é",
                alpha: null,
            },
        })).toBe(210);
    });

    it("acquires Account transition admission before the canonical mode read", async () => {
        const tx = createTx();
        state.tx = tx;

        await expect(mutatePluginCollection({
            accountId: "account-1",
            request: {
                pluginId: "example.tasks",
                collectionId: "tasks",
                writerContext: {
                    schemaVersion: 1,
                    contractDigest: "a".repeat(43),
                },
                operations: [{
                    kind: "put",
                    rowId: "task-a",
                    expectedRevision: "absent",
                    content: { t: "plain", v: {} },
                    projection: {},
                }],
            },
        })).rejects.toMatchObject({ code: "collection_unavailable" });

        const fenceCallOrder = [
            ...tx.$executeRawUnsafe.mock.invocationCallOrder,
            ...tx.$queryRawUnsafe.mock.invocationCallOrder,
        ];
        expect(fenceCallOrder).toHaveLength(1);
        expect(fenceCallOrder[0]).toBeLessThan(
            tx.account.findUnique.mock.invocationCallOrder[0],
        );
    });
});
