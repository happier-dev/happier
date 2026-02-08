import { createHash, randomBytes } from "node:crypto";

const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;

export function generatePkceVerifier(length: number = 64): string {
    const desiredLength = Math.max(MIN_VERIFIER_LENGTH, Math.min(MAX_VERIFIER_LENGTH, Math.floor(length)));

    // base64url yields [A-Za-z0-9_-], which is a subset of the RFC 7636 "unreserved" set.
    // Keep generating until we meet the requested length.
    while (true) {
        const verifier = randomBytes(desiredLength).toString("base64url");
        if (verifier.length >= desiredLength) return verifier.slice(0, desiredLength);
    }
}

export function pkceChallengeS256(verifier: string): string {
    return createHash("sha256").update(verifier, "utf8").digest().toString("base64url");
}

