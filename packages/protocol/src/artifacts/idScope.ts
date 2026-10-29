import { z } from 'zod/mini';
import { computeCanonicalDomainSeparatedHexDigest } from '../crypto/canonicalDigest.js';

/** Public non-content identity, never an approval body or a credential. */
export const ArtifactIdScopeV1Schema = z.strictObject({
    v: z.literal(1),
    sourceId: z.string().check(z.uuid()),
});
export type ArtifactIdScopeV1 = z.infer<typeof ArtifactIdScopeV1Schema>;

/** Version 8, variant a is reserved for authenticated Account-scoped creates. */
export function deriveAccountScopedArtifactIdV1(accountId: string, sourceId: string): string {
    const digest = computeCanonicalDomainSeparatedHexDigest('happier.artifact.account-scoped-id.v1', [accountId, sourceId]);
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Check every new Artifact, regardless of its claimed or encrypted kind. */
export function artifactIdScopeMatchesAccountV1(input: Readonly<{
    artifactId: string; accountId: string; idScope?: unknown;
}>): boolean {
    const reserved = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.artifactId);
    if (input.idScope === undefined) return !reserved;
    const scope = ArtifactIdScopeV1Schema.safeParse(input.idScope);
    return scope.success && input.artifactId === deriveAccountScopedArtifactIdV1(input.accountId, scope.data.sourceId);
}

/** One exact-lookup owner for new identities and retained owner consent. */
export async function resolveAccountScopedArtifactIdV1<Artifact extends { access?: string }>(input: Readonly<{
    accountId: string; sourceId: string; read: (artifactId: string) => Promise<Artifact | null>;
}>): Promise<Readonly<{ artifactId: string; idScope: ArtifactIdScopeV1 | undefined; artifact: Artifact | null }>> {
    const artifactId = deriveAccountScopedArtifactIdV1(input.accountId, input.sourceId);
    const artifact = await input.read(artifactId);
    const idScope: ArtifactIdScopeV1 = { v: 1, sourceId: input.sourceId };
    if (artifact) return { artifactId, idScope, artifact };
    const legacy = await input.read(input.sourceId);
    return legacy?.access === 'owner'
        ? { artifactId: input.sourceId, idScope: undefined, artifact: legacy }
        : { artifactId, idScope, artifact: null };
}
