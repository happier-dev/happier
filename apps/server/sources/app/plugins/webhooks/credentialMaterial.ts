import { randomBytes as nodeRandomBytes } from "node:crypto";

import { encodeBase64 } from "@happier-dev/protocol";

export function createGeneratedPluginWebhookCredentialMaterialV1(_params?: Readonly<{
    randomBytes?: (length: number) => Uint8Array;
}>): Readonly<{ credentialVersionId: string; secret: string }> {
    const randomBytes = _params?.randomBytes
        ?? ((length: number) => Uint8Array.from(nodeRandomBytes(length)));
    const versionBytes = randomBytes(16);
    if (versionBytes.byteLength !== 16) {
        throw new TypeError("Plugin webhook credential version identity requires exactly 16 bytes");
    }
    const secretBytes = randomBytes(32);
    if (secretBytes.byteLength !== 32) {
        throw new TypeError("Plugin webhook GitHub secret requires exactly 32 bytes");
    }
    return {
        credentialVersionId: `wh_cred_${encodeBase64(versionBytes, "base64url")}`,
        secret: encodeBase64(secretBytes, "base64url"),
    };
}
