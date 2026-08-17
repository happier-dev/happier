import { describe, expect, it, vi } from "vitest";

import {
    matchAccountSettingsEncryptionMigrationPostStateInTx,
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
        } as any;

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
