import { describe, expect, it, vi } from "vitest";

import {
    matchSessionOrganizationAccountEncryptionMigrationPostStateInTx,
    migrateSessionOrganizationAccountEncryptionInTx,
    readSessionOrganizationAccountEncryptionMigrationInventoryInTx,
    SessionOrganizationAccountEncryptionMigrationConflictError,
    SessionOrganizationAccountEncryptionMigrationInvalidContentError,
    type SessionOrganizationAccountEncryptionMigrationDirective,
} from "./sessionOrganizationAccountEncryptionMigration";

const encryptedDisplay = {
    t: "encrypted" as const,
    c: "retained-ciphertext",
};
const plainFolderDisplay = {
    t: "plain" as const,
    v: { name: "Projects" },
};
const plainTagDisplay = {
    t: "plain" as const,
    v: { label: "Urgent" },
};
const plainLabelDisplay = {
    t: "plain" as const,
    v: { label: "Workspace" },
};
const rowUpdatedAt = new Date("2026-01-02T03:04:05.000Z");

function createDirective(
    overrides: Partial<
        Extract<
            SessionOrganizationAccountEncryptionMigrationDirective,
            { action: "migrate" }
        >
    > = {},
): Extract<
    SessionOrganizationAccountEncryptionMigrationDirective,
    { action: "migrate" }
> {
    return {
        action: "migrate",
        expectedVersion: 7,
        folders: [{
            folderId: "folder-1",
            expectedDisplay: encryptedDisplay,
            display: plainFolderDisplay,
        }],
        tags: [{
            tagId: "tag-1",
            expectedDisplay: encryptedDisplay,
            display: plainTagDisplay,
        }],
        labels: [{
            labelKind: "workspace",
            scopeKey: "server-1:/workspace",
            expectedDisplay: encryptedDisplay,
            display: plainLabelDisplay,
        }],
        ...overrides,
    };
}

function createRows() {
    return {
        checkpoint: { version: 7 },
        folders: [{
            id: "folder-1",
            displayDbValue: JSON.stringify(encryptedDisplay),
            updatedAt: rowUpdatedAt,
        }],
        tags: [{
            id: "tag-1",
            displayDbValue: JSON.stringify(encryptedDisplay),
            updatedAt: rowUpdatedAt,
        }],
        labels: [{
            id: "label-row-1",
            labelKind: "workspace",
            scopeKey: "server-1:/workspace",
            displayDbValue: JSON.stringify(encryptedDisplay),
            updatedAt: rowUpdatedAt,
        }],
    };
}

function createTx(overrides: {
    checkpoint?: ReturnType<typeof createRows>["checkpoint"] | null;
    folders?: ReturnType<typeof createRows>["folders"];
    tags?: ReturnType<typeof createRows>["tags"];
    labels?: ReturnType<typeof createRows>["labels"];
    updateCount?: number;
} = {}) {
    const rows = createRows();
    return {
        sessionOrganizationCheckpoint: {
            findUnique: vi.fn(async () =>
                overrides.checkpoint === undefined
                    ? rows.checkpoint
                    : overrides.checkpoint),
            updateMany: vi.fn(async () => ({
                count: overrides.updateCount ?? 1,
            })),
        },
        sessionOrganizationFolder: {
            findMany: vi.fn(async () => overrides.folders ?? rows.folders),
            updateMany: vi.fn(async () => ({
                count: overrides.updateCount ?? 1,
            })),
        },
        sessionOrganizationTag: {
            findMany: vi.fn(async () => overrides.tags ?? rows.tags),
            updateMany: vi.fn(async () => ({
                count: overrides.updateCount ?? 1,
            })),
        },
        sessionOrganizationLabel: {
            findMany: vi.fn(async () => overrides.labels ?? rows.labels),
            updateMany: vi.fn(async () => ({
                count: overrides.updateCount ?? 1,
            })),
        },
        account: {
            update: vi.fn(async () => ({ seq: 8 })),
        },
        accountChange: {
            upsert: vi.fn(),
        },
    };
}

