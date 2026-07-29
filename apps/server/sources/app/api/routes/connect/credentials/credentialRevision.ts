import { createHash, randomBytes } from "node:crypto";

const CREDENTIAL_REVISION_PATTERN = /^csr_[A-Za-z0-9_-]{22,64}$/;

export function isConnectedServiceCredentialRevision(value: unknown): value is string {
    return typeof value === "string" && CREDENTIAL_REVISION_PATTERN.test(value);
}

export function createConnectedServiceCredentialRevision(): string {
    return `csr_${randomBytes(24).toString("base64url")}`;
}

export function resolveConnectedServiceCredentialRevision(params: Readonly<{
    rowId: string;
    metadata: unknown;
}>): string {
    if (params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)) {
        const revision = (params.metadata as Record<string, unknown>).credentialRevision;
        if (isConnectedServiceCredentialRevision(revision)) return revision;
    }
    const digest = createHash("sha256")
        .update("happier-connected-service-credential-revision-v1\0")
        .update(params.rowId)
        .digest("base64url");
    return `csr_${digest}`;
}

export function withConnectedServiceCredentialRevision<T extends Readonly<Record<string, unknown>>>(
    metadata: T,
    credentialRevision: string,
): T & Readonly<{ credentialRevision: string }> {
    return { ...metadata, credentialRevision };
}
