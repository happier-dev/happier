import { sameStrictJsonValue, type DeploymentTargetLinkAlreadyLinkedResultV1,
    type DeploymentTargetLinkProviderIntentInputV1, type DeploymentTargetLinkHeaderV1,
    type DeploymentTargetLinksListResultV1 } from '@happier-dev/protocol';
import { readDeploymentTargetLinkArtifactV1, type DeploymentArtifactDocumentV1 } from './artifacts.js';

/** Both admitted client hosts compare private provider tuples through their own Artifact reader. */
export async function findExistingDeploymentTargetLinkV1(input: DeploymentTargetLinkProviderIntentInputV1, reads: Readonly<{
    list(cursor?: string): Promise<DeploymentTargetLinksListResultV1>;
    artifact(link: DeploymentTargetLinkHeaderV1): Promise<DeploymentArtifactDocumentV1 | null>;
}>): Promise<DeploymentTargetLinkAlreadyLinkedResultV1 | undefined> {
    let cursor: string | undefined;
    do {
        const page = await reads.list(cursor);
        if (!page.ok || page.coverage !== 'complete') {
            const code = page.ok ? 'deployment_content_unavailable' : page.error;
            throw Object.assign(new Error(code), { code });
        }
        for (const { environment, targetLink } of page.items) {
            if (!sameStrictJsonValue(targetLink.source, input.source) || targetLink.targetKind !== input.targetKind
                || (environment.id === input.environmentId && targetLink.id === input.replacesLinkId)) continue;
            const opened = readDeploymentTargetLinkArtifactV1(targetLink, await reads.artifact(targetLink));
            if (!opened.ok || !opened.content.providerIdentity) {
                const code = opened.ok ? 'deployment_content_unavailable' : opened.error;
                throw Object.assign(new Error(code), { code });
            }
            if (sameStrictJsonValue(opened.content.providerIdentity, input.provider.providerIdentity)) return {
                ok: false, error: 'provider_scope_already_linked', targetLinkId: targetLink.id,
                environment: { serverId: input.serverId, projectSourceId: environment.projectSourceId, environmentId: environment.id },
            };
        }
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
}