describe("migrateSessionOrganizationAccountEncryptionInTx", () => {
    it("reads an exact all-row display inventory without filtering archived organization rows", async () => {
        const tx = createTx();

        await expect(
            readSessionOrganizationAccountEncryptionMigrationInventoryInTx({
                tx: tx as never,
                accountId: "account-1",
            }),
        ).resolves.toEqual({
            version: 7,
            folders: [{
                folderId: "folder-1",
                display: encryptedDisplay,
            }],
            tags: [{
                tagId: "tag-1",
                display: encryptedDisplay,
            }],
            labels: [{
                labelKind: "workspace",
                scopeKey: "server-1:/workspace",
                display: encryptedDisplay,
            }],
        });
        expect(
            tx.sessionOrganizationFolder.findMany,
        ).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                displayDbValue: { not: null },
            },
            select: {
                id: true,
                displayDbValue: true,
                updatedAt: true,
            },
        });
    });

    it("rejects malformed content instead of omitting it from the exact migration inventory", async () => {
        const tx = createTx({
            folders: [{
                id: "folder-1",
                displayDbValue: "{not-json",
                updatedAt: rowUpdatedAt,
            }],
        });

        await expect(
            readSessionOrganizationAccountEncryptionMigrationInventoryInTx({
                tx: tx as never,
                accountId: "account-1",
            }),
        ).rejects.toBeInstanceOf(
            SessionOrganizationAccountEncryptionMigrationInvalidContentError,
        );
    });

    it("asserts only the display-envelope inventory, preserving structural-only organization rows", async () => {
        const emptyTx = createTx({
            checkpoint: { version: 12 },
            folders: [],
            tags: [],
            labels: [],
        });

        await expect(
            migrateSessionOrganizationAccountEncryptionInTx({
                tx: emptyTx as never,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "assert_empty" },
            }),
        ).resolves.toEqual({ status: "applied" });

        const populatedTx = createTx();
        await expect(
            migrateSessionOrganizationAccountEncryptionInTx({
                tx: populatedTx as never,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "assert_empty" },
            }),
        ).resolves.toEqual({ status: "not_empty" });
        expect(
            populatedTx.sessionOrganizationFolder.updateMany,
        ).not.toHaveBeenCalled();
        expect(
            populatedTx.sessionOrganizationFolder.findMany,
        ).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                displayDbValue: { not: null },
            },
            select: {
                id: true,
                displayDbValue: true,
                updatedAt: true,
            },
        });
    });

    it.each([
        [
            "duplicate",
            createDirective({
                folders: [
                    createDirective().folders[0]!,
                    createDirective().folders[0]!,
                ],
            }),
        ],
        [
            "missing",
            createDirective({ tags: [] }),
        ],
        [
            "foreign",
            createDirective({
                labels: [{
                    ...createDirective().labels[0]!,
                    scopeKey: "another-account:/workspace",
                }],
            }),
        ],
        [
            "stale checkpoint",
            createDirective({ expectedVersion: 6 }),
        ],
        [
            "stale source envelope",
            createDirective({
                folders: [{
                    ...createDirective().folders[0]!,
                    expectedDisplay: {
                        t: "encrypted",
                        c: "different-ciphertext",
                    },
                }],
            }),
        ],
    ])("rejects a %s inventory before any write", async (_name, directive) => {
        const tx = createTx();

        await expect(
            migrateSessionOrganizationAccountEncryptionInTx({
                tx: tx as never,
                accountId: "account-1",
                toMode: "plain",
                directive,
            }),
        ).resolves.toEqual({ status: "migration_incomplete" });
        expect(
            tx.sessionOrganizationCheckpoint.updateMany,
        ).not.toHaveBeenCalled();
        expect(tx.sessionOrganizationFolder.updateMany).not.toHaveBeenCalled();
        expect(tx.sessionOrganizationTag.updateMany).not.toHaveBeenCalled();
        expect(tx.sessionOrganizationLabel.updateMany).not.toHaveBeenCalled();
    });

    it("rejects source or target envelopes that do not match the transition modes", async () => {
        const tx = createTx();
        const directive = createDirective({
            tags: [{
                ...createDirective().tags[0]!,
                display: encryptedDisplay,
            }],
        });

        await expect(
            migrateSessionOrganizationAccountEncryptionInTx({
                tx: tx as never,
                accountId: "account-1",
                toMode: "plain",
                directive,
            }),
        ).resolves.toEqual({ status: "invalid_content" });
        expect(
            tx.sessionOrganizationCheckpoint.updateMany,
        ).not.toHaveBeenCalled();
    });

    it("rejects malformed persisted display content before any write", async () => {
        const tx = createTx({
            folders: [{
                id: "folder-1",
                displayDbValue: "{not-json",
                updatedAt: rowUpdatedAt,
            }],
        });

        await expect(
            migrateSessionOrganizationAccountEncryptionInTx({
                tx: tx as never,
                accountId: "account-1",
                toMode: "plain",
                directive: createDirective(),
            }),
        ).resolves.toEqual({ status: "invalid_content" });
        expect(
            tx.sessionOrganizationCheckpoint.updateMany,
        ).not.toHaveBeenCalled();
    });

    it("supports the reverse plain-to-e2ee rewrite through the same exact owner", async () => {
        const tx = createTx({
            folders: [{
                id: "folder-1",
                displayDbValue: JSON.stringify(plainFolderDisplay),
                updatedAt: rowUpdatedAt,
            }],
            tags: [{
                id: "tag-1",
                displayDbValue: JSON.stringify(plainTagDisplay),
                updatedAt: rowUpdatedAt,
            }],
            labels: [{
                id: "label-row-1",
                labelKind: "workspace",
                scopeKey: "server-1:/workspace",
                displayDbValue: JSON.stringify(plainLabelDisplay),
                updatedAt: rowUpdatedAt,
            }],
        });
        const directive = createDirective({
            folders: [{
                folderId: "folder-1",
                expectedDisplay: plainFolderDisplay,
                display: encryptedDisplay,
            }],
            tags: [{
                tagId: "tag-1",
                expectedDisplay: plainTagDisplay,
                display: encryptedDisplay,
            }],
            labels: [{
                labelKind: "workspace",
                scopeKey: "server-1:/workspace",
                expectedDisplay: plainLabelDisplay,
                display: encryptedDisplay,
            }],
        });

        await expect(
            migrateSessionOrganizationAccountEncryptionInTx({
                tx: tx as never,
                accountId: "account-1",
                toMode: "e2ee",
                directive,
            }),
        ).resolves.toEqual({ status: "applied" });
    });

    it("rewrites only exact display envelopes, advances one checkpoint, and publishes existing scopes", async () => {
        const tx = createTx();

        await expect(
            migrateSessionOrganizationAccountEncryptionInTx({
                tx: tx as never,
                accountId: "account-1",
                toMode: "plain",
                directive: createDirective(),
            }),
        ).resolves.toEqual({ status: "applied" });

        expect(
            tx.sessionOrganizationCheckpoint.updateMany,
        ).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                version: 7,
            },
            data: {
                version: 8,
            },
        });
        expect(tx.sessionOrganizationFolder.updateMany).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                id: "folder-1",
                displayDbValue: JSON.stringify(encryptedDisplay),
            },
            data: {
                displayDbValue: JSON.stringify(plainFolderDisplay),
                updatedAt: rowUpdatedAt,
            },
        });
        expect(tx.sessionOrganizationTag.updateMany).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                id: "tag-1",
                displayDbValue: JSON.stringify(encryptedDisplay),
            },
            data: {
                displayDbValue: JSON.stringify(plainTagDisplay),
                updatedAt: rowUpdatedAt,
            },
        });
        expect(tx.sessionOrganizationLabel.updateMany).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                id: "label-row-1",
                displayDbValue: JSON.stringify(encryptedDisplay),
            },
            data: {
                displayDbValue: JSON.stringify(plainLabelDisplay),
                updatedAt: rowUpdatedAt,
            },
        });
        expect(tx.accountChange.upsert).toHaveBeenCalledTimes(3);
    });

    it("throws a typed conflict so the surrounding Account transaction rolls back every prior rewrite", async () => {
        const tx = createTx({ updateCount: 0 });

        await expect(
            migrateSessionOrganizationAccountEncryptionInTx({
                tx: tx as never,
                accountId: "account-1",
                toMode: "plain",
                directive: createDirective(),
            }),
        ).rejects.toBeInstanceOf(
            SessionOrganizationAccountEncryptionMigrationConflictError,
        );
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });
});

