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

    it("leaves Session inventory to the canonical Session tuple owner after the Account-first fence", async () => {
        const accountFindUnique = vi.fn(async () => ({
            publicKey: null,
            seq: 7,
            encryptionMode: "plain",
            contentPublicKey: null,
            contentPublicKeySig: null,
            settings: null,
            settingsVersion: 0,
        }));
        const sessionCount = vi.fn(async () => 1);
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
        expect(sessionCount).not.toHaveBeenCalled();
        expect(result).toEqual({
            status: "ready",
            account: {
                version: 7,
                publicKey: null,
                signingKeyFingerprint: null,
                contentKeyFingerprint: null,
                settings: null,
                settingsVersion: 0,
                currentness: {
                    encryptionMode: "plain",
                    contentPublicKey: null,
                    contentPublicKeySignature: null,
                    contentPublicKeyFingerprint: null,
                },
            },
        });
    });

    it("rejects an inconsistent E2EE Account before transition inventory or mutation", async () => {
        const accountFindUnique = vi.fn(async () => ({
            publicKey: null,
            seq: 7,
            encryptionMode: "e2ee",
            contentPublicKey: null,
            contentPublicKeySig: null,
            settings: null,
            settingsVersion: 0,
        }));
        const sessionCount = vi.fn(async () => 1);
        const tx = {
            account: { findUnique: accountFindUnique },
            session: { count: sessionCount },
        } as unknown as Tx;

        const result =
            await acquireAccountEncryptionTransitionFenceInTx(
                tx,
                "account-1",
            );

        expect(result).toEqual({
            status: "account_inconsistent",
            reason: "missing_or_invalid_signing_key",
        });
        expect(sessionCount).not.toHaveBeenCalled();
    });
});
