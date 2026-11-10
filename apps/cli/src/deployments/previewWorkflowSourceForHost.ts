import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
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
            if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
            const detail = DeploymentEnvironmentGetResultV1Schema.parse(result.result);
            if (!detail.ok) throw Object.assign(new Error(detail.error), { code: detail.error });
            return detail;
        }, open, assertCurrent: async () => { input.signal?.throwIfAborted(); },
    });
    const readChildren = async () => {
        const environments: Extract<ReturnType<typeof DeploymentEnvironmentListResultV1Schema.parse>, { ok: true }>['items'] = [];
        let cursor: string | undefined;
        do {
            const result = await input.executor.execute('deployments.environments.list', { serverId: input.templateRef.serverId,
                previewRepository: input.event.baseRepository, previewPullRequestIds: [input.event.id],
                previewTemplateEnvironmentId: input.templateRef.environmentId, ...(cursor ? { cursor } : {}) }, context);
            if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
            const page = DeploymentEnvironmentListResultV1Schema.parse(result.result);
            if (!page.ok) throw Object.assign(new Error(page.error), { code: page.error });
            environments.push(...page.items);
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return environments;
    };
    let selectedTemplate: Awaited<ReturnType<typeof readEnvironment>> | undefined;
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
        readExistingPreview: async () => (await readChildren())[0] ?? null,
        readCloseDefinition: async () => readPreviewCloseWorkflowForHost({
            readEnvironments: readChildren,
            readEnvironment: async environmentId => {
                const child = await readEnvironment({ serverId: input.templateRef.serverId, environmentId });
                return { ...child, targetLinks: child.targetLinks.map(targetLink => ({ targetLink })) };
            },
            readInvocations: async request => {
                const result = await input.executor.execute('workflow.run.invocations.list', { ...request, includeContent: true }, context);
                if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
                return WorkflowInvocationListResultV1Schema.parse(result.result);
            },
        }),
    });
}
