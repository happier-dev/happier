import { describe, expect, it, vi } from "vitest";
import type { Tx } from "@/storage/inTx";

import {
    matchAccountSettingsEncryptionMigrationPostStateInTx,
    migrateAccountSettingsEncryptionInTx,
} from "./migrateAccountSettingsEncryptionInTx";

describe("matchAccountSettingsEncryptionMigrationPostStateInTx", () => {
    it("matches exact target Settings and rejects content/version drift read-only", async () => {
        const replacementContent = {
            t: "plain" as const,
            v: { theme: "dark", nested: { enabled: true } },
        };
        const findUnique = vi.fn(async () => ({
            settingsVersion: 8,
            settings: JSON.stringify(replacementContent),
        }));
        const tx = {
            account: {
                findUnique,
                updateMany: vi.fn(),
            },
            accountChange: { upsert: vi.fn() },
            accountSettingsSnapshot: { findMany: vi.fn(async () => []) },
        } as unknown as Tx;

        await expect(
            matchAccountSettingsEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                expectedSettingsVersion: 7,
                replacementContent,
            }),
        ).resolves.toEqual({ status: "matched" });

        findUnique.mockResolvedValueOnce({
            settingsVersion: 8,
            settings: JSON.stringify({
                t: "plain",
                v: { theme: "light" },
            }),
        });
        await expect(
            matchAccountSettingsEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                expectedSettingsVersion: 7,
                replacementContent,
            }),
        ).resolves.toEqual({ status: "mismatch" });

        findUnique.mockResolvedValueOnce({
            settingsVersion: 9,
            settings: JSON.stringify(replacementContent),
        });
        await expect(
            matchAccountSettingsEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                expectedSettingsVersion: 7,
                replacementContent,
            }),
        ).resolves.toEqual({ status: "mismatch" });
        expect(tx.account.updateMany).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("matches only an exact null target and fails closed on malformed storage", async () => {
        const findUnique = vi.fn(
            async (): Promise<{
                settingsVersion: number;
                settings: string | null;
            }> => ({
                settingsVersion: 3,
                settings: null,
            }),
        );
        const tx = {
            account: { findUnique, updateMany: vi.fn() },
            accountSettingsSnapshot: { findMany: vi.fn(async () => []) },
        } as any;

        await expect(
            matchAccountSettingsEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                expectedSettingsVersion: 2,
                replacementContent: null,
            }),
        ).resolves.toEqual({ status: "matched" });

        findUnique.mockResolvedValueOnce({
            settingsVersion: 3,
            settings: "{malformed",
        });
        await expect(
            matchAccountSettingsEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                expectedSettingsVersion: 2,
                replacementContent: null,
            }),
        ).resolves.toEqual({ status: "mismatch" });
        expect(tx.account.updateMany).not.toHaveBeenCalled();
    });
});

describe("migrateAccountSettingsEncryptionInTx", () => {
    it("does not create cross-mode Settings history during an E2EE-to-plain transition", async () => {
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST", "none");
        const snapshotUpsert = vi.fn();
        const tx = {
            account: {
                findUnique: vi.fn(async () => ({
                    publicKey: "public-key",
                    encryptionMode: "e2ee",
                    settings: "encrypted-settings",
                    settingsVersion: 7,
                })),
                updateMany: vi.fn(async () => ({ count: 1 })),
            },
            accountSettingsSnapshot: {
                upsert: snapshotUpsert,
                findMany: vi.fn(async () => []),
                deleteMany: vi.fn(),
            },
        } as any;

        try {
            await expect(migrateAccountSettingsEncryptionInTx({
                tx,
                accountId: "account-1",
                fromMode: "e2ee",
                toMode: "plain",
                expectedSettingsVersion: 7,
                replacementContent: {
                    t: "plain",
                    v: { theme: "dark" },
                },
            })).resolves.toEqual({ status: "applied", settingsVersion: 8 });

            expect(snapshotUpsert).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
