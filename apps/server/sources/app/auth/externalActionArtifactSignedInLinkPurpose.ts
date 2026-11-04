import { ArtifactActionInputSchemasV1, ArtifactSignedInLinkCreateRequestV1Schema,
    ArtifactSignedInLinkJoinCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** The installed Action host signs derived operands; the existing routes own resource admission. */
export function readExternalActionArtifactSignedInLinkPurpose(actionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>): boolean | null {
    switch (actionId) {
        case 'artifact.public_link.create': case 'artifact.public_link.list':
        case 'artifact.public_link.revoke': case 'artifact.public_link.join': break;
        default: return null;
    }
    const method = proof.method.toUpperCase();
    const collection = '/v1/artifact-signed-in-links';
    const matchesInput = (input: unknown) => proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, input);
    if (actionId === 'artifact.public_link.create') {
        const create = ArtifactSignedInLinkCreateRequestV1Schema.safeParse(proof.body);
        return method === 'POST' && proof.path === collection && create.success && matchesInput(create.data);
    }
    if ((actionId === 'artifact.public_link.list' || actionId === 'artifact.public_link.revoke')
        && method === 'GET' && proof.body === undefined) {
        if (!proof.path.startsWith(`${collection}?`)) return false;
        const artifactId = new URLSearchParams(proof.path.slice(collection.length + 1)).get('artifactId');
        const selected = ArtifactActionInputSchemasV1['artifact.get'].safeParse({ artifactId });
        return selected.success && proof.path === `${collection}?${new URLSearchParams({ artifactId: selected.data.artifactId })}`
            && matchesInput({ artifactId: selected.data.artifactId });
    }
    if (actionId === 'artifact.public_link.revoke') {
        const match = /^\/v1\/artifact-signed-in-links\/([^/?#]+)$/u.exec(proof.path);
        if (!match || method !== 'DELETE' || proof.body !== undefined) return false;
        try {
            const artifactId = decodeURIComponent(match[1]);
            return ArtifactActionInputSchemasV1['artifact.get'].safeParse({ artifactId }).success
                && match[1] === encodeURIComponent(artifactId) && matchesInput({ artifactId });
        } catch { return false; }
    }
    if (actionId !== 'artifact.public_link.join') return false;
    const match = /^\/v1\/artifact-signed-in-links\/([^/?#]+)\/join$/u.exec(proof.path);
    if (!match) return false;
    try {
        const lookupId = decodeURIComponent(match[1]);
        if (!ArtifactActionInputSchemasV1['artifact.public_link.join'].safeParse({ lookupId }).success
            || match[1] !== encodeURIComponent(lookupId)) return false;
        if (method === 'GET') return proof.body === undefined && matchesInput({ lookupId });
        const commit = ArtifactSignedInLinkJoinCommitInputV1Schema.safeParse(proof.body);
        return method === 'POST' && commit.success && matchesInput({ lookupId, ...commit.data });
    } catch { return false; }
}
