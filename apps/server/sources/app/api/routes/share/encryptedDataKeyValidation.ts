import * as privacyKit from "privacy-kit";
import {
    parsePublicShareEncryptedDataKeyEnvelopeV0,
} from "@happier-dev/protocol";

export type EncryptedDataKeyV0ParseResult =
    | Readonly<{ type: "ok"; encryptedDataKey: Uint8Array<ArrayBuffer> }>
    | Readonly<{ type: "error"; error: "Invalid encryptedDataKey" }>;

function copyToArrayBufferBackedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function parseEncryptedDataKeyV0Bytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const parsed = parsePublicShareEncryptedDataKeyEnvelopeV0(bytes);
    if (!parsed) {
        throw new Error("Invalid encryptedDataKey envelope");
    }
    return copyToArrayBufferBackedBytes(parsed.encryptedDataKey);
}

export function parseEncryptedDataKeyV0(encryptedDataKeyB64: string): Uint8Array<ArrayBuffer> {
    let bytes: Uint8Array;
    try {
        bytes = privacyKit.decodeBase64(encryptedDataKeyB64);
    } catch {
        throw new Error("Invalid base64");
    }
    return parseEncryptedDataKeyV0Bytes(bytes);
}

export function tryParseEncryptedDataKeyV0(encryptedDataKeyB64: string): EncryptedDataKeyV0ParseResult {
    try {
        return { type: "ok", encryptedDataKey: parseEncryptedDataKeyV0(encryptedDataKeyB64) };
    } catch {
        return { type: "error", error: "Invalid encryptedDataKey" };
    }
}

export function tryParseEncryptedDataKeyV0Bytes(encryptedDataKey: Uint8Array | null | undefined): EncryptedDataKeyV0ParseResult {
    try {
        if (!encryptedDataKey) {
            throw new Error("Missing encryptedDataKey");
        }
        return { type: "ok", encryptedDataKey: parseEncryptedDataKeyV0Bytes(encryptedDataKey) };
    } catch {
        return { type: "error", error: "Invalid encryptedDataKey" };
    }
}
