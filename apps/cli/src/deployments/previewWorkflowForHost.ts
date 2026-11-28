import { createHash } from 'node:crypto';
import type { DeploymentEnvironmentHeaderV1, DeploymentTargetLinkHeaderV1, DeploymentTargetV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentTargetLinkProviderContentV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import type { ScmHostingPullRequestLifecycleV1 } from '@happier-dev/protocol';
import { WorkflowDefinitionV1Schema, type WorkflowActionFieldBindingV1, type WorkflowBlock, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { DeploymentPreviewProvenanceV1Schema, deploymentPreviewHeadNeedsRedeployV1 } from '@happier-dev/protocol/deployments/deploymentPreviewProvenanceV1';
import type { DeploymentPreviewDataSelectionV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1,
    DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1,
    DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveWorkflowActionFieldBinding, WorkflowInputResolutionError } from '@/daemon/workflows/input';
import { admitPreviewEnvironmentForHost } from './previewAdmissionForHost';
import type { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import type { PreviewNativeDataPlacementForHost } from './templates/previewCreate';
import type { readPreviewDomainForHost } from './previewDomainForHost';

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
    readPreviewDomain?(input: Parameters<typeof readPreviewDomainForHost>[0]): ReturnType<typeof readPreviewDomainForHost>;
    readNativeDataPlacements?(input: Readonly<{
        selections: readonly DeploymentPreviewDataSelectionV1[];
        existingTemplate: Awaited<ReturnType<typeof readDeploymentEnvironmentForHost>>['content']['template'];
    }>): Promise<readonly PreviewNativeDataPlacementForHost[]>;
    readExistingPreview?(input: Readonly<{ templateRef: PreviewTemplateRefForHost; event: PreviewLifecycleEventForHost }>): Promise<Readonly<{
        environment: DeploymentEnvironmentHeaderV1; nativeData?: 'ready' | 'incomplete'; domainRevision?: number;
    }> | null>;
    readServingHead?(): Promise<string | null>;
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
    let fork: boolean;
    try {
        ({ fork } = await admitPreviewEnvironmentForHost({ content: { previewProvenance: provenance.data },
            templateEnvironmentId: input.templateRef.environmentId, projectSourceId: template.environment.projectSourceId,
        }, { readTemplate: async () => template }));
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
            return { kind: 'refused', reason: error.code };
        throw error;
    }
    if (input.event.action === 'synchronize' && input.readServingHead
        && !deploymentPreviewHeadNeedsRedeployV1(await input.readServingHead(), input.event.headSha)) {
        return { kind: 'skipped', reason: 'already_deployed' };
    }
    const requestKey = `preview-${createHash('sha256').update(JSON.stringify([
        input.templateRef.serverId, template.environment.id, input.event.id, input.event.headSha, input.occurrenceKey,
    ])).digest('hex')}`;
    const finish = async (blocks: WorkflowBlock[], environmentId: WorkflowActionFieldBindingV1,
        domainRevision?: number): Promise<PreviewWorkflowForHostResult> => {
        if (policy.domain) {
            if (!input.readPreviewDomain) return { kind: 'refused', reason: 'deployment_unavailable' };
            const domain = await input.readPreviewDomain({ serverId: input.templateRef.serverId,
                templateEnvironmentId: template.environment.id, selection: policy.domain, pullRequestNumber: input.event.number });
            blocks.push(...previewDomainBlocks({ serverId: input.templateRef.serverId, requestKey, environmentId,
                content: domain.content, ...(domainRevision === undefined ? {} : { domainRevision }) }));
        }
        return { kind: 'available', definition: WorkflowDefinitionV1Schema.parse({ version: 1, blocks }) };
    };
    const deployInput = fields({ serverId: input.templateRef.serverId, requestKey: `${requestKey}-deploy`, sha: input.event.headSha });
    const existing = fork ? null : await input.readExistingPreview?.({ templateRef: input.templateRef, event: input.event });
    if (existing) {
        if (existing.nativeData === 'incomplete') return { kind: 'refused', reason: 'restore_prepare_required' };
        if (!existing.environment.runtimeTargetLinkId) return { kind: 'refused', reason: 'target_mismatch' };
        return finish([{
            id: 'preview-deploy', kind: 'action', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1,
            input: { ...deployInput, ...fields({ environmentId: existing.environment.id, targetLinkId: existing.environment.runtimeTargetLinkId }) },
        }], literal(existing.environment.id), existing.domainRevision);
    }
    const createId = 'preview-create';
    const createInput = fields({ serverId: input.templateRef.serverId, projectSourceId: template.environment.projectSourceId,
            requestKey, mode: 'apply', name: `pr-${input.event.number}`, purpose: 'preview', protection: 'nonProduction',
            deployerMode: template.environment.deployerMode,
            ...(template.environment.deployerPrincipals ? { deployerPrincipals: template.environment.deployerPrincipals } : {}),
            preview: { templateEnvironmentId: template.environment.id, expectedTemplateRevision: template.environment.revision,
                runtimeTargetLinkId: policy.runtimeTargetLinkId, pullRequestId: input.event.id, headSha: input.event.headSha,
                provenance: provenance.data, ...(input.event.title ? { pullRequestTitle: input.event.title } : {}) },
        });
    const blocks: WorkflowBlock[] = [{ id: createId, kind: 'action', actionId: DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1,
        input: createInput }];
    // The exact-head Create owns the fork's Deploy continuation, including synchronization.
    if (fork) return { kind: 'available', definition: WorkflowDefinitionV1Schema.parse({ version: 1, blocks }) };
    let revision: WorkflowActionFieldBindingV1 = result(createId, 'revision');
    const nativeSelections = policy.data.filter(selection => selection.kind === 'template');
    const runtime = template.targetLinks.find(link => link.id === policy.runtimeTargetLinkId);
    const machine = runtime?.members[0];
    // Create admits the supported placement; the public copy owner admits the
    // source grant and destination. The producer only selects their executor.
    if (nativeSelections.length && !machine)
        return { kind: 'refused', reason: 'unsupported_action' };
    let nativePlacements: readonly PreviewNativeDataPlacementForHost[] = [];
    if (nativeSelections.length) {
        if (!input.readNativeDataPlacements) return { kind: 'refused', reason: 'unsupported_action' };
        try {
            nativePlacements = await input.readNativeDataPlacements({ selections: policy.data, existingTemplate: template.content.template });
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
                return { kind: 'refused', reason: error.code };
            throw error;
        }
    }
    const companionId = 'preview-data-create';
    const companionRequired = nativePlacements.some(row => row.placement === 'companion');
    if (companionRequired) blocks.push({ id: companionId, kind: 'action', actionId: DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1,
        input: { ...createInput, ...fields({ requestKey: `${requestKey}-data`, name: `pr-${input.event.number}-data`, purpose: 'standard' }),
            previewCompanionOfEnvironmentId: result(createId, 'environmentId') } });
    const preview: JsonValue = { name: `pr-${input.event.number}`, repository: input.event.baseRepository, pullRequestId: input.event.id,
        headRef: input.event.headRef, headSha: input.event.headSha,
        correlation: { repository: input.event.baseRepository, pullRequestId: input.event.id } };
    let managedIndex = 0;
    for (const [index, selection] of policy.data.entries()) {
        if (selection.kind !== 'managed') continue;
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
        const targetLink = result(createId, 'previewDataTargets', managedIndex, 'targetLinkId');
        const targetLinkRevision = result(createId, 'previewDataTargets', managedIndex++, 'targetLinkRevision');
        const { displayName: _displayName, ...parentBranchRef } = selection.parentBranchRef;
        blocks.push({ id: branchId, kind: 'action', actionId: branch.create.actionId, input: {
            ...operands, ...fields({ v: 1, serverId: input.templateRef.serverId,
                credentialRef: principal.target.account, ...linked.provider, parentBranchRef }),
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
    const copied: string[] = [];
    const provisioned: string[] = [];
    if (nativeSelections.length) {
        for (const placement of ['repository', 'companion'] as const) {
            const selected = nativePlacements.filter(row => row.placement === placement);
            if (!selected.length) continue;
            const destinationCreateId = placement === 'repository' ? createId : companionId;
            const id = placement === 'repository' ? 'preview-data-provision' : 'preview-data-companion-provision';
            if (selected.some(({ selectionIndex }) => {
                const choice = policy.data[selectionIndex];
                return choice?.kind === 'template' && !choice.copyFrom;
            })) provisioned.push(id);
            blocks.push({ id,
                kind: 'action', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, input: {
                    ...fields({ serverId: input.templateRef.serverId,
                        ...(placement === 'repository' ? { sha: input.event.headSha } : {}) }),
                    requestKey: literal(`${requestKey}-provision-${placement}`),
                    environmentId: result(destinationCreateId, 'environmentId'), targetLinkId: result(destinationCreateId, 'runtimeTargetLinkId'),
                    services: { kind: 'list', items: selected.map((_, index) => result(destinationCreateId, 'previewNativeData', index, 'service')) },
                } });
        }
        let repositoryIndex = 0;
        let companionIndex = 0;
        for (const [index, placement] of nativePlacements.entries()) {
            const selection = policy.data[placement.selectionIndex];
            const destinationCreateId = placement.placement === 'repository' ? createId : companionId;
            const destinationIndex = placement.placement === 'repository' ? repositoryIndex++ : companionIndex++;
            if (selection?.kind !== 'template' || !selection.copyFrom) continue;
            const source = selection.copyFrom;
            const currentId = index === 0 ? 'preview-data-current' : `preview-data-current-${index}`;
            const prepareId = `preview-copy-${index}-prepare`;
            const confirmId = `preview-copy-${index}-confirm`;
            const prior = copied.at(-1);
            const onlyWhen = prior ? { kind: 'compare' as const, operator: 'eq' as const,
                left: result(prior, 'verified'), right: literal(true) } : undefined;
            blocks.push({ id: currentId, kind: 'action', actionId: DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1,
                ...(onlyWhen ? { onlyWhen } : {}), input: {
                    serverId: literal(input.templateRef.serverId), environmentId: result(destinationCreateId, 'environmentId'),
                } });
            const copyInput: Record<string, WorkflowActionFieldBindingV1> = {
                ...fields({ serverId: input.templateRef.serverId, machineId: machine!.machineId,
                    installationId: machine!.installationId, deploymentId: source.deploymentId,
                    source: { kind: 'repository', snapshotId: source.snapshotId,
                        ...(source.backupOperationId ? { backupOperationId: source.backupOperationId } : {}),
                        origin: { environmentId: source.environmentId, targetLinkId: source.targetLinkId } } }),
                environmentId: result(destinationCreateId, 'environmentId'), targetLinkId: result(destinationCreateId, 'runtimeTargetLinkId'),
                expectedRevision: result(currentId, 'environment', 'revision'),
                destination: { kind: 'object', fields: {
                    kind: literal('database'),
                    service: result(destinationCreateId, 'previewNativeData', destinationIndex, 'service'),
                    database: result(destinationCreateId, 'previewNativeData', destinationIndex, 'database'),
                } },
            };
            blocks.push({ id: prepareId, kind: 'action', actionId: DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
                ...(onlyWhen ? { onlyWhen } : {}), input: { ...copyInput, mode: literal('prepare') } });
            blocks.push({ id: confirmId, kind: 'action', actionId: DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
                ...(onlyWhen ? { onlyWhen } : {}), input: { ...copyInput, mode: literal('confirm'),
                    prepareOperationId: result(prepareId, 'operationId') } });
            copied.push(confirmId);
        }
    }
    const readiness = [
        ...provisioned.map(deploymentSettledCondition),
        ...copied.map(id => ({ kind: 'compare' as const, operator: 'eq' as const,
            left: result(id, 'verified'), right: literal(true) })),
    ];
    const dataReady = readiness.length ? { kind: 'all' as const, conditions: readiness } : undefined;
    if (companionRequired) {
        blocks.push({ id: 'preview-data-connect-current', kind: 'action', actionId: DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1,
            ...(dataReady ? { onlyWhen: dataReady } : {}), input: {
                serverId: literal(input.templateRef.serverId), environmentId: result(createId, 'environmentId'),
            } });
        blocks.push({ id: 'preview-data-connect', kind: 'action', actionId: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
            ...(dataReady ? { onlyWhen: dataReady } : {}), input: {
                serverId: literal(input.templateRef.serverId), environmentId: result(createId, 'environmentId'),
                expectedRevision: result('preview-data-connect-current', 'environment', 'revision'),
                set: result(companionId, 'previewNativeBindings'), remove: literal([]),
            } });
    }
    blocks.push({ id: 'preview-deploy', kind: 'action', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, input: {
        ...deployInput,
        environmentId: result(createId, 'environmentId'), targetLinkId: result(createId, 'runtimeTargetLinkId'),
    }, ...(dataReady ? { onlyWhen: dataReady } : {}) });
    return finish(blocks, result(createId, 'environmentId'));
}

function deploymentSettledCondition(blockId: string) {
    return { kind: 'any' as const, conditions: ['succeeded', 'running_unverified'].map(state => ({
        kind: 'compare' as const, operator: 'eq' as const, left: result(blockId, 'state'), right: literal(state),
    })) };
}

function previewDomainBlocks(input: Readonly<{
    serverId: string; requestKey: string; environmentId: WorkflowActionFieldBindingV1;
    content: Awaited<ReturnType<typeof readPreviewDomainForHost>>['content']; domainRevision?: number;
}>): WorkflowBlock[] {
    const settled = deploymentSettledCondition('preview-deploy');
    const current = (...path: (string | number)[]): Extract<WorkflowActionFieldBindingV1, { kind: 'result' }> => ({
        kind: 'result', producer: { blockId: 'preview-domain-current', scope: { kind: 'outer', levels: 1 } }, path,
    });
    return [{ id: 'preview-domain-current', kind: 'action', actionId: DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1,
        onlyWhen: settled, input: { serverId: literal(input.serverId), environmentId: input.environmentId } },
    { id: 'preview-domain-links', kind: 'loop', onlyWhen: settled,
        repetition: { kind: 'items', items: result('preview-domain-current', 'targetLinks'),
            execution: 'sequential', failurePolicy: 'fail_stop' }, body: [{
            id: 'preview-domain-add', kind: 'action', actionId: DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1,
            onlyWhen: { kind: 'compare', operator: 'eq', left: { kind: 'item', field: 'value', path: ['id'] },
                right: current('environment', 'runtimeTargetLinkId') }, input: {
                ...fields({ serverId: input.serverId, requestKey: `${input.requestKey}-domain`, content: input.content,
                    ...(input.domainRevision === undefined ? {} : { expectedDomainRevision: input.domainRevision }) }),
                environmentId: current('environment', 'id'), domainId: current('environment', 'id'),
                expectedRevision: current('environment', 'revision'), targetLinkId: { kind: 'item', field: 'value', path: ['id'] },
                expectedTargetLinkRevision: { kind: 'item', field: 'value', path: ['revision'] },
            },
        }] }];
}
