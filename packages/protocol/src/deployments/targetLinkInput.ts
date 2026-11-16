import { DeploymentTargetLinkInputV1Schema, type DeploymentTargetLinkInputV1,
    type DeploymentTargetLinkIntentInputV1, type DeploymentTargetLinkProviderIntentInputV1 } from './deploymentActionsV1.js';

/** Link adopts an existing resource; creation provenance is authored only after the host's Create acknowledgment. */
export function normalizeDeploymentTargetLinkOriginV1<T extends { providerResourceOrigin?: 'created' }>(content: T): Omit<T, 'providerResourceOrigin'> {
    const { providerResourceOrigin: _claimedOrigin, ...linked } = content;
    return linked;
}

/** All Action hosts publish private provider operands before building the storage input. */
export function buildDeploymentTargetLinkInputV1(
    input: DeploymentTargetLinkIntentInputV1 | DeploymentTargetLinkProviderIntentInputV1,
    published: Readonly<{ artifactId: string; revision: Readonly<{ headerVersion: number; bodyVersion: number }> }>,
): DeploymentTargetLinkInputV1 {
    // Provider content and its presentation title live in the published Artifact, not the storage input.
    const { provider: _provider, title: _title, ...intent } = 'provider' in input
        ? input : { ...input, provider: undefined, title: undefined };
    return DeploymentTargetLinkInputV1Schema.parse({ ...intent, contentArtifactId: published.artifactId,
        contentHeaderVersion: published.revision.headerVersion, contentBodyVersion: published.revision.bodyVersion });
}
