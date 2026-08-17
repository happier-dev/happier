import { describe, expect, it, vi } from "vitest";

import type { TransactionClient } from "@/storage/prisma";

import { ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES } from "./accountSettingsHistoryConfig";
import { recordAccountSettingsSnapshotsForWrite } from "./accountSettingsHistoryRepository";

type Snapshot = Readonly<{
    id: string;
    accountId: string;
    version: number;
    createdAt: Date;
    settingsDbValue: string | null;
}>;

function createHistoryTransaction(initialSnapshots: readonly Snapshot[]) {
    const snapshots = [...initialSnapshots];
    let nextId = initialSnapshots.length + 1;
    const accountSettingsSnapshot = {
        upsert: vi.fn(async (input: Readonly<{
            where: Readonly<{ accountId_version: Readonly<{ accountId: string; version: number }> }>;
            create: Readonly<{
                accountId: string;
                version: number;
                settingsDbValue: string | null;
            }>;
        }>) => {
            const existing = snapshots.find((snapshot) => (
                snapshot.accountId === input.where.accountId_version.accountId
                && snapshot.version === input.where.accountId_version.version
            ));
            if (existing) return existing;

            const created: Snapshot = {
                id: `snapshot-${nextId++}`,
                accountId: input.create.accountId,
                version: input.create.version,
                createdAt: new Date(input.create.version),
                settingsDbValue: input.create.settingsDbValue,
            };
            snapshots.push(created);
            return created;
        }),
        findMany: vi.fn(async (input: Readonly<{
            where: Readonly<{ accountId: string }>;
            skip?: number;
        }>) => snapshots
            .filter((snapshot) => snapshot.accountId === input.where.accountId)
            .sort((left, right) => right.version - left.version)
            .slice(input.skip ?? 0)
            .map((snapshot) => ({
                id: snapshot.id,
                settingsDbValue: snapshot.settingsDbValue,
            }))),
        deleteMany: vi.fn(async (input: Readonly<{
            where: Readonly<{
                accountId?: string;
                id?: Readonly<{ in: readonly string[] }>;
            }>;
        }>) => {
            const ids = input.where.id?.in;
            const deleted = snapshots.filter((snapshot) => (
                ids?.includes(snapshot.id)
                || (input.where.accountId !== undefined && snapshot.accountId === input.where.accountId)
            ));
            for (const snapshot of deleted) {
                snapshots.splice(snapshots.indexOf(snapshot), 1);
            }
            return { count: deleted.length };
        }),
    };

    // Narrow persistence-boundary fixture; this owner only uses the snapshot delegate.
    return {
        tx: { accountSettingsSnapshot } as unknown as TransactionClient,
        snapshots,
        accountSettingsSnapshot,
    };
}

describe("Account Settings history repository", () => {
  it("prunes oldest stored envelopes until the 16 MiB cap holds even below the count ceiling", async () => {
        const envelopeBytes = 512 * 1024;
        const storedEnvelope = "x".repeat(envelopeBytes);
        const fixture = createHistoryTransaction(
            Array.from({ length: 32 }, (_, index): Snapshot => ({
                id: `snapshot-${index + 1}`,
                accountId: "account-1",
                version: index + 1,
                createdAt: new Date(index + 1),
                settingsDbValue: storedEnvelope,
            })),
        );

        await recordAccountSettingsSnapshotsForWrite({
            tx: fixture.tx,
            previous: {
                accountId: "account-1",
                version: 33,
                settingsDbValue: storedEnvelope,
                encryptionMode: "e2ee",
            },
            next: {
                accountId: "account-1",
                version: 34,
                settingsDbValue: storedEnvelope,
                encryptionMode: "e2ee",
            },
            env: { HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: "250" },
        });

        expect(fixture.snapshots.map((snapshot) => snapshot.version).sort((left, right) => left - right))
            .toEqual(Array.from({ length: 32 }, (_, index) => index + 3));
        expect(fixture.snapshots.reduce(
            (total, snapshot) => total + Buffer.byteLength(snapshot.settingsDbValue ?? "", "utf8"),
            0,
        )).toBe(16 * 1024 * 1024);
    });

    it("prunes a contiguous oldest-first suffix when a middle snapshot exceeds the byte ceiling", async () => {
        const fixture = createHistoryTransaction([
            {
                id: "snapshot-1",
                accountId: "account-1",
                version: 1,
                createdAt: new Date(1),
                settingsDbValue: "oldest-small",
            },
            {
                id: "snapshot-2",
                accountId: "account-1",
                version: 2,
                createdAt: new Date(2),
                settingsDbValue: "x".repeat(ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES),
            },
        ]);

        await recordAccountSettingsSnapshotsForWrite({
            tx: fixture.tx,
            previous: {
                accountId: "account-1",
                version: 3,
                settingsDbValue: "newer-previous",
                encryptionMode: "e2ee",
            },
            next: {
                accountId: "account-1",
                version: 4,
                settingsDbValue: "newest-current",
                encryptionMode: "e2ee",
            },
            env: { HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: "250" },
        });

        expect(fixture.snapshots.map((snapshot) => snapshot.version).sort((left, right) => left - right))
            .toEqual([3, 4]);
    });
});
