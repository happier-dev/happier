import { describe, expect, it } from "vitest";

import {
    createGitHubWebhookHmacSha256V1Verifier,
    verifyGitHubWebhookHmacSha256V1,
} from "./githubHmacSha256";

describe("verifyGitHubWebhookHmacSha256V1", () => {
    const rawBody = new TextEncoder().encode("Hello, World!");
    const secret = "It's a Secret to Everybody";
    const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

    it("matches GitHub's published HMAC-SHA-256 golden vector over exact raw bytes", () => {
        expect(verifyGitHubWebhookHmacSha256V1({ rawBody, secret, signatureHeader: signature })).toBe(true);
    });

    it("rejects a one-byte raw payload mutation", () => {
        const mutated = rawBody.slice();
        mutated[mutated.length - 1] ^= 1;
        expect(verifyGitHubWebhookHmacSha256V1({ rawBody: mutated, secret, signatureHeader: signature })).toBe(false);
    });

    it("verifies the same exact bytes incrementally across arbitrary stream chunks", () => {
        const verifier = createGitHubWebhookHmacSha256V1Verifier(secret);
        verifier.update(rawBody.subarray(0, 1));
        verifier.update(rawBody.subarray(1, 8));
        verifier.update(rawBody.subarray(8));
        expect(verifier.verify(signature)).toBe(true);
        expect(verifier.verify(signature)).toBe(false);
    });

    it("rejects missing, malformed, wrong-length, and aliased signatures without throwing", () => {
        for (const signatureHeader of [
            undefined,
            "",
            "sha1=757107ea0eb2509fc211221cce984b8a37570b6d7",
            "sha256=0",
            `sha256=${"0".repeat(66)}`,
            `sha256=${"G".repeat(64)}`,
            signature.toUpperCase(),
            [signature],
        ]) {
            expect(() => verifyGitHubWebhookHmacSha256V1({ rawBody, secret, signatureHeader })).not.toThrow();
            expect(verifyGitHubWebhookHmacSha256V1({ rawBody, secret, signatureHeader })).toBe(false);
        }
    });
});