describe("matchSessionOrganizationAccountEncryptionMigrationPostStateInTx", () => {
    it("matches only the exact complete target inventory and advanced checkpoint", async () => {
        const directive = createDirective();
        const tx = createTx({
            checkpoint: { version: directive.expectedVersion + 1 },
            folders: [{
                id: "folder-1",
                displayDbValue: JSON.stringify(plainFolderDisplay),
                updatedAt: rowUpdatedAt,
            }],
            tags: [{
                id: "tag-1",
                displayDbValue: JSON.stringify(plainTagDisplay),
                updatedAt: rowUpdatedAt,
            }],
            labels: [{
                id: "label-row-1",
                labelKind: "workspace",
                scopeKey: "server-1:/workspace",
                displayDbValue: JSON.stringify(plainLabelDisplay),
                updatedAt: rowUpdatedAt,
            }],
        });

        await expect(
            matchSessionOrganizationAccountEncryptionMigrationPostStateInTx({
                tx: tx as never,
                accountId: "account-1",
                toMode: "plain",
                directive,
            }),
        ).resolves.toEqual({ status: "matched" });

        tx.sessionOrganizationCheckpoint.findUnique.mockResolvedValueOnce({
            version: directive.expectedVersion + 2,
        });
        await expect(
            matchSessionOrganizationAccountEncryptionMigrationPostStateInTx({
                tx: tx as never,
                accountId: "account-1",
                toMode: "plain",
                directive,
            }),
        ).resolves.toEqual({ status: "mismatch" });
        expect(tx.sessionOrganizationFolder.updateMany).not.toHaveBeenCalled();
    });
});
