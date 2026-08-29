import { describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    canonicalHomeLoginAssertionBytes,
    verifyHomeLoginAssertionSignature,
} from "./accountDirectorySigner";

describe("Account Directory Home login assertion signer", () => {
    it("verifies the canonical domain-separated assertion and rejects a changed audience", () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const unsigned = {
            v: 1 as const,
            purpose: "happier.home-login" as const,
            issuerServerIdentityId: "srv_account",
            issuerSubjectId: "account-1",
            audienceHomeServerIdentityId: "srv_home",
            clientBoxPublicKeyBase64: privacyKit.encodeBase64(new Uint8Array(32).fill(1)),
            issuedAtMs: 1_700_000_000_000,
            expiresAtMs: 1_700_000_180_000,
            keyId: "a".repeat(64),
        };
        const signature = tweetnacl.sign.detached(canonicalHomeLoginAssertionBytes(unsigned), keyPair.secretKey);
        const assertion = {
            ...unsigned,
            signatureBase64Url: privacyKit.encodeBase64(signature),
        };
        expect(verifyHomeLoginAssertionSignature(assertion, keyPair.publicKey, unsigned.issuedAtMs + 1)).toBe("ok");
        expect(verifyHomeLoginAssertionSignature({ ...assertion, audienceHomeServerIdentityId: "srv_other" }, keyPair.publicKey, unsigned.issuedAtMs + 1)).toBe("invalid");
    });

    it("fails closed for expired assertions and malformed signatures", () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const unsigned = {
            v: 1 as const,
            purpose: "happier.home-login" as const,
            issuerServerIdentityId: "srv_account",
            issuerSubjectId: "account-1",
            audienceHomeServerIdentityId: "srv_home",
            clientBoxPublicKeyBase64: privacyKit.encodeBase64(new Uint8Array(32).fill(1)),
            issuedAtMs: 1_700_000_000_000,
            expiresAtMs: 1_700_000_180_000,
            keyId: "b".repeat(64),
        };
        const signature = tweetnacl.sign.detached(canonicalHomeLoginAssertionBytes(unsigned), keyPair.secretKey);
        const assertion = { ...unsigned, signatureBase64Url: privacyKit.encodeBase64(signature) };
        expect(verifyHomeLoginAssertionSignature(assertion, keyPair.publicKey, unsigned.expiresAtMs)).toBe("expired");
        expect(verifyHomeLoginAssertionSignature({ ...assertion, signatureBase64Url: "bad" }, keyPair.publicKey, unsigned.issuedAtMs + 1)).toBe("invalid");
    });
});
