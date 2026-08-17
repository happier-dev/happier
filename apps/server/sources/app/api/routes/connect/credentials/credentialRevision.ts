import { randomBytes } from "node:crypto";

const CREDENTIAL_REVISION_PATTERN = /^csr_[A-Za-z0-9_-]{22,64}$/;

export function isConnectedServiceCredentialRevision(value: unknown): value is string {
    return typeof value === "string" && CREDENTIAL_REVISION_PATTERN.test(value);
}

export function createConnectedServiceCredentialRevision(): string {
    return `csr_${randomBytes(24).toString("base64url")}`;
}

export function resolveConnectedServiceCredentialRevision(params: Readonly<{
    metadata: unknown;
}>): string | null {
    if (params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)) {
        const revision = (params.metadata as Record<string, unknown>).credentialRevision;
        if (isConnectedServiceCredentialRevision(revision)) return revision;
    }
    return null;
}

export function withConnectedServiceCredentialRevision<T extends Readonly<Record<string, unknown>>>(
    metadata: T,
    credentialRevision: string,
): T & Readonly<{ credentialRevision: string }> {
    return { ...metadata, credentialRevision };
}
