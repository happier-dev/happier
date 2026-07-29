import { describe, expect, it } from "vitest";
import {
    CRYPTO_GOLDEN_VECTORS,
    DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
    encodeBase64,
} from "@happier-dev/protocol";

import { tryParseDirectShareEncryptedDataKey } from "./directShareEncryptedDataKeyValidation";

function bytesFromHex(hex: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}

describe("tryParseDirectShareEncryptedDataKey", () => {
    it("accepts the protocol golden envelope emitted for a direct-share data key", () => {
        const envelope = bytesFromHex(
            CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.directSecretKey.envelope.hex,
        );

        const result = tryParseDirectShareEncryptedDataKey(encodeBase64(envelope, "base64"));

        expect(envelope).toHaveLength(DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES);
        expect(result).toEqual({ type: "ok", encryptedDataKey: envelope });
    });

    it("rejects invalid base64, unsupported versions, and wrong envelope lengths", () => {
        const unsupportedVersion = new Uint8Array(DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES);
        unsupportedVersion[0] = 1;

        expect(tryParseDirectShareEncryptedDataKey("not-valid-base64")).toEqual({
            type: "error",
            error: "Invalid encryptedDataKey",
        });
        for (const envelope of [
            unsupportedVersion,
            new Uint8Array(DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES - 1),
            new Uint8Array(DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES + 1),
        ]) {
            expect(tryParseDirectShareEncryptedDataKey(encodeBase64(envelope, "base64"))).toEqual({
                type: "error",
                error: "Invalid encryptedDataKey",
            });
        }
    });
});
