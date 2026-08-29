import { createHash, createHmac } from "node:crypto";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    createHomeLoginAssertionSigningBytesV1,
    decodeBase64,
    encodeBase64,
    HomeLoginAssertionV1Schema,
} from "@happier-dev/protocol";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import type { HomeLoginAssertionV1 } from "./accountDirectorySchemas";

export const ACCOUNT_DIRECTORY_SIGNING_DOMAIN = "happier.account-directory.home-login.v1";
const ASSERTION_TTL_MS = 3 * 60_000;

function deriveSigningSeed(masterSecret: string): Uint8Array {
    return new Uint8Array(createHmac("sha512", `${ACCOUNT_DIRECTORY_SIGNING_DOMAIN} Master Seed`)
        .update(masterSecret, "utf8")
        .digest()
        .subarray(0, tweetnacl.sign.seedLength));
}

export function resolveAccountDirectorySigningKeyPair(env: NodeJS.ProcessEnv = process.env): tweetnacl.SignKeyPair {
    const masterSecret = (env.HANDY_MASTER_SECRET ?? "").trim();
    if (!masterSecret) throw new Error("HANDY_MASTER_SECRET is required");
    return tweetnacl.sign.keyPair.fromSeed(deriveSigningSeed(masterSecret));
}

export function accountDirectorySigningKeyMetadata(env: NodeJS.ProcessEnv = process.env): Readonly<{
    keyId: string;
    publicKeyBase64Url: string;
}> {
    const publicKey = resolveAccountDirectorySigningKeyPair(env).publicKey;
    return {
        keyId: createHash("sha256").update(publicKey).digest("hex"),
        publicKeyBase64Url: encodeBase64(publicKey, "base64url"),
    };
}

export function canonicalHomeLoginAssertionBytes(assertion: Omit<HomeLoginAssertionV1, "signatureBase64Url">): Uint8Array {
    return createHomeLoginAssertionSigningBytesV1(assertion);
}

export async function mintHomeLoginAssertion(params: Readonly<{
    issuerSubjectId: string;
    audienceHomeServerIdentityId: string;
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
): "ok" | "expired" | "invalid" {
    if (assertion.expiresAtMs <= nowMs || assertion.issuedAtMs > nowMs + 60_000) return "expired";
    if (publicKey.length !== tweetnacl.sign.publicKeyLength) return "invalid";
    let signature: Uint8Array;
    try {
        signature = decodeBase64(assertion.signatureBase64Url, "base64url");
    } catch {
        return "invalid";
    }
    if (signature.length !== tweetnacl.sign.signatureLength) return "invalid";
    const { signatureBase64Url: _signature, ...unsigned } = assertion;
    return tweetnacl.sign.detached.verify(canonicalHomeLoginAssertionBytes(unsigned), signature, publicKey)
        ? "ok"
        : "invalid";
}
