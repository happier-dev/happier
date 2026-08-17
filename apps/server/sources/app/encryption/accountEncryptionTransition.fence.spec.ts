import { afterEach, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { acquireAccountEncryptionTransitionFenceInTx } from "./accountEncryptionTransition";

describe("acquireAccountEncryptionTransitionFenceInTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        restoreEnv(envSnapshot);
    });

    it("returns typed absence when the Account-first lock finds no Account row", async () => {
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "sqlite",
        });
        const accountFindUnique = vi.fn(async () => {
            throw new Error("must not query an Account after its lock reports absence");
        });
        const tx = {
            $executeRawUnsafe: vi.fn(async () => 0),
            account: { findUnique: accountFindUnique },
        } as unknown as Tx;

        await expect(
            acquireAccountEncryptionTransitionFenceInTx(tx, "missing-account"),
        ).resolves.toEqual({ status: "account_not_found" });
        expect(accountFindUnique).not.toHaveBeenCalled();
    });

    it("propagates an operational Account-lock failure", async () => {
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "sqlite",
        });
        const lockFailure = new Error("database lock unavailable");
        const tx = {
            $executeRawUnsafe: vi.fn(async () => {
                throw lockFailure;
            }),
            account: { findUnique: vi.fn() },
        } as unknown as Tx;

        await expect(
            acquireAccountEncryptionTransitionFenceInTx(tx, "account-1"),
        ).rejects.toBe(lockFailure);
    });
});
