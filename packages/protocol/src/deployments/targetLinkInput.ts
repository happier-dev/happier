import { DeploymentTargetLinkInputV1Schema, type DeploymentTargetLinkInputV1,
    type DeploymentTargetLinkIntentInputV1, type DeploymentTargetLinkProviderIntentInputV1 } from './deploymentActionsV1.js';

/** All Action hosts publish private provider operands before building the storage input. */
export function buildDeploymentTargetLinkInputV1(
    input: DeploymentTargetLinkIntentInputV1 | DeploymentTargetLinkProviderIntentInputV1,
    published: Readonly<{ artifactId: string; revision: Readonly<{ headerVersion: number; bodyVersion: number }> }>,
): DeploymentTargetLinkInputV1 {
    const { provider: _provider, ...intent } = 'provider' in input ? input : { ...input, provider: undefined };
    return DeploymentTargetLinkInputV1Schema.parse({ ...intent, contentArtifactId: published.artifactId,
        contentHeaderVersion: published.revision.headerVersion, contentBodyVersion: published.revision.bodyVersion });
}
