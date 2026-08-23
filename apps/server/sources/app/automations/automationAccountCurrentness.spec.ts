import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";

import { deriveAutomationAccountCurrentnessWitness } from "@/app/automations/automationAccountCurrentness";
import { deriveAccountEncryptionMigrationKeyFingerprints } from "@/app/encryption/accountEncryptionTransition";

function buildBoundContentKeyAccountRow(encryptionMode: "plain" | "e2ee"): Readonly<{
    seq: number;
    publicKey: string;
    encryptionMode: string;
    contentPublicKey: Uint8Array<ArrayBuffer>;
    contentPublicKeySig: Uint8Array<ArrayBuffer>;
}> {
    const signing = nacl.sign.keyPair();
    const contentPublicKey = new Uint8Array(nacl.box.keyPair().publicKey);
    return {
        seq: 41,
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        encryptionMode,
        contentPublicKey,
        contentPublicKeySig: nacl.sign.detached(
            Buffer.concat([
                Buffer.from("Happy content key v1\u0000", "utf8"),
                Buffer.from(contentPublicKey),
            ]),
            signing.secretKey,
        ) as Uint8Array<ArrayBuffer>,
    };
}

describe("app/automations/automationAccountCurrentness", () => {
    it("derives a keyless witness for a supported plain Account that retains its superseded content key", () => {
        // An Account migrated e2ee -> plain keeps `contentPublicKey`, so the raw
        // reading still reports a content-key fingerprint. That Account is
        // plain and current; Automations must not see it as unavailable.
        const account = buildBoundContentKeyAccountRow("plain");
        expect(
            deriveAccountEncryptionMigrationKeyFingerprints(account).contentKeyFingerprint,
        ).not.toBeNull();

        expect(deriveAutomationAccountCurrentnessWitness(account)).toEqual({
            mode: "plain",
            version: 41,
            contentKeyFingerprint: null,
        });
    });

    it("keeps the exact content-key fingerprint for an e2ee Account", () => {
        const account = buildBoundContentKeyAccountRow("e2ee");
        expect(deriveAutomationAccountCurrentnessWitness(account)).toEqual({
            mode: "e2ee",
            version: 41,
            contentKeyFingerprint:
                deriveAccountEncryptionMigrationKeyFingerprints(account).contentKeyFingerprint,
        });
    });
});
