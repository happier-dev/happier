import { describe, expect, it, vi } from "vitest";
import {
    ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS,
} from "@happier-dev/protocol";

import { createInTxHarness } from "@/app/api/testkit/txHarness";
import type { Tx } from "@/storage/inTx";

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({}));
    return { inTx, afterTx };
});

const sessionWriteService =
    await import("./sessionWriteService");

function createTx(params: Readonly<{
    rows: readonly Readonly<{
        id: string;
        accountId: string;
        metadata: string;
        metadataVersion: number;
        metadataLayoutVersion: number;
        ownerMetadata: string | null;
        agentState: string | null;
        agentStateVersion: number;
        archivedAt: Date | null;
    }>[];
    updateCounts?: readonly number[];
}>): Tx {
    let updateIndex = 0;
    let cursor = 10;
    return {
        // The migration runs inside the Account coordinator's transaction in
        // production. Preserve its post-commit wake registration contract in
        // this narrow deterministic transaction double.
        __afterTxCallbacks: [],
        session: {
            findMany: vi.fn(async () => params.rows),
            updateMany: vi.fn(async () => ({
                count: params.updateCounts?.[updateIndex++] ?? 1,
            })),
        },
        account: {
            update: vi.fn(async () => ({
                seq: ++cursor,
            })),
        },
        accountChange: {
            upsert: vi.fn(async () => ({})),
        },
    } as unknown as Tx;
}

const encryptedSource = {
    t: "encrypted",
    c:
        "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
} as const;
const plainTarget = {
    t: "plain",
    v: { v: 1 },
} as const;

