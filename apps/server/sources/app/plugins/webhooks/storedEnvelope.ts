import { randomBytes as nodeRandomBytes } from "node:crypto";

import {
    StoredPluginWebhookDeliveryContentV1Schema,
    encodeBase64,
    sealBoxBundle,
    serializePluginWebhookDeliveryContentV1,
    serializeStoredPluginWebhookDeliveryContentV1,
    type PluginWebhookDeliveryContentV1,
    type StoredPluginWebhookDeliveryContentV1,
    type ContentPublicKeyFingerprint,
} from "@happier-dev/protocol";

import {
    deriveAccountEncryptionCurrentnessFromRow,
    type AccountEncryptionCurrentness,
    type AccountEncryptionInconsistencyReason,
} from "@/app/encryption/accountContentKeyAdmission";

export type PluginWebhookStoredEnvelopeReadyV1 = Readonly<{
    ok: true;
    canonicalEnvelopeBytes: Uint8Array;
    encryption: Readonly<{
        mode: "plain" | "e2ee";
        contentKeyFingerprint: ContentPublicKeyFingerprint | null;
    }>;
}>;

export type PluginWebhookStoredEnvelopeResultV1 =
    | PluginWebhookStoredEnvelopeReadyV1
    | Readonly<{
        ok: false;
        code: "accountEncryptionInconsistent";
        reason: AccountEncryptionInconsistencyReason;
    }>;

export type PluginWebhookStoredEnvelopeAccountValidationResultV1 =
    | Readonly<{
        ok: true;
        envelope: StoredPluginWebhookDeliveryContentV1;
    }>
    | Readonly<{
        ok: false;
        code: "invalid_stored_envelope";
    }>
    | Readonly<{
        ok: false;
        code: "account_encryption_mismatch";
    }>;

/**
 * Account currentness is derived and fenced by the caller from the persisted
 * Account row. A delivery envelope must use that same persisted mode before
 * it can cross the claim boundary.
 */
export function validatePluginWebhookStoredEnvelopeForAccountCurrentnessV1(
    params: Readonly<{
        currentness: Pick<AccountEncryptionCurrentness, "encryptionMode">;
        envelope: unknown;
    }>,
): PluginWebhookStoredEnvelopeAccountValidationResultV1 {
    const parsed = StoredPluginWebhookDeliveryContentV1Schema.safeParse(
        params.envelope,
    );
    if (!parsed.success) {
        return { ok: false, code: "invalid_stored_envelope" };
    }
    const expectedEnvelopeType =
        params.currentness.encryptionMode === "plain"
            ? "plain"
            : "encrypted";
    if (parsed.data.t !== expectedEnvelopeType) {
        return { ok: false, code: "account_encryption_mismatch" };
    }
    return { ok: true, envelope: parsed.data };
}

export function createPluginWebhookStoredEnvelopeV1(params: {
    account: Readonly<{
        publicKey: string | null;
        encryptionMode: string | null;
        contentPublicKey: Uint8Array | null;
        contentPublicKeySig: Uint8Array | null;
    }>;
    content: PluginWebhookDeliveryContentV1;
    randomBytes?: (length: number) => Uint8Array;
}): PluginWebhookStoredEnvelopeResultV1 {
    const currentness = deriveAccountEncryptionCurrentnessFromRow(params.account);
    if (currentness.status === "inconsistent") {
        return {
            ok: false,
            code: "accountEncryptionInconsistent",
            reason: currentness.reason,
        };
    }

    const content = params.content;
    let envelope: StoredPluginWebhookDeliveryContentV1;
    if (currentness.currentness.encryptionMode === "plain") {
        envelope = { t: "plain", v: content };
    } else {
        const contentPublicKey = currentness.currentness.contentPublicKey;
        if (!contentPublicKey) {
            return {
                ok: false,
                code: "accountEncryptionInconsistent",
                reason: "missing_content_key_binding",
            };
        }
        const sealed = sealBoxBundle({
            plaintext: serializePluginWebhookDeliveryContentV1(content),
            recipientPublicKey: contentPublicKey,
            randomBytes: params.randomBytes ?? ((length) => Uint8Array.from(nodeRandomBytes(length))),
        });
        envelope = { t: "encrypted", c: encodeBase64(sealed, "base64") };
    }

    const canonicalEnvelopeBytes = serializeStoredPluginWebhookDeliveryContentV1(envelope);
    return {
        ok: true,
        canonicalEnvelopeBytes,
        encryption: {
            mode: currentness.currentness.encryptionMode,
            contentKeyFingerprint: currentness.currentness.contentPublicKeyFingerprint,
        },
    };
}
