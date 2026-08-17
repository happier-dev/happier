import { describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import {
    admitAccountContentKey,
    deriveAccountEncryptionCurrentnessFromRow,
} from "./accountContentKeyAdmission";

function createBinding() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const payload = Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(content.publicKey),
    ]);
    return {
        accountPublicKeyHex:
            Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySignature: new Uint8Array(
            tweetnacl.sign.detached(payload, signing.secretKey),
        ),
    };
}

function createAccountClient(params: Readonly<{
    rows: ReadonlyArray<{
        publicKey: string;
        contentPublicKey: Uint8Array | null;
        contentPublicKeySig: Uint8Array | null;
    }>;
    updateCounts?: ReadonlyArray<number>;
}>) {
    const findUnique = vi.fn();
    for (const row of params.rows) {
        findUnique.mockResolvedValueOnce(row);
    }
    const updateMany = vi.fn();
    for (const count of params.updateCounts ?? []) {
        updateMany.mockResolvedValueOnce({ count });
    }
    // Narrow deterministic Prisma Account-delegate boundary fixture.
    const client = {
        account: {
            findUnique,
            updateMany,
        },
    } as unknown as Parameters<typeof admitAccountContentKey>[0];
    return { client, findUnique, updateMany };
}

describe("accountContentKeyAdmission", () => {
    it("refuses an exact key whose stored non-null signature is invalid", async () => {
        const binding = createBinding();
        const client = createAccountClient({
            rows: [{
                publicKey: binding.accountPublicKeyHex,
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySig: new Uint8Array(
                    tweetnacl.sign.signatureLength,
                ),
            }],
        });

        const result = await admitAccountContentKey(
            client.client,
            {
                accountId: "account-1",
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySignature:
                    binding.contentPublicKeySignature,
            },
        );

        expect(result).toEqual({ status: "invalid_binding" });
        expect(client.updateMany).not.toHaveBeenCalled();
    });

    it("refuses an invalid non-null signature observed after losing null initialization", async () => {
        const binding = createBinding();
        const client = createAccountClient({
            rows: [
                {
                    publicKey: binding.accountPublicKeyHex,
                    contentPublicKey: null,
                    contentPublicKeySig: null,
                },
                {
                    publicKey: binding.accountPublicKeyHex,
                    contentPublicKey: binding.contentPublicKey,
                    contentPublicKeySig: new Uint8Array(
                        tweetnacl.sign.signatureLength,
                    ),
                },
            ],
            updateCounts: [0],
        });

        const result = await admitAccountContentKey(
            client.client,
            {
                accountId: "account-1",
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySignature:
                    binding.contentPublicKeySignature,
            },
        );

        expect(result).toEqual({ status: "invalid_binding" });
        expect(client.findUnique).toHaveBeenCalledTimes(2);
    });

    it("reports an e2ee Account missing its signing key as inconsistent", () => {
        const binding = createBinding();

        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "e2ee",
            publicKey: null,
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: binding.contentPublicKeySignature,
        })).toEqual({
            status: "inconsistent",
            reason: "missing_or_invalid_signing_key",
        });
    });

    it("reports an e2ee Account missing its content-key binding as inconsistent", () => {
        const binding = createBinding();

        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "e2ee",
            publicKey: binding.accountPublicKeyHex,
            contentPublicKey: null,
            contentPublicKeySig: null,
        })).toEqual({
            status: "inconsistent",
            reason: "missing_content_key_binding",
        });
    });

    it("reports an e2ee Account with an invalid content-key binding as inconsistent", () => {
        const binding = createBinding();

        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "e2ee",
            publicKey: binding.accountPublicKeyHex,
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: new Uint8Array(tweetnacl.sign.signatureLength),
        })).toEqual({
            status: "inconsistent",
            reason: "invalid_content_key_binding",
        });
    });

    it("preserves normal plain and valid e2ee currentness", () => {
        const binding = createBinding();

        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "plain",
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        })).toEqual({
            status: "ready",
            currentness: {
                encryptionMode: "plain",
                contentPublicKey: null,
                contentPublicKeySignature: null,
                contentPublicKeyFingerprint: null,
            },
        });
        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "e2ee",
            publicKey: binding.accountPublicKeyHex,
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: binding.contentPublicKeySignature,
        })).toEqual({
            status: "ready",
            currentness: {
                encryptionMode: "e2ee",
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySignature: binding.contentPublicKeySignature,
                contentPublicKeyFingerprint: expect.any(String),
            },
        });
    });
});
