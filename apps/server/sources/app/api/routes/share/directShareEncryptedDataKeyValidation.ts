import * as privacyKit from "privacy-kit";
import { parseDirectShareEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";

export type DirectShareEncryptedDataKeyParseResult =
    | Readonly<{ type: "ok"; encryptedDataKey: Uint8Array<ArrayBuffer> }>
    | Readonly<{ type: "error"; error: "Invalid encryptedDataKey" }>;

export function tryParseDirectShareEncryptedDataKey(
    encryptedDataKeyB64: string,
): DirectShareEncryptedDataKeyParseResult {
    try {
        const bytes = privacyKit.decodeBase64(encryptedDataKeyB64);
        const parsed = parseDirectShareEncryptedDataKeyEnvelopeV1(bytes);
        if (!parsed) {
            throw new Error("Invalid direct-share encryptedDataKey envelope");
        }
        return { type: "ok", encryptedDataKey: parsed.encryptedDataKey };
    } catch {
        return { type: "error", error: "Invalid encryptedDataKey" };
    }
}
