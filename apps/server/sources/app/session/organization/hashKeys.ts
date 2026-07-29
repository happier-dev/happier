import { createHash } from "node:crypto";

const SESSION_ORGANIZATION_HASH_PREFIX = "sha256:";

export function hashSessionOrganizationKey(key: string): string {
    return `${SESSION_ORGANIZATION_HASH_PREFIX}${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

export function assertSessionOrganizationHashKeyMatch(params: Readonly<{
    expectedKey: string;
    actualKey: string;
    entity: string;
}>): void {
    if (params.expectedKey !== params.actualKey) {
        throw new Error(`session organization ${params.entity} hash collision`);
    }
}
