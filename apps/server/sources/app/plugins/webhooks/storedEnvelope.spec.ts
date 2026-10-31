import {
    signAccountContentKeyBindingV1,
    decodeBase64,
    openBoxBundle,
    serializeStoredPluginWebhookDeliveryContentV1,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { createPluginWebhookStoredEnvelopeV1 } from "./storedEnvelope";

const content = {
    v: 1,
    receivedAtMs: 1_700_000_000_000,
    contentType: "application/json",
    headers: [{ name: "x-github-event", value: "issues" }],
    rawBodyBytes: 2,
    rawBodyBase64: "e30=",
    verified: {
        verifier: "github_hmac_sha256_v1",
        providerDeliveryId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        eventType: "issues",
        credentialVersionId: "wh_cred_1",
    },
} as const;

function e2eeAccount() {
    const signing = tweetnacl.sign.keyPair();
    const contentKey = tweetnacl.box.keyPair();
    const signature = signAccountContentKeyBindingV1({
        accountSigningSecretKey: signing.secretKey,
        contentPublicKey: contentKey.publicKey,
    });
    return {
        row: {
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            encryptionMode: "e2ee",
            contentPublicKey: contentKey.publicKey,
            contentPublicKeySig: signature,
        },
        contentKey,
    };
}

describe("createPluginWebhookStoredEnvelopeV1", () => {
    it("stores explicit plain content for a plain Account", () => {
        const result = createPluginWebhookStoredEnvelopeV1({
            account: {
                publicKey: null,
                encryptionMode: "plain",
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
            content,
        });
        expect(result).toMatchObject({
            ok: true,
            encryption: { mode: "plain", contentKeyFingerprint: null },
        });
        if (!result.ok) return;
        const envelope = JSON.parse(new TextDecoder().decode(result.canonicalEnvelopeBytes));
        expect(result.canonicalEnvelopeBytes).toEqual(
            serializeStoredPluginWebhookDeliveryContentV1(envelope),
        );
        expect(envelope).toEqual({ t: "plain", v: content });
        expect(result.canonicalEnvelopeBytes.byteLength).toBeGreaterThan(0);
    });

    it("seals canonical content to the verified Account content key in E2EE mode", () => {
        const account = e2eeAccount();
        const result = createPluginWebhookStoredEnvelopeV1({ account: account.row, content });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const envelope = JSON.parse(new TextDecoder().decode(result.canonicalEnvelopeBytes));
        expect(envelope.t).toBe("encrypted");
        if (envelope.t !== "encrypted") return;
        expect(result.encryption).toMatchObject({
            mode: "e2ee",
            contentKeyFingerprint: expect.stringMatching(/^content-public-key-sha256:[0-9a-f]{64}$/u),
        });
        const opened = openBoxBundle({
            bundle: decodeBase64(envelope.c, "base64"),
            recipientSecretKeyOrSeed: account.contentKey.secretKey,
        });
        expect(opened).not.toBeNull();
        expect(JSON.parse(new TextDecoder().decode(opened!))).toEqual(content);
    });

    it("fails closed when E2EE key material is absent or invalid", () => {
        const result = createPluginWebhookStoredEnvelopeV1({
            account: {
                publicKey: null,
                encryptionMode: "e2ee",
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
            content,
        });
        expect(result).toEqual({ ok: false, code: "accountEncryptionInconsistent", reason: "missing_or_invalid_signing_key" });
    });
});
