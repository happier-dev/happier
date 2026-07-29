import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

const { acquireAccountFence } = vi.hoisted(() => ({
    acquireAccountFence: vi.fn(async () => {}),
}));

vi.mock("@/app/encryption/accountSessionOwnerMetadataFence", () => ({
    acquireAccountSessionOwnerMetadataFenceInTx:
        acquireAccountFence,
}));

import { acquireAccountEncryptionTransitionFenceInTx } from "./accountEncryptionTransition";

describe("accountEncryptionTransition", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("checks only bounded Session existence after the Account-first fence", async () => {
        const accountFindUnique = vi.fn(async () => ({
            publicKey: null,
            encryptionMode: "plain",
            contentPublicKey: null,
            contentPublicKeySig: null,
            settings: null,
            settingsVersion: 0,
        }));
        let sessionCountArguments: unknown;
        const sessionCount = vi.fn(async (args: unknown) => {
            sessionCountArguments = args;
            return 1;
        });
        // This is a narrow deterministic repository boundary fixture.
        const tx = {
            account: { findUnique: accountFindUnique },
            session: { count: sessionCount },
        } as unknown as Tx;

        const result =
            await acquireAccountEncryptionTransitionFenceInTx(
                tx,
                "account-1",
            );

        expect(acquireAccountFence).toHaveBeenCalledWith(
            tx,
            "account-1",
        );
        expect(sessionCount).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                OR: [
                    { metadataLayoutVersion: { not: 0 } },
                    { ownerMetadata: { not: null } },
                ],
            },
            take: 1,
        });
        expect(sessionCountArguments).not.toHaveProperty(
            "select",
        );
        expect(result).toEqual({
            status: "metadata_privacy_upgrade_required",
        });
    });
});
