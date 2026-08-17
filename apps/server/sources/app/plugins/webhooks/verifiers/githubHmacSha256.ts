import { createHmac, timingSafeEqual } from "node:crypto";

const GITHUB_SHA256_SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/u;

export type GitHubWebhookHmacSha256V1Verifier = Readonly<{
    update(chunk: Uint8Array): void;
    verify(signatureHeader: unknown): boolean;
}>;

export function createGitHubWebhookHmacSha256V1Verifier(secret: string): GitHubWebhookHmacSha256V1Verifier {
    const hmac = createHmac("sha256", secret);
    let finalized = false;
    return {
        update(chunk) {
            if (finalized) throw new Error("GitHub webhook verifier has already been finalized");
            hmac.update(chunk);
        },
        verify(signatureHeader) {
            if (finalized) return false;
            finalized = true;
            const expected = hmac.digest();
            const match = typeof signatureHeader === "string"
                ? GITHUB_SHA256_SIGNATURE_PATTERN.exec(signatureHeader)
                : null;
            const supplied = match ? Buffer.from(match[1]!, "hex") : Buffer.alloc(expected.byteLength);
            return timingSafeEqual(expected, supplied) && match !== null;
        },
    };
}

export function verifyGitHubWebhookHmacSha256V1(params: {
    rawBody: Uint8Array;
    secret: string;
    signatureHeader: unknown;
}): boolean {
    const verifier = createGitHubWebhookHmacSha256V1Verifier(params.secret);
    verifier.update(params.rawBody);
    return verifier.verify(params.signatureHeader);
}
