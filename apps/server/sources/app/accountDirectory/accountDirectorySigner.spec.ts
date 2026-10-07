import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import {
    ACCOUNT_DIRECTORY_SIGNING_DOMAIN,
    accountDirectorySigningKeyMetadata,
    canonicalHomeLoginAssertionBytes,
    mintHomeLoginAssertion,
    resolveAccountDirectorySigningKeyPair,
    verifyHomeLoginAssertionSignature,
} from "./accountDirectorySigner";
import {
    ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS,
    ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1,
    createHomeCredentialDestinationDigestV1,
    HomeLoginAssertionV1Schema,
    decodeBase64,
    encodeBase64,
} from "@happier-dev/protocol";

const CREDENTIAL_DESTINATION_DIGEST = createHomeCredentialDestinationDigestV1({
    v: 1,
    homeServerIdentityId: "srv_home",
    canonicalServerUrl: "https://home.test",
    revision: 1,
    endpoints: [{ kind: "https", url: "https://home.test" }],
});

// The server identity is a database-backed environment adapter; the signer's
// own derivation, signing, and validation logic runs for real below.
vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    getOrCreateServerIdentityId: vi.fn(async () => "srv_spec_issuer"),
}));

describe("Account Directory Home login assertion signer", () => {
    it("verifies the canonical domain-separated assertion and rejects a changed audience", () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const unsigned = {
            v: 1 as const,
            purpose: "happier.home-login" as const,
            issuerServerIdentityId: "srv_account",
            issuerSubjectId: "account-1",
            audienceHomeServerIdentityId: "srv_home",
            credentialDestinationDigestBase64Url: CREDENTIAL_DESTINATION_DIGEST,
            clientBoxPublicKeyBase64: encodeBase64(new Uint8Array(32).fill(1)),
            issuedAtMs: 1_700_000_000_000,
            expiresAtMs: 1_700_000_180_000,
            keyId: "a".repeat(64),
        };
        const signature = tweetnacl.sign.detached(canonicalHomeLoginAssertionBytes(unsigned), keyPair.secretKey);
        const assertion = {
            ...unsigned,
            signatureBase64Url: encodeBase64(signature, "base64url"),
        };
        expect(verifyHomeLoginAssertionSignature(assertion, keyPair.publicKey, unsigned.issuedAtMs + 1)).toBe("ok");
        expect(verifyHomeLoginAssertionSignature({ ...assertion, audienceHomeServerIdentityId: "srv_other" }, keyPair.publicKey, unsigned.issuedAtMs + 1)).toBe("invalid");
        expect(verifyHomeLoginAssertionSignature({
            ...assertion,
            credentialDestinationDigestBase64Url: "A".repeat(43),
        }, keyPair.publicKey, unsigned.issuedAtMs + 1)).toBe("invalid");
    });

    it("fails closed for expired assertions and malformed signatures", () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const unsigned = {
            v: 1 as const,
            purpose: "happier.home-login" as const,
            issuerServerIdentityId: "srv_account",
            issuerSubjectId: "account-1",
            audienceHomeServerIdentityId: "srv_home",
            credentialDestinationDigestBase64Url: CREDENTIAL_DESTINATION_DIGEST,
            clientBoxPublicKeyBase64: encodeBase64(new Uint8Array(32).fill(1)),
            issuedAtMs: 1_700_000_000_000,
            expiresAtMs: 1_700_000_180_000,
            keyId: "b".repeat(64),
        };
        const signature = tweetnacl.sign.detached(canonicalHomeLoginAssertionBytes(unsigned), keyPair.secretKey);
        const assertion = { ...unsigned, signatureBase64Url: encodeBase64(signature, "base64url") };
        expect(verifyHomeLoginAssertionSignature(
            assertion,
            keyPair.publicKey,
            unsigned.expiresAtMs + ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS,
        )).toBe("expired");
        expect(verifyHomeLoginAssertionSignature({ ...assertion, signatureBase64Url: "bad" }, keyPair.publicKey, unsigned.issuedAtMs + 1)).toBe("invalid");
    });

    it("derives a deterministic domain-separated key with canonical sha256 keyId and unpadded base64url public key", () => {
        const env = { HANDY_MASTER_SECRET: "signer-spec-master-secret" };
        const first = resolveAccountDirectorySigningKeyPair(env);
        const second = resolveAccountDirectorySigningKeyPair(env);
        expect(first.secretKey).toEqual(second.secretKey);
        expect(first.publicKey).toHaveLength(tweetnacl.sign.publicKeyLength);
        const other = resolveAccountDirectorySigningKeyPair({ HANDY_MASTER_SECRET: "signer-spec-master-secret-2" });
        expect(other.publicKey).not.toEqual(first.publicKey);
        const metadata = accountDirectorySigningKeyMetadata(env);
        expect(metadata.keyId).toBe(createHash("sha256").update(first.publicKey).digest("hex"));
        expect(metadata.keyId).toMatch(/^[0-9a-f]{64}$/);
        expect(metadata.publicKeyBase64Url).not.toMatch(/[+/=]/);
        expect(decodeBase64(metadata.publicKeyBase64Url, "base64url")).toEqual(first.publicKey);
    });

    it("preserves the established signing bytes across master-secret changes and rejects an empty secret", () => {
        const env = { HANDY_MASTER_SECRET: "  existing-master-secret  " };
        for (const masterSecret of ["existing-master-secret", "rotated-master-secret", "existing-master-secret"]) {
            env.HANDY_MASTER_SECRET = `  ${masterSecret}  `;
            const seed = createHmac("sha512", `${ACCOUNT_DIRECTORY_SIGNING_DOMAIN} Master Seed`)
                .update(masterSecret, "utf8").digest().subarray(0, 32);
            const established = tweetnacl.sign.keyPair.fromSeed(seed);
            const resolved = resolveAccountDirectorySigningKeyPair(env);
            expect(resolved).toEqual(established);
        }
        env.HANDY_MASTER_SECRET = "   ";
        expect(() => resolveAccountDirectorySigningKeyPair(env)).toThrow("HANDY_MASTER_SECRET is required");
    });

    it("uses less CPU for repeated signing-key reads than JavaScript scalar multiplication", () => {
        const inputs = Array.from({ length: 32 }, (_, index) => ({
            HANDY_MASTER_SECRET: `signing-key-read-performance-${index}`,
        }));
        const seeds = inputs.map((env) => createHmac("sha512", `${ACCOUNT_DIRECTORY_SIGNING_DOMAIN} Master Seed`)
            .update(env.HANDY_MASTER_SECRET, "utf8").digest().subarray(0, 32));
        const measureCpu = (read: () => void) => {
            const start = process.cpuUsage();
            read();
            const used = process.cpuUsage(start);
            return used.user + used.system;
        };
        const readEstablished = () => {
            for (const seed of seeds) tweetnacl.sign.keyPair.fromSeed(seed);
        };
        const readCurrent = () => {
            for (const env of inputs) resolveAccountDirectorySigningKeyPair(env);
        };
        readEstablished();
        readCurrent();
        const establishedCpu: number[] = [];
        const currentCpu: number[] = [];
        // Interleave warmed batches, reversing their order, so startup and
        // scheduling variation cannot masquerade as the measured improvement.
        for (let sample = 0; sample < 7; sample++) {
            if (sample % 2 === 0) {
                establishedCpu.push(measureCpu(readEstablished));
                currentCpu.push(measureCpu(readCurrent));
            } else {
                currentCpu.push(measureCpu(readCurrent));
                establishedCpu.push(measureCpu(readEstablished));
            }
        }
        // This compares real implementations on the same host, not a guessed
        // elapsed-time ceiling. Even the slowest current read must beat the
        // fastest established batch.
        expect(Math.max(...currentCpu)).toBeLessThan(Math.min(...establishedCpu));
    });

    it("sources the signing domain from the canonical protocol constant", () => {
        expect(ACCOUNT_DIRECTORY_SIGNING_DOMAIN).toBe(ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1);
        expect(ACCOUNT_DIRECTORY_SIGNING_DOMAIN).toBe("happier.account-directory.home-login.v1");
    });

    it("distinguishes future-assertion clock skew from actual expiry", () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const base = {
            v: 1 as const,
            purpose: "happier.home-login" as const,
            issuerServerIdentityId: "srv_account",
            issuerSubjectId: "account-1",
            audienceHomeServerIdentityId: "srv_home",
            credentialDestinationDigestBase64Url: CREDENTIAL_DESTINATION_DIGEST,
            clientBoxPublicKeyBase64: encodeBase64(new Uint8Array(32).fill(1)),
            issuedAtMs: 1_700_000_000_000,
            expiresAtMs: 1_700_000_180_000,
            keyId: "c".repeat(64),
        };
        const signAt = (issuedAtMs: number) => {
            const signature = tweetnacl.sign.detached(
                canonicalHomeLoginAssertionBytes({ ...base, issuedAtMs }),
                keyPair.secretKey,
            );
            return { ...base, issuedAtMs, signatureBase64Url: encodeBase64(signature, "base64url") };
        };
        const now = 1_700_000_000_000;
        expect(verifyHomeLoginAssertionSignature(
            signAt(now + ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS - 1_000),
            keyPair.publicKey,
            now,
        )).toBe("ok");
        // A future-issued assertion beyond the allowed skew is a clock-skew
        // condition, not an expiry, and must surface as its own typed result.
        expect(verifyHomeLoginAssertionSignature(
            signAt(now + ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS + 1_000),
            keyPair.publicKey,
            now,
        )).toBe("clock_skew");
        // Actual expiry keeps its own typed result at the same skew boundary.
        expect(verifyHomeLoginAssertionSignature(
            signAt(base.issuedAtMs),
            keyPair.publicKey,
            base.expiresAtMs + ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS,
        )).toBe("expired");
    });

    it("fails closed with the typed invalid result for assertions violating strict schema facts", () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(10));
        const unsigned = {
            v: 1 as const,
            purpose: "happier.home-login" as const,
            issuerServerIdentityId: "srv_account",
            issuerSubjectId: "account-1",
            audienceHomeServerIdentityId: "srv_home",
            credentialDestinationDigestBase64Url: CREDENTIAL_DESTINATION_DIGEST,
            clientBoxPublicKeyBase64: encodeBase64(new Uint8Array(32).fill(1)),
            issuedAtMs: 1_700_000_000_000,
            expiresAtMs: 1_700_000_180_000,
            keyId: "d".repeat(64),
        };
        const signature = tweetnacl.sign.detached(canonicalHomeLoginAssertionBytes(unsigned), keyPair.secretKey);
        const assertion = { ...unsigned, signatureBase64Url: encodeBase64(signature, "base64url") };
        const wrongVersion = { ...assertion, v: 2 } as unknown as typeof assertion;
        const wrongPurpose = { ...assertion, purpose: "happier.other-purpose" } as unknown as typeof assertion;
        expect(verifyHomeLoginAssertionSignature(wrongVersion, keyPair.publicKey, unsigned.issuedAtMs + 1)).toBe("invalid");
        expect(verifyHomeLoginAssertionSignature(wrongPurpose, keyPair.publicKey, unsigned.issuedAtMs + 1)).toBe("invalid");
    });

    it("mints a strictly validated short-lived assertion bound to the derived signing key", async () => {
        const env = { HANDY_MASTER_SECRET: "signer-spec-master-secret" };
        const nowMs = 1_700_000_500_000;
        const keyPair = resolveAccountDirectorySigningKeyPair(env);
        const assertion = await mintHomeLoginAssertion({
            issuerSubjectId: "account-42",
            audienceHomeServerIdentityId: "srv_home",
            credentialDestinationDigestBase64Url: CREDENTIAL_DESTINATION_DIGEST,
            clientBoxPublicKeyBase64: encodeBase64(new Uint8Array(32).fill(2)),
            nowMs,
            env,
        });
        expect(HomeLoginAssertionV1Schema.parse(assertion)).toEqual(assertion);
        expect(assertion.issuerServerIdentityId).toBe("srv_spec_issuer");
        expect(assertion.issuerSubjectId).toBe("account-42");
        expect(assertion.audienceHomeServerIdentityId).toBe("srv_home");
        expect(assertion.expiresAtMs - assertion.issuedAtMs).toBeGreaterThanOrEqual(120_000);
        expect(assertion.expiresAtMs - assertion.issuedAtMs).toBeLessThanOrEqual(300_000);
        expect(assertion.keyId).toBe(accountDirectorySigningKeyMetadata(env).keyId);
        expect(assertion.signatureBase64Url).not.toMatch(/[+/=]/);
        expect(verifyHomeLoginAssertionSignature(assertion, keyPair.publicKey, nowMs + 1_000)).toBe("ok");
        expect(verifyHomeLoginAssertionSignature({ ...assertion, issuerSubjectId: "account-43" }, keyPair.publicKey, nowMs + 1_000)).toBe("invalid");
        expect(verifyHomeLoginAssertionSignature(
            assertion,
            resolveAccountDirectorySigningKeyPair({ HANDY_MASTER_SECRET: "unrelated-secret" }).publicKey,
            nowMs + 1_000,
        )).toBe("invalid");
    });
});
