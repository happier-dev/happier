import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS,
    ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1,
    createHomeLoginAssertionSigningBytesV1,
    decodeBase64,
    encodeBase64,
    HomeLoginAssertionV1Schema,
} from "@happier-dev/protocol";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import {
    createEd25519PublicKeyId,
    createEd25519SigningKeyPairFromSeed,
    deriveEd25519SigningSeed,
} from "@/app/crypto/derivedEd25519SigningKey";
import type { HomeLoginAssertionV1 } from "./accountDirectorySchemas";

export const ACCOUNT_DIRECTORY_SIGNING_DOMAIN = ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1;
const ASSERTION_TTL_MS = 3 * 60_000;

export function resolveAccountDirectorySigningKeyPair(env: NodeJS.ProcessEnv = process.env): tweetnacl.SignKeyPair {
    const masterSecret = (env.HANDY_MASTER_SECRET ?? "").trim();
    if (!masterSecret) throw new Error("HANDY_MASTER_SECRET is required");
    return createEd25519SigningKeyPairFromSeed(deriveEd25519SigningSeed(masterSecret, ACCOUNT_DIRECTORY_SIGNING_DOMAIN));
}

export function accountDirectorySigningKeyMetadata(env: NodeJS.ProcessEnv = process.env): Readonly<{
    keyId: string;
    publicKeyBase64Url: string;
}> {
    const publicKey = resolveAccountDirectorySigningKeyPair(env).publicKey;
    return {
        keyId: createEd25519PublicKeyId(publicKey),
        publicKeyBase64Url: encodeBase64(publicKey, "base64url"),
    };
}

export function canonicalHomeLoginAssertionBytes(assertion: Omit<HomeLoginAssertionV1, "signatureBase64Url">): Uint8Array {
    return createHomeLoginAssertionSigningBytesV1(assertion);
}

export async function mintHomeLoginAssertion(params: Readonly<{
    issuerSubjectId: string;
    audienceHomeServerIdentityId: string;
    credentialDestinationDigestBase64Url: string;
    clientBoxPublicKeyBase64: string;
    nowMs?: number;
    env?: NodeJS.ProcessEnv;
}>): Promise<HomeLoginAssertionV1> {
    const env = params.env ?? process.env;
    const nowMs = params.nowMs ?? Date.now();
    const metadata = accountDirectorySigningKeyMetadata(env);
    const unsigned = {
        v: 1 as const,
        purpose: "happier.home-login" as const,
        issuerServerIdentityId: await getOrCreateServerIdentityId(env),
        issuerSubjectId: params.issuerSubjectId,
        audienceHomeServerIdentityId: params.audienceHomeServerIdentityId,
        credentialDestinationDigestBase64Url: params.credentialDestinationDigestBase64Url,
        clientBoxPublicKeyBase64: params.clientBoxPublicKeyBase64,
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + ASSERTION_TTL_MS,
        keyId: metadata.keyId,
    } satisfies Omit<HomeLoginAssertionV1, "signatureBase64Url">;
    const keyPair = resolveAccountDirectorySigningKeyPair(env);
    const signature = tweetnacl.sign.detached(canonicalHomeLoginAssertionBytes(unsigned), keyPair.secretKey);
    return HomeLoginAssertionV1Schema.parse({
        ...unsigned,
        signatureBase64Url: encodeBase64(signature, "base64url"),
    });
}

export function verifyHomeLoginAssertionSignature(
    assertion: HomeLoginAssertionV1,
    publicKey: Uint8Array,
    nowMs = Date.now(),
): "ok" | "expired" | "clock_skew" | "invalid" {
    const parsed = HomeLoginAssertionV1Schema.safeParse(assertion);
    if (!parsed.success) return "invalid";
    const validated = parsed.data;
    // Past expiry (beyond the bounded skew) is distinct from an assertion
    // dated in the future beyond the skew: the former is expiry, the latter
    // is clock skew, and callers surface different typed errors for each.
    if (validated.expiresAtMs + ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS <= nowMs) return "expired";
    if (validated.issuedAtMs > nowMs + ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS) return "clock_skew";
    if (publicKey.length !== tweetnacl.sign.publicKeyLength) return "invalid";
    let signature: Uint8Array;
    try {
        signature = decodeBase64(validated.signatureBase64Url, "base64url");
    } catch {
        return "invalid";
    }
    if (signature.length !== tweetnacl.sign.signatureLength) return "invalid";
    const { signatureBase64Url: _signature, ...unsigned } = validated;
    return tweetnacl.sign.detached.verify(canonicalHomeLoginAssertionBytes(unsigned), signature, publicKey)
        ? "ok"
        : "invalid";
}
