import { createHash } from 'node:crypto';
import type { DeploymentEnvironmentHeaderV1, DeploymentTargetLinkHeaderV1, DeploymentTargetV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentTargetLinkProviderContentV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import type { ScmHostingPullRequestLifecycleV1 } from '@happier-dev/protocol';
import { WorkflowDefinitionV1Schema, type WorkflowActionFieldBindingV1, type WorkflowActionLeafV1, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { DeploymentPreviewProvenanceV1Schema } from '@happier-dev/protocol/deployments/deploymentPreviewProvenanceV1';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveWorkflowActionFieldBinding, WorkflowInputResolutionError } from '@/daemon/workflows/input';
import { admitPreviewEnvironmentForHost } from './previewAdmissionForHost';
import type { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';

/** Admitted Forge lifecycle facts; generic deployment code carries no plugin event ids. */
export type PreviewLifecycleEventForHost = ScmHostingPullRequestLifecycleV1;
export type PreviewTemplateRefForHost = Readonly<{ serverId: string; environmentId: string }>;
export type PreviewWorkflowForHostInput = Readonly<{
    templateRef: PreviewTemplateRefForHost;
    event: PreviewLifecycleEventForHost;
    occurrenceKey: string;
    readEnvironment(reference: PreviewTemplateRefForHost): Promise<Pick<Awaited<ReturnType<typeof readDeploymentEnvironmentForHost>>, 'environment' | 'content' | 'targetLinks'>>;
    readTargetLink(reference: PreviewTemplateRefForHost & Readonly<{ targetLinkId: string }>): Promise<Readonly<{
        header: DeploymentTargetLinkHeaderV1; provider: DeploymentTargetLinkProviderContentV1;
    }>>;
    readTargetDeclaration(source: DeploymentTargetV1['source']): Promise<DeploymentTargetV1 | null>;
    readExistingPreview?(input: Readonly<{ templateRef: PreviewTemplateRefForHost; event: PreviewLifecycleEventForHost }>): Promise<DeploymentEnvironmentHeaderV1 | null>;
    readCloseDefinition?(input: Readonly<{ templateRef: PreviewTemplateRefForHost; event: PreviewLifecycleEventForHost }>): Promise<WorkflowDefinitionV1 | null>;
}>;
export type PreviewWorkflowForHostResult = Readonly<{ kind: 'available'; definition: WorkflowDefinitionV1 }>
    | Readonly<{ kind: 'skipped' | 'refused'; reason: string }>;

const literal = (value: JsonValue): Extract<WorkflowActionFieldBindingV1, { kind: 'literal' }> => ({ kind: 'literal', value });
const result = (blockId: string, ...path: (string | number)[]): Extract<WorkflowActionFieldBindingV1, { kind: 'result' }> => ({
    kind: 'result', producer: { blockId, scope: { kind: 'current' } }, path,
});
const fields = (value: Readonly<Record<string, JsonValue>>): Record<string, WorkflowActionFieldBindingV1> =>
    Object.fromEntries(Object.entries(value).map(([name, value]) => [name, literal(value)]));

/** Template intent and declared plugin policy compose ordinary Actions. Effect admission stays with each Action owner. */
export async function resolvePreviewWorkflowForHost(input: PreviewWorkflowForHostInput): Promise<PreviewWorkflowForHostResult> {
    if (input.event.action === 'closed' || input.event.action === 'merged') {
        const definition = await input.readCloseDefinition?.({ templateRef: input.templateRef, event: input.event });
        return definition ? { kind: 'available', definition } : { kind: 'skipped', reason: 'not_found' };
    }
    const template = await input.readEnvironment(input.templateRef);
    const policy = template.content.previewTemplate;
    if (!policy?.enabled) return { kind: 'skipped', reason: 'deployment_access_denied' };
    const provenance = DeploymentPreviewProvenanceV1Schema.safeParse({ v: 1,
        templateEnvironmentId: input.templateRef.environmentId, runtimeTargetLinkId: policy.runtimeTargetLinkId,
        repository: input.event.baseRepository, headRepository: input.event.headRepository,
        pullRequestId: input.event.id, pullRequestNumber: input.event.number,
        author: { id: input.event.author.id, login: input.event.author.login },
    });
    if (!provenance.success) return { kind: 'refused', reason: 'deployment_content_unavailable' };
    try {
        await admitPreviewEnvironmentForHost({ content: { previewProvenance: provenance.data },
            templateEnvironmentId: input.templateRef.environmentId, projectSourceId: template.environment.projectSourceId,
        }, { readTemplate: async () => template });
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
            return { kind: 'refused', reason: error.code };
        throw error;
    }
    const requestKey = `preview-${createHash('sha256').update(JSON.stringify([
        input.templateRef.serverId, template.environment.id, input.event.id, input.event.headSha, input.occurrenceKey,
    ])).digest('hex')}`;
    const deployInput = fields({ serverId: input.templateRef.serverId, requestKey: `${requestKey}-deploy`, sha: input.event.headSha });
    const existing = await input.readExistingPreview?.({ templateRef: input.templateRef, event: input.event });
    if (existing) {
        if (!existing.runtimeTargetLinkId) return { kind: 'refused', reason: 'target_mismatch' };
        return { kind: 'available', definition: WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{
            id: 'preview-deploy', kind: 'action', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1,
            input: { ...deployInput, ...fields({ environmentId: existing.id, targetLinkId: existing.runtimeTargetLinkId }) },
        }] }) };
    }
    const createId = 'preview-create';
    const blocks: WorkflowActionLeafV1[] = [{ id: createId, kind: 'action', actionId: DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1,
        input: fields({ serverId: input.templateRef.serverId, projectSourceId: template.environment.projectSourceId,
            requestKey, mode: 'apply', name: `pr-${input.event.number}`, purpose: 'preview', protection: 'nonProduction',
            deployerMode: template.environment.deployerMode,
            ...(template.environment.deployerPrincipals ? { deployerPrincipals: template.environment.deployerPrincipals } : {}),
            preview: { templateEnvironmentId: template.environment.id, expectedTemplateRevision: template.environment.revision,
                runtimeTargetLinkId: policy.runtimeTargetLinkId, pullRequestId: input.event.id, headSha: input.event.headSha,
                provenance: provenance.data },
        }),
    }];
    let revision: WorkflowActionFieldBindingV1 = result(createId, 'revision');
    const preview: JsonValue = { name: `pr-${input.event.number}`, repository: input.event.baseRepository, pullRequestId: input.event.id,
        headRef: input.event.headRef, headSha: input.event.headSha,
        correlation: { repository: input.event.baseRepository, pullRequestId: input.event.id } };
    for (const [index, selection] of policy.data.entries()) {
        if (selection.kind !== 'managed') return { kind: 'refused', reason: 'unsupported_action' };
        const linked = await input.readTargetLink({ ...input.templateRef, targetLinkId: selection.dataTargetLinkId });
        const target = await input.readTargetDeclaration(linked.header.source);
        if (linked.header.role !== 'data' || target?.role !== 'data' || target.targetKind !== linked.header.targetKind)
            return { kind: 'refused', reason: 'target_mismatch' };
        const branch = target.dataV1?.branches;
        if (!branch?.create || !branch.previewInput) return { kind: 'refused', reason: 'unsupported_action' };
        const principal = linked.provider.credentialPrincipal;
        if (principal.kind !== 'account' || principal.target.kind !== 'account')
            return { kind: 'refused', reason: 'deployment_target_role_unavailable' };
        const operands: Record<string, WorkflowActionFieldBindingV1> = {};
        try {
            for (const [name, binding] of Object.entries(branch.previewInput)) {
                const value = await resolveWorkflowActionFieldBinding(binding, {
                    inputs: { preview }, resolveResult: async () => { throw new WorkflowInputResolutionError('invalid_reference_scope'); },
                    resolveWorkspace: async () => { throw new WorkflowInputResolutionError('invalid_reference_scope'); },
                });
                operands[name] = literal(value);
            }
        } catch (error) {
            if (error instanceof WorkflowInputResolutionError) return { kind: 'refused', reason: 'unsupported_action' };
            throw error;
        }
        const branchId = `preview-data-${index}`;
        const linkId = `preview-data-link-${index}`;
        const targetLink = result(createId, 'previewDataTargets', index, 'targetLinkId');
        const targetLinkRevision = result(createId, 'previewDataTargets', index, 'targetLinkRevision');
        blocks.push({ id: branchId, kind: 'action', actionId: branch.create.actionId, input: {
            ...operands, ...fields({ v: 1, serverId: input.templateRef.serverId,
                credentialRef: principal.target.account, ...linked.provider, parentBranchRef: selection.parentBranchRef }),
            environmentId: result(createId, 'environmentId'), expectedRevision: revision,
            targetLinkId: targetLink, expectedTargetLinkRevision: targetLinkRevision,
        } });
        blocks.push({ id: linkId, kind: 'action', actionId: 'deployments.targets.link', input: {
            ...fields({ serverId: input.templateRef.serverId, requestKey: `${requestKey}-data-${index}`,
                targetId: target.id, source: target.source, role: 'data', targetKind: target.targetKind, machines: [],
                ...(linked.header.machineId ? { machineId: linked.header.machineId, installationId: linked.header.installationId! } : {}) }),
            environmentId: result(createId, 'environmentId'), expectedRevision: revision,
            replacesLinkId: targetLink, expectedTargetLinkRevision: targetLinkRevision,
            provider: { kind: 'object', fields: { credentialPrincipal: literal(principal),
                providerIdentity: result(branchId, 'providerIdentity'), providerEnvironment: result(branchId, 'providerEnvironment'),
                ...(linked.provider.repositoryAccess ? { repositoryAccess: literal(linked.provider.repositoryAccess) } : {}),
                ...(linked.provider.preparedNative ? { preparedNative: literal(linked.provider.preparedNative) } : {}) } },
        } });
        revision = result(linkId, 'revision');
    }
    blocks.push({ id: 'preview-deploy', kind: 'action', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, input: {
        ...deployInput,
        environmentId: result(createId, 'environmentId'), targetLinkId: result(createId, 'runtimeTargetLinkId'),
    } });
    return { kind: 'available', definition: WorkflowDefinitionV1Schema.parse({ version: 1, blocks }) };
}
