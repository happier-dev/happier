import { readDeploymentDomainArtifactV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import { readDeploymentDomainServingUrlV1, type DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { DeploymentDomainMutationResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentPreviewTemplateV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
type Selection = NonNullable<DeploymentPreviewTemplateV1['domain']>;

/** The reviewed route and pre-deployment variables use the same planned address. */
export function preparePreviewDomainForHost(input: Readonly<{
    selection: Selection; pullRequestNumber: number; domain: DeploymentDomainContentV1;
}>): Readonly<{ content: DeploymentDomainContentV1; url: string }> {
    const suffix = input.domain.hostname.startsWith('*.') ? input.domain.hostname.slice(1) : refuse('target_mismatch');
    const label = input.selection.hostnamePattern.replaceAll('{number}', String(input.pullRequestNumber))
        .replaceAll('{template-slug}', input.selection.templateSlug);
    // Captured provider observations and native custody belong to the template route.
    const { providerObservation: _observation, cloudflarePreparation: _custody, ...desired } = input.domain;
    const content = { ...desired, hostname: `${label}${suffix}` };
    const url = readDeploymentDomainServingUrlV1(content) ?? refuse('deployment_content_unavailable');
    return { content, url };
}

/** Exact selected template Domain read through ordinary Domain/Artifact boundaries. */
export async function readPreviewDomainForHost(input: Readonly<{
    serverId: string; templateEnvironmentId: string; selection: Selection; pullRequestNumber: number;
}>, host: Readonly<{
    readMetadata(input: Readonly<{ serverId: string; environmentId: string; domainId: string }>): Promise<unknown>;
    open(artifactId: string): Promise<DeploymentArtifactDocumentV1 | null>;
}>): Promise<ReturnType<typeof preparePreviewDomainForHost>> {
    const result = DeploymentDomainMutationResultV1Schema.parse(await host.readMetadata({ serverId: input.serverId,
        environmentId: input.templateEnvironmentId, domainId: input.selection.domainId }));
    if (!result.ok) return refuse(result.error);
    if (result.domain.id !== input.selection.domainId || result.domain.environmentId !== input.templateEnvironmentId)
        return refuse('target_mismatch');
    const opened = readDeploymentDomainArtifactV1(result.domain, await host.open(result.domain.contentArtifactId));
    if (!opened.ok) return refuse(opened.error);
    return preparePreviewDomainForHost({ selection: input.selection, pullRequestNumber: input.pullRequestNumber, domain: opened.content });
}
