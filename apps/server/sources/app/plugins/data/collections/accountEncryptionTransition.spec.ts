import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

vi.mock("@/storage/prisma", () => ({
    getActivePrismaRuntime: () => ({ JsonNull: "json-null" }),
}));

import {
    inspectPluginCollectionAccountEncryptionTransitionInTx,
} from "./accountEncryptionTransition";

function createTx(input: Readonly<{
    tombstone?: Readonly<{
        pluginId: string;
        collectionId: string;
        rowId: string;
        contentEnvelope: unknown;
    }> | null;
    tombstones?: readonly Readonly<{
        pluginId: string;
        collectionId: string;
        rowId: string;
        contentEnvelope: unknown;
    }>[];
}> = {}) {
    const pluginCollectionRow = {
        findFirst: vi.fn(async () => (
            input.tombstones?.find((tombstone) => tombstone.contentEnvelope !== null)
            ?? input.tombstone
            ?? null
        )),
        findMany: vi.fn(async () => []),
    };
    return {
        tx: { pluginCollectionRow } as unknown as Tx,
        pluginCollectionRow,
    };
}

describe("Collection Account-encryption transition census", () => {
    it("fails closed on a historical tombstone that still retains private content", async () => {
        const fixture = createTx({
            tombstone: {
                pluginId: "example.tasks",
                collectionId: "tasks",
                rowId: "deleted-task",
                contentEnvelope: { t: "plain", v: { privateNote: "must not survive" } },
            },
        });

        await expect(inspectPluginCollectionAccountEncryptionTransitionInTx({
            tx: fixture.tx,
            accountId: "account-1",
            sourceMode: "plain",
        })).resolves.toEqual({
            status: "invalid_content",
            row: {
                pluginId: "example.tasks",
                collectionId: "tasks",
                rowId: "deleted-task",
            },
        });

        expect(fixture.pluginCollectionRow.findFirst).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                deletedAt: { not: null },
                contentEnvelope: { not: "json-null" },
            },
            orderBy: [
                { pluginId: "asc" },
                { collectionId: "asc" },
                { rowId: "asc" },
            ],
            select: {
                pluginId: true,
                collectionId: true,
                rowId: true,
                contentEnvelope: true,
            },
        });
        expect(fixture.pluginCollectionRow.findMany).not.toHaveBeenCalled();
    });

    it("treats content-free tombstones as nonparticipants and starts every live page at the fixed 500-row bound", async () => {
        const fixture = createTx({ tombstone: null });

        await expect(inspectPluginCollectionAccountEncryptionTransitionInTx({
            tx: fixture.tx,
            accountId: "account-1",
            sourceMode: "plain",
        })).resolves.toEqual({
            status: "complete",
            items: [],
            rowCount: 0,
            sourceContentBytes: 0n,
        });

        expect(fixture.pluginCollectionRow.findMany).toHaveBeenCalledWith({
            where: { accountId: "account-1", deletedAt: null },
            orderBy: [
                { pluginId: "asc" },
                { collectionId: "asc" },
                { rowId: "asc" },
            ],
            take: 501,
            select: expect.objectContaining({
                pluginId: true,
                collectionId: true,
                rowId: true,
                revision: true,
                contentEnvelope: true,
                schemaVersion: true,
                contractDigest: true,
            }),
        });
    });

    it("does not let a content-free tombstone ordered before residual private content hide the failure", async () => {
        const fixture = createTx({
            tombstones: [
                {
                    pluginId: "example.tasks",
                    collectionId: "tasks",
                    rowId: "a-content-free",
                    contentEnvelope: null,
                },
                {
                    pluginId: "example.tasks",
                    collectionId: "tasks",
                    rowId: "z-residual",
                    contentEnvelope: { t: "plain", v: { privateNote: "must block" } },
                },
            ],
        });

        await expect(inspectPluginCollectionAccountEncryptionTransitionInTx({
            tx: fixture.tx,
            accountId: "account-1",
            sourceMode: "plain",
        })).resolves.toEqual({
            status: "invalid_content",
            row: {
                pluginId: "example.tasks",
                collectionId: "tasks",
                rowId: "z-residual",
            },
        });
    });
});