describe("migrateSessionAccountEncryptionInTx", () => {
    it("rewrites exact canonical and retained encrypted layout-1 owner values through the Session tuple CAS", async () => {
        const rows = [
            {
                id: "active-session",
                accountId: "account-1",
                metadata: "shared-active",
                metadataVersion: 4,
                metadataLayoutVersion: 1,
                ownerMetadata: encryptedSource.c,
                agentState: "agent-active",
                agentStateVersion: 7,
                archivedAt: null,
            },
            {
                id: "archived-session",
                accountId: "account-1",
                metadata: "shared-archived",
                metadataVersion: 5,
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify(encryptedSource),
                agentState: null,
                agentStateVersion: 8,
                archivedAt: new Date(1_700_000_000_000),
            },
        ] as const;
        const tx = createTx({ rows });

        const result =
            await sessionWriteService
                .migrateSessionAccountEncryptionInTx({
                    tx,
                    accountId: "account-1",
                    fromMode: "e2ee",
                    toMode: "plain",
                    directive: {
                        action: "migrate",
                        items: rows.map((row) => ({
                            sessionId: row.id,
                            expectedMetadataLayoutVersion: 1 as const,
                            expectedMetadataVersion:
                                row.metadataVersion,
                            expectedAgentStateVersion:
                                row.agentStateVersion,
                            expectedOwnerMetadata:
                                encryptedSource,
                            ownerMetadata: plainTarget,
                        })),
                    },
                });

        expect(tx.session.findMany).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                OR: [
                    {
                        metadataLayoutVersion: {
                            not: 0,
                        },
                    },
                    { ownerMetadata: { not: null } },
                ],
            },
            orderBy: { id: "asc" },
            take:
                ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS
                + 1,
            select: {
                id: true,
                accountId: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
                archivedAt: true,
            },
        });
        expect(tx.session.updateMany).toHaveBeenNthCalledWith(1, {
            where: {
                accountId: "account-1",
                id: "active-session",
                metadataLayoutVersion: 1,
                metadataVersion: 4,
                ownerMetadata: encryptedSource.c,
                agentStateVersion: 7,
            },
            data: {
                ownerMetadata: JSON.stringify(plainTarget),
            },
        });
        expect(tx.session.updateMany).toHaveBeenNthCalledWith(2, {
            where: {
                accountId: "account-1",
                id: "archived-session",
                metadataLayoutVersion: 1,
                metadataVersion: 5,
                ownerMetadata: JSON.stringify(encryptedSource),
                agentStateVersion: 8,
            },
            data: {
                ownerMetadata: JSON.stringify(plainTarget),
            },
        });
        expect(tx.accountChange.upsert)
            .toHaveBeenCalledTimes(2);
        expect(result).toEqual({
            status: "applied",
            sessions: [
                {
                    session: {
                        ...rows[0],
                        ownerMetadata:
                            JSON.stringify(plainTarget),
                    },
                    ownerCursor: 11,
                },
                {
                    session: {
                        ...rows[1],
                        ownerMetadata:
                            JSON.stringify(plainTarget),
                    },
                    ownerCursor: 12,
                },
            ],
        });
    });

    it("rejects incomplete, duplicate, stale, or target-mode-mismatched inventories before mutation", async () => {
        const row = {
            id: "session-1",
            accountId: "account-1",
            metadata: "shared",
            metadataVersion: 4,
            metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify(encryptedSource),
            agentState: "agent",
            agentStateVersion: 7,
            archivedAt: null,
        } as const;
        const baseItem = {
            sessionId: row.id,
            expectedMetadataLayoutVersion: 1 as const,
            expectedMetadataVersion: row.metadataVersion,
            expectedAgentStateVersion: row.agentStateVersion,
            expectedOwnerMetadata: encryptedSource,
            ownerMetadata: plainTarget,
        };

        for (const items of [
            [],
            [baseItem, baseItem],
            [{ ...baseItem, expectedMetadataVersion: 3 }],
            [{
                ...baseItem,
                ownerMetadata: {
                    t: "encrypted",
                    c: "wrong-target-mode",
                } as const,
            }],
        ]) {
            const tx = createTx({ rows: [row] });
            const result =
                await sessionWriteService
                    .migrateSessionAccountEncryptionInTx({
                        tx,
                        accountId: "account-1",
                        fromMode: "e2ee",
                        toMode: "plain",
                        directive: {
                            action: "migrate",
                            items,
                        },
                    });

            expect(result).toEqual({
                status:
                    items.length === 1
                    && items[0]?.ownerMetadata.t
                        === "encrypted"
                        ? "invalid_content"
                        : "migration_incomplete",
            });
            expect(tx.session.updateMany).not.toHaveBeenCalled();
        }
    });

    it("fails closed on malformed or future Session layouts and assert-empty sees archived rows", async () => {
        const malformedRows = [
            {
                id: "future-session",
                accountId: "account-1",
                metadata: "shared",
                metadataVersion: 1,
                metadataLayoutVersion: 2,
                ownerMetadata: null,
                agentState: null,
                agentStateVersion: 2,
                archivedAt: null,
            },
        ] as const;
        const malformedTx = createTx({ rows: malformedRows });

        await expect(
            sessionWriteService.migrateSessionAccountEncryptionInTx({
                tx: malformedTx,
                accountId: "account-1",
                fromMode: "e2ee",
                toMode: "plain",
                directive: { action: "assert_empty" },
            }),
        ).resolves.toEqual({ status: "not_empty" });
        expect(malformedTx.session.updateMany).not.toHaveBeenCalled();

        const archivedTx = createTx({
            rows: [{
                id: "archived-session",
                accountId: "account-1",
                metadata: "shared",
                metadataVersion: 1,
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify(encryptedSource),
                agentState: null,
                agentStateVersion: 2,
                archivedAt: new Date(1_700_000_000_000),
            }],
        });
        await expect(
            sessionWriteService.migrateSessionAccountEncryptionInTx({
                tx: archivedTx,
                accountId: "account-1",
                fromMode: "e2ee",
                toMode: "plain",
                directive: { action: "assert_empty" },
            }),
        ).resolves.toEqual({ status: "not_empty" });
    });

    it("throws a typed conflict when the exact Session tuple CAS loses", async () => {
        const row = {
            id: "session-1",
            accountId: "account-1",
            metadata: "shared",
            metadataVersion: 4,
            metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify(encryptedSource),
            agentState: "agent",
            agentStateVersion: 7,
            archivedAt: null,
        } as const;
        const tx = createTx({ rows: [row], updateCounts: [0] });

        await expect(
            sessionWriteService.migrateSessionAccountEncryptionInTx({
                tx,
                accountId: "account-1",
                fromMode: "e2ee",
                toMode: "plain",
                directive: {
                    action: "migrate",
                    items: [{
                        sessionId: row.id,
                        expectedMetadataLayoutVersion: 1,
                        expectedMetadataVersion:
                            row.metadataVersion,
                        expectedAgentStateVersion:
                            row.agentStateVersion,
                        expectedOwnerMetadata:
                            encryptedSource,
                        ownerMetadata: plainTarget,
                    }],
                },
            }),
        ).rejects.toMatchObject({
            name:
                "SessionAccountEncryptionMigrationConflictError",
        });
        expect(tx.accountChange.upsert)
            .not.toHaveBeenCalled();
    });

    it("matches exact post-state read-only and rejects stale target bytes without writes or events", async () => {
        const targetRow = {
            id: "session-1",
            accountId: "account-1",
            metadata: "shared",
            metadataVersion: 4,
            metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify(plainTarget),
            agentState: "agent",
            agentStateVersion: 7,
            archivedAt: null,
        } as const;
        const directive = {
            action: "migrate",
            items: [{
                sessionId: targetRow.id,
                expectedMetadataLayoutVersion: 1,
                expectedMetadataVersion:
                    targetRow.metadataVersion,
                expectedAgentStateVersion:
                    targetRow.agentStateVersion,
                expectedOwnerMetadata:
                    encryptedSource,
                ownerMetadata: plainTarget,
            }],
        } as const;
        const matchingTx = createTx({ rows: [targetRow] });

        await expect(
            sessionWriteService
                .matchSessionAccountEncryptionMigrationPostStateInTx({
                    tx: matchingTx,
                    accountId: "account-1",
                    toMode: "plain",
                    directive,
                }),
        ).resolves.toEqual({ status: "matched" });
        expect(matchingTx.session.updateMany)
            .not.toHaveBeenCalled();
        expect(matchingTx.accountChange.upsert)
            .not.toHaveBeenCalled();

        const staleTx = createTx({
            rows: [{
                ...targetRow,
                ownerMetadata: JSON.stringify({
                    t: "plain",
                    v: { v: 1, stale: true },
                }),
            }],
        });
        await expect(
            sessionWriteService
                .matchSessionAccountEncryptionMigrationPostStateInTx({
                    tx: staleTx,
                    accountId: "account-1",
                    toMode: "plain",
                    directive,
                }),
        ).resolves.toEqual({ status: "mismatch" });
        expect(staleTx.session.updateMany)
            .not.toHaveBeenCalled();
        expect(staleTx.accountChange.upsert)
            .not.toHaveBeenCalled();
    });
});
