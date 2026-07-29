import { describe, expect, it } from "vitest";
import {
    encodeBase64,
    PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES,
    PUBLIC_SHARE_ENCRYPTED_DATA_KEY_LEGACY_V0_BYTES,
} from "@happier-dev/protocol";

import { tryParseEncryptedDataKeyV0, tryParseEncryptedDataKeyV0Bytes } from "./encryptedDataKeyValidation";

const VALID_ENCRYPTED_DATA_KEY = encodeBase64(
    new Uint8Array(PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES).fill(1),
    "base64",
);

describe("tryParseEncryptedDataKeyV0", () => {
    it("returns shared route error shape for malformed encrypted data-key envelopes", () => {
        const result = tryParseEncryptedDataKeyV0("not-valid-base64");

        expect(result).toEqual({ type: "error", error: "Invalid encryptedDataKey" });
        expect(tryParseEncryptedDataKeyV0(
            encodeBase64(new Uint8Array(105).fill(1), "base64"),
        )).toEqual({ type: "error", error: "Invalid encryptedDataKey" });
    });

    it("returns parsed bytes for valid encrypted data-key envelopes", () => {
        const result = tryParseEncryptedDataKeyV0(VALID_ENCRYPTED_DATA_KEY);

        expect(result.type).toBe("ok");
        expect(result.type === "ok" ? Buffer.from(result.encryptedDataKey).toString("base64") : null).toBe(VALID_ENCRYPTED_DATA_KEY);
    });
});

describe("tryParseEncryptedDataKeyV0Bytes", () => {
    it("returns shared route error shape for malformed persisted encrypted data-key envelopes", () => {
        const result = tryParseEncryptedDataKeyV0Bytes(Uint8Array.from([1, 2, 3]));

        expect(result).toEqual({ type: "error", error: "Invalid encryptedDataKey" });
    });

    it("returns parsed bytes for valid persisted encrypted data-key envelopes", () => {
        const bytes = new Uint8Array(PUBLIC_SHARE_ENCRYPTED_DATA_KEY_LEGACY_V0_BYTES).fill(1);
        const result = tryParseEncryptedDataKeyV0Bytes(bytes);

        expect(result.type).toBe("ok");
        expect(result.type === "ok" ? result.encryptedDataKey.byteLength : null).toBe(
            PUBLIC_SHARE_ENCRYPTED_DATA_KEY_LEGACY_V0_BYTES,
        );
    });
});
