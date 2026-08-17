import { afterEach, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from "./accountSessionOwnerMetadataFence";

describe("acquireAccountSessionOwnerMetadataFenceInTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        restoreEnv(envSnapshot);
    });

    it.each([
        {
            provider: "postgres",
            query: 'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE',
        },
        {
            provider: "pglite",
            query: 'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE',
        },
        {
            provider: "mysql",
            query: "SELECT `id` FROM `Account` WHERE `id` = ? FOR UPDATE",
        },
    ] as const)("locks exactly one Account row on $provider", async ({ provider, query }) => {
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
        });
        const queryRawUnsafe = vi.fn(async () => [{ id: "account-1" }]);
        const tx = { $queryRawUnsafe: queryRawUnsafe } as unknown as Tx;

        await acquireAccountSessionOwnerMetadataFenceInTx(tx, "account-1");

        expect(queryRawUnsafe).toHaveBeenCalledWith(query, "account-1");
    });

    it("reserves the SQLite writer with a bound no-op update", async () => {
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "sqlite",
        });
        const executeRawUnsafe = vi.fn(async () => 1);
        const tx = { $executeRawUnsafe: executeRawUnsafe } as unknown as Tx;

        await acquireAccountSessionOwnerMetadataFenceInTx(tx, "account-1");

        expect(executeRawUnsafe).toHaveBeenCalledWith(
            'UPDATE "Account" SET "settingsVersion" = "settingsVersion" WHERE "id" = ?',
            "account-1",
        );
    });

    it.each(["postgres", "pglite", "mysql"] as const)(
        "rejects a missing or duplicate Account row on %s",
        async (provider) => {
            applyEnvValues({
                HAPPY_DB_PROVIDER: undefined,
                HAPPIER_DB_PROVIDER: provider,
            });
            const queryRawUnsafe = vi.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([
                    { id: "account-1" },
                    { id: "account-1" },
                ]);
            const tx = { $queryRawUnsafe: queryRawUnsafe } as unknown as Tx;

            await expect(
                acquireAccountSessionOwnerMetadataFenceInTx(tx, "account-1"),
            ).rejects.toBeInstanceOf(
                AccountSessionOwnerMetadataFenceAccountNotFoundError,
            );
            await expect(
                acquireAccountSessionOwnerMetadataFenceInTx(tx, "account-1"),
            ).rejects.toThrow("exactly one Account row");
        },
    );

    it("rejects a missing Account row on SQLite", async () => {
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "sqlite",
        });
        const executeRawUnsafe = vi.fn(async () => 0);
        const tx = { $executeRawUnsafe: executeRawUnsafe } as unknown as Tx;

        await expect(
            acquireAccountSessionOwnerMetadataFenceInTx(tx, "missing-account"),
        ).rejects.toBeInstanceOf(
            AccountSessionOwnerMetadataFenceAccountNotFoundError,
        );
    });
});
