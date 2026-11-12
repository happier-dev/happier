import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema,
    DeploymentDomainListResultV1Schema, type DeploymentEnvironmentListInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readDeploymentTargetLinkArtifactV1 } from '@happier-dev/deployment-protocol';
import type { StoredCredentials } from '@/persistence';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import { readDeploymentTargetV1 } from './targets/deploymentTargetCatalog';
import { resolvePreviewWorkflowForHost, type PreviewLifecycleEventForHost, type PreviewTemplateRefForHost } from './previewWorkflowForHost';
import { readPreviewCloseWorkflowForHost } from './previewCloseWorkflowForHost';
import { readPreviewCopyReadinessForHost } from './previewCopyReadinessForHost';
import { preparePreviewNativeDataPlacementsForHost } from './templates/previewCreate';
import { readPreviewDomainForHost } from './previewDomainForHost';
import { readDeploymentDomainInventoryForHost } from './targets/ownServer/domainRouteSelection';

/** Account reads use the same Action transport and Artifact codecs as native preparation. */
export async function resolveDeploymentPreviewWorkflowSourceForHost(input: Readonly<{
    templateRef: PreviewTemplateRefForHost; event: PreviewLifecycleEventForHost; occurrenceKey: string;
    executor: Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
    credentials: StoredCredentials; serverHttpBaseUrl: string;
    contributes: ResolvedContributionRegistry; signal?: AbortSignal;
}>) {
    const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation',
        actionCaller: { kind: 'host' }, ...(input.signal ? { signal: input.signal } : {}) };
    const artifacts = createCredentialedAccountArtifactStore(input.credentials);
    const open = (artifactId: string) => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => artifacts.read(artifactId,
        { prepareRecipients: false, includeSharedAudience: false, ...(input.signal ? { signal: input.signal } : {}) }));
    const readEnvironment = (reference: PreviewTemplateRefForHost) => readDeploymentEnvironmentForHost({ environmentId: reference.environmentId, context }, {
        readMetadata: async ({ environmentId }) => {
            const result = await input.executor.execute('deployments.environments.get', { serverId: reference.serverId, environmentId }, context);
            if (!result.ok) throw Object.assign(new Error(result.errorCode, { cause: result }), { code: result.errorCode });
            const detail = DeploymentEnvironmentGetResultV1Schema.parse(result.result);
            if (!detail.ok) throw Object.assign(new Error(detail.error), { code: detail.error });
            return detail;
        }, open, assertCurrent: async () => { input.signal?.throwIfAborted(); },
    });
    const readEnvironments = async (selection: Omit<DeploymentEnvironmentListInputV1, 'serverId' | 'cursor'>) => {
        const environments: Extract<ReturnType<typeof DeploymentEnvironmentListResultV1Schema.parse>, { ok: true }>['items'] = [];
        let cursor: string | undefined;
        do {
            const result = await input.executor.execute('deployments.environments.list', { ...selection,
                serverId: input.templateRef.serverId, ...(cursor ? { cursor } : {}) }, context);
            if (!result.ok) throw Object.assign(new Error(result.errorCode, { cause: result }), { code: result.errorCode });
            const page = DeploymentEnvironmentListResultV1Schema.parse(result.result);
            if (!page.ok) throw Object.assign(new Error(page.error), { code: page.error });
            environments.push(...page.items);
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return environments;
    };
    const readChildren = (includeDeleted = false) => readEnvironments({ previewRepository: input.event.baseRepository,
        previewPullRequestIds: [input.event.id], previewTemplateEnvironmentId: input.templateRef.environmentId,
        ...(includeDeleted ? { includeDeleted: true } : {}) });
    const readCompanions = (environmentId: string) => readEnvironments({ previewCompanionOfEnvironmentId: environmentId });
    let selectedTemplate: Awaited<ReturnType<typeof readEnvironment>> | undefined;
    const readInvocations = async (request: Readonly<{ runId: string; cursor?: string }>) => {
        const result = await input.executor.execute('workflow.run.invocations.list', { ...request, includeContent: true }, context);
        if (!result.ok) throw Object.assign(new Error(result.errorCode, { cause: result }), { code: result.errorCode });
        return WorkflowInvocationListResultV1Schema.parse(result.result);
    };
    return resolvePreviewWorkflowForHost({ templateRef: input.templateRef, event: input.event, occurrenceKey: input.occurrenceKey,
        readEnvironment: async reference => { selectedTemplate = await readEnvironment(reference); return selectedTemplate; },
        readTargetLink: async reference => {
            const environment = selectedTemplate?.environment.id === reference.environmentId ? selectedTemplate : await readEnvironment(reference);
            const header = environment.targetLinks.find(link => link.id === reference.targetLinkId);
            if (!header) throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
            const opened = readDeploymentTargetLinkArtifactV1(header, await open(header.contentArtifactId));
            if (!opened.ok) throw Object.assign(new Error(opened.error), { code: opened.error });
            return { header, provider: DeploymentTargetLinkProviderContentV1Schema.parse(opened.content) };
        },
        readTargetDeclaration: async source => readDeploymentTargetV1(source, input.contributes.deploymentTargets),
        readPreviewDomain: request => readPreviewDomainForHost(request, {
            readMetadata: async operand => {
                const result = await input.executor.execute('deployments.domains.get', operand, context);
                if (!result.ok) throw Object.assign(new Error(result.errorCode, { cause: result }), { code: result.errorCode });
                return result.result;
            }, open,
        }),
        readNativeDataPlacements: request => preparePreviewNativeDataPlacementsForHost({ ...request, context }, {
            credentials: input.credentials, serverHttpBaseUrl: input.serverHttpBaseUrl,
        }),
        readExistingPreview: async () => {
            const existing = (await readChildren())[0];
            if (!existing) return null;
            const child = await readEnvironment({ serverId: input.templateRef.serverId, environmentId: existing.id });
            const companionHeader = (await readCompanions(existing.id))[0];
            const companion = companionHeader
                ? await readEnvironment({ serverId: input.templateRef.serverId, environmentId: companionHeader.id }) : null;
            const domains = selectedTemplate?.content.previewTemplate?.domain
                ? await readDeploymentDomainInventoryForHost({ serverId: input.templateRef.serverId,
                    environmentId: existing.id, signal: input.signal, list: async query => {
                        const result = await input.executor.execute('deployments.domains.list', query, context);
                        if (!result.ok) throw Object.assign(new Error(result.errorCode, { cause: result }), { code: result.errorCode });
                        return DeploymentDomainListResultV1Schema.parse(result.result);
                    } }) : undefined;
            if (domains && domains.kind !== 'ready') throw Object.assign(new Error(domains.reason), { code: domains.reason });
            const domain = domains?.kind === 'ready' ? domains.domains.find(domain => domain.id === existing.id) : undefined;
            return { environment: child.environment,
                ...(domain ? { domainRevision: domain.revision } : {}),
                nativeData: await readPreviewCopyReadinessForHost(child, readInvocations, companion) ? 'ready' : 'incomplete' };
        },
        readCloseDefinition: async () => readPreviewCloseWorkflowForHost({
            readEnvironments: () => readChildren(true), readCompanions,
            readEnvironment: async environmentId => {
                const child = await readEnvironment({ serverId: input.templateRef.serverId, environmentId });
                return { ...child, targetLinks: child.targetLinks.map(targetLink => ({ targetLink })) };
            },
            readInvocations,
        }),
    });
}
