import { refuseDeploymentArtifactRead } from '@/deployments/deploymentFailure';
import { type DeploymentEnvironmentDetailV1, type DeploymentEnvironmentContentV1 } from '@happier-dev/deployments/contracts/v1';
import { readDeploymentDomainArtifactV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployments';
import { readDeploymentDomainServingUrlV1, type DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { DeploymentDomainMutationResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentPreviewTemplateV1, DeploymentPreviewDomainFactV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import type { EnvironmentVariableBindingV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { createActionExecuteFailureError, ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

const refuse = (failure: string | ActionExecuteFailure): never => {
    const code = typeof failure === 'string' ? failure : failure.errorCode;
    throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: code, error: code }), { ...(typeof failure === 'string' ? undefined : { cause: failure }) });
};
type Selection = NonNullable<DeploymentPreviewTemplateV1['domain']>;

/** The reviewed route and pre-deployment variables use the same planned address. */
export function preparePreviewDomainForHost(input: Readonly<{
    selection: Selection; pullRequestNumber: number; domain: DeploymentDomainContentV1;
}>): Readonly<{ content: DeploymentDomainContentV1 & { hostname: string }; url: string }> {
    const { hostname } = input.domain;
    const suffix = hostname?.startsWith('*.') ? hostname.slice(1) : refuse('target_mismatch');
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
    const loaded = await host.readMetadata({ serverId: input.serverId,
        environmentId: input.templateEnvironmentId, domainId: input.selection.domainId });
    const failure = ActionExecuteFailureSchema.safeParse(loaded);
    if (failure.success) return refuse(failure.data);
    const result = DeploymentDomainMutationResultV1Schema.parse(loaded);
    if (!result.ok) return refuse(result.error);
    if (result.domain.id !== input.selection.domainId || result.domain.environmentId !== input.templateEnvironmentId)
        return refuse('target_mismatch');
    const opened = readDeploymentDomainArtifactV1(result.domain, await host.open(result.domain.contentArtifactId));
    if (!opened.ok) return refuseDeploymentArtifactRead(opened);
    return preparePreviewDomainForHost({ selection: input.selection, pullRequestNumber: input.pullRequestNumber, domain: opened.content });
}

/** Capture only when an actual dynamic preview variable needs this fact. */
export async function preparePreviewDomainFactForHost(input: Readonly<{
    serverId: string; provenance: DeploymentEnvironmentContentV1['previewProvenance'];
    sources: readonly EnvironmentVariableBindingV1['source'][];
}>, host: Readonly<{
    readTemplate(environmentId: string): Promise<DeploymentEnvironmentDetailV1>;
    readDomain(input: Parameters<typeof readPreviewDomainForHost>[0]): ReturnType<typeof readPreviewDomainForHost>;
}>): Promise<DeploymentPreviewDomainFactV1 | undefined> {
    if (!input.sources.some(source => source.kind === 'deploymentFact'
        && (source.fact === 'domainUrl' || source.fact === 'primaryUrl'))) return undefined;
    const provenance = input.provenance ?? refuse('reference_unavailable');
    const template = await host.readTemplate(provenance.templateEnvironmentId);
    const selection = template.content.previewTemplate?.domain ?? refuse('reference_unavailable');
    const planned = await host.readDomain({ serverId: input.serverId,
        templateEnvironmentId: provenance.templateEnvironmentId, selection,
        pullRequestNumber: provenance.pullRequestNumber });
    return { domainId: selection.domainId, url: planned.url };
}
