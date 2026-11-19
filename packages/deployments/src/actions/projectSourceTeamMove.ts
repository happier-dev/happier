import { PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext, ActionExecutorDeps, HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { ProjectSourcesMoveToTeamInputV1Schema, type ProjectSourcesFailureV1,
    type ProjectSourcesMoveToTeamInputV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema,
    DeploymentReceiptListResultV1Schema, deploymentInProgressStates,
    type DeploymentEnvironmentHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ProjectDeploymentDefaultsOutputV1 } from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';
import { evaluateApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { WorkflowTriggerListResultV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { MachineAccessGrantsListResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { readDeploymentEnvironmentArtifactV1, type DeploymentArtifactDocumentV1 } from '../artifacts/deploymentArtifacts.js';

export type ProjectSourceTeamMoveAccountV1 = Readonly<{
    accountId: string;
    credentialAuthorityKind: string;
    invocationSignal?: AbortSignal;
    assertCurrent(context: ActionExecutorContext): void | Promise<void>;
}>;
export type ProjectSourceTeamMoveReadPortsV1 = Required<Pick<ActionExecutorDeps,
    'deploymentAction' | 'workflowAction' | 'machineAccessAction' | 'projectSourcesRead'>> & Readonly<{
    isSameHome(left: string, right: string): boolean;
    readDefaults(sourceId: string, context: ActionExecutorContext): Promise<ProjectDeploymentDefaultsOutputV1 | ActionExecuteFailure>;
    readArtifactContents(ids: readonly string[], context: ActionExecutorContext): Promise<readonly PromiseSettledResult<DeploymentArtifactDocumentV1 | null>[]>;
    readApiTokens(environmentIds: readonly string[], context: ActionExecutorContext): Promise<readonly AccountApiTokenSummaryV1[] | ActionExecuteFailure>;
}>;
export const moveFailure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
export class ProjectSourceTeamMoveReadFailure extends Error {
    constructor(readonly result: ActionExecuteFailure | ProjectSourcesFailureV1) { super('project_source_move_read_failed'); }
}

type MachineRole = 'runtime' | 'build' | 'controller' | 'edge' | 'data' | 'backup' | 'cleanup';
const refuse: (code: string) => never = (code) => { throw new ProjectSourceTeamMoveReadFailure(moveFailure(code)); };
const isArray: (value: unknown) => value is readonly unknown[] = Array.isArray;

/** The API-token owner discloses summaries; this owner selects the deployment credentials reviewed by Move. */
export function selectProjectSourceTeamMoveApiTokensV1(tokens: readonly AccountApiTokenSummaryV1[], environmentIds: readonly string[]) {
    return tokens.filter(token => environmentIds.some(environmentId =>
        evaluateApiTokenGrantV1({ grant: token.grant, actionId: 'deployments.deploy', environmentId }).ok));
}

/** One demanded, Source-scoped inventory for this Action invocation and its review. */
export async function readProjectSourceTeamMoveInventoryV1(account: ProjectSourceTeamMoveAccountV1, raw: unknown,
    context: ActionExecutorContext, ports: ProjectSourceTeamMoveReadPortsV1) {
    const input = ProjectSourcesMoveToTeamInputV1Schema.parse(raw);
    await account.assertCurrent(context);
    context.signal?.throwIfAborted();
    if (account.credentialAuthorityKind !== 'account' && account.credentialAuthorityKind !== 'terminal') refuse('action_forbidden');
    const read = await ports.projectSourcesRead({ serverId: input.serverId, sourceId: input.sourceId }, context);
    if (!read.ok) throw new ProjectSourceTeamMoveReadFailure(read);
    const source = read.source;
    if (!read.canManage || source.owner?.kind !== 'account' || source.owner.accountId !== account.accountId) {
        throw new ProjectSourceTeamMoveReadFailure({ ok: false, error: 'source_access_denied' });
    }
    if (source.revision !== input.expectedRevision) throw new ProjectSourceTeamMoveReadFailure({ ok: false, error: 'source_conflict', current: source });
    const headers: DeploymentEnvironmentHeaderV1[] = [];
    let cursor: string | undefined;
    do {
        const response = await ports.deploymentAction('deployments.environments.list', {
            serverId: input.serverId, projectSourceId: source.id, includeDeleted: true, ...(cursor ? { cursor } : {}),
        }, context);
        const failure = readActionFailureEnvelope(response);
        if (failure) throw new ProjectSourceTeamMoveReadFailure(failure);
        const page = DeploymentEnvironmentListResultV1Schema.parse(response);
        if (!page.ok) refuse(page.error);
        if (page.coverage === 'partial') refuse('deployment_content_unavailable');
        headers.push(...page.items);
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const environments = await Promise.all(headers.map(async header => {
        const response = await ports.deploymentAction('deployments.environments.get', { serverId: input.serverId,
            environmentId: header.id, includeRetainedTargetLinkCleanup: true }, context);
        const failure = readActionFailureEnvelope(response);
        if (failure) throw new ProjectSourceTeamMoveReadFailure(failure);
        const detail = DeploymentEnvironmentGetResultV1Schema.parse(response);
        if (!detail.ok) return refuse(detail.error);
        if (!detail.retainedTargetLinkCleanupCompleteIds) return refuse('deployment_content_unavailable');
        if (detail.environment.id !== header.id || detail.environment.projectSourceId !== source.id
            || !ports.isSameHome(detail.environment.serverId, input.serverId)) return refuse('deployment_invalid');
        const receipts = [];
        let receiptCursor: string | undefined;
        do {
            const response = await ports.deploymentAction('deployments.receipts.list', { serverId: input.serverId,
                environmentId: header.id, ...(receiptCursor ? { cursor: receiptCursor } : {}) }, context);
            const failure = readActionFailureEnvelope(response);
            if (failure) throw new ProjectSourceTeamMoveReadFailure(failure);
            const page = DeploymentReceiptListResultV1Schema.parse(response);
            if (!page.ok) return refuse(page.error);
            if (page.items.some(receipt => receipt.environmentId !== header.id)) return refuse('deployment_invalid');
            receipts.push(...page.items);
            receiptCursor = page.nextCursor ?? undefined;
        } while (receiptCursor);
        return { ...detail, retainedTargetLinkCleanupCompleteIds: detail.retainedTargetLinkCleanupCompleteIds, receipts };
    }));
    const defaults = await ports.readDefaults(source.id, context);
    if ('errorCode' in defaults) throw new ProjectSourceTeamMoveReadFailure(defaults);
    if (!defaults.ok) refuse(defaults.error);
    if (defaults.sourceRevision !== source.revision || defaults.projectSourceId !== source.id) refuse('source_conflict');
    const artifacts = [...new Set(environments.flatMap(detail => [detail.environment.contentArtifactId,
        ...detail.targetLinks.map(link => link.contentArtifactId), ...detail.receipts.map(receipt => receipt.contentArtifactId)])
        .concat(defaults.content ? [defaults.content.contentArtifactId] : []))];
    // Only Environment bodies supply Move operands. The existing sharing writer
    // opens every other Artifact when it prepares that grant's recipients.
    const environmentArtifactIds = [...new Set(environments.map(detail => detail.environment.contentArtifactId))];
    const documents = await ports.readArtifactContents(environmentArtifactIds, context);
    const opened = new Map(documents.map((document, index) => {
        if (document.status !== 'fulfilled') return refuse('deployment_content_unavailable');
        return [environmentArtifactIds[index]!, document.value] as const;
    }));
    const machines = new Map<string, Set<MachineRole>>();
    const activeReceiptStates = new Set(deploymentInProgressStates());
    const usedSecrets = new Map<string, Readonly<{ ref: string; resourceRevision: number }>>();
    const addMachine = (machineId: string | undefined, role: MachineRole) => {
        if (!machineId) return;
        const roles = machines.get(machineId) ?? new Set<MachineRole>();
        roles.add(role); machines.set(machineId, roles);
    };
    const details = environments.map(detail => {
        const content = readDeploymentEnvironmentArtifactV1(detail.environment, opened.get(detail.environment.contentArtifactId) ?? null);
        if (!content.ok) return refuse(content.error);
        const environment = detail.environment;
        if (environment.deletedAtMs === undefined) {
            addMachine(environment.controllerMachineId, 'controller');
            addMachine(environment.buildMachineId, 'build');
            if (environment.ingress?.kind === 'edgeCaddy') addMachine(environment.ingress.edgeMachineId, 'edge');
            // Backup executes on this Environment's existing controller/runtime placement;
            // destination configuration is opaque provider data, never a Machine selector.
            if (content.content.backup && !('notNeeded' in content.content.backup)) addMachine(environment.controllerMachineId, 'backup');
        }
        for (const link of detail.targetLinks) {
            const retained = environment.deletedAtMs !== undefined || link.deletedAtMs !== undefined || link.detachedAtMs !== undefined;
            if (retained && detail.retainedTargetLinkCleanupCompleteIds.includes(link.id)) continue;
            for (const machineId of [...link.machines, ...(link.machineId ? [link.machineId] : [])]) {
                addMachine(machineId, link.role);
                if (retained) addMachine(machineId, 'cleanup');
            }
        }
        for (const receipt of detail.receipts) {
            if (!activeReceiptStates.has(receipt.state)) continue;
            addMachine(receipt.acceptedExecution?.controller.machineId, 'controller');
            addMachine(receipt.acceptedExecution?.builder?.machineId, 'build');
        }
        for (const binding of environment.deletedAtMs === undefined ? content.content.bindings : []) if (binding.source.kind === 'secret') {
            const reference = { ref: binding.source.ref, resourceRevision: binding.source.resourceRevision };
            usedSecrets.set(JSON.stringify([reference.ref, reference.resourceRevision]), reference);
        }
        return { ...detail, content: content.content };
    });
    for (const detail of details) if (detail.environment.purpose === 'preview') {
        const template = details.find(candidate => candidate.environment.id === detail.environment.previewTemplateEnvironmentId);
        if (!template || template.environment.purpose !== 'standard'
            || !template.targetLinks.some(link => link.id === detail.environment.previewTargetLinkId)) refuse('deployment_invalid');
    }
    const machineAccess = await Promise.all([...machines].map(async ([machineId, roles]) => {
        const response = await ports.machineAccessAction({ actionId: 'machines.access.grants.list',
            input: { serverId: input.serverId, machineId }, context, ...(context.signal ? { signal: context.signal } : {}) });
        const access = MachineAccessGrantsListResultV1Schema.parse(response);
        if ('kind' in access) return refuse(access.code);
        if (!access.canManage) return refuse('access_denied');
        return { machineId, roles: [...roles], withdrawDirectGrant: access.ownDirectGrant && access.custodian.accountId !== account.accountId };
    }));
    const tokenInventory = headers.length ? await ports.readApiTokens(headers.map(header => header.id), context) : [];
    if ('errorCode' in tokenInventory) throw new ProjectSourceTeamMoveReadFailure(tokenInventory);
    const tokens = tokenInventory;
    const triggerSets: WorkflowTriggerSetV1[] = [];
    if (headers.length) {
        const triggerResponse = await ports.workflowAction({ actionId: 'workflow.trigger.list', input: { scope: 'account_all' }, context, ...(context.signal ? { signal: context.signal } : {}) });
        if ('errorCode' in triggerResponse) refuse(triggerResponse.errorCode);
        triggerSets.push(...WorkflowTriggerListResultV1Schema.parse(triggerResponse).sets);
    }
    if (triggerSets.some(set => set.health !== 'available')) refuse('source_unavailable');
    const environmentIds = new Set(headers.map(header => header.id));
    const triggers = triggerSets.flatMap(set => (set.context?.actionApprovals ?? []).filter(approval => approval.operation.steps.some(step => {
        const operand = step.actionId === 'action.invoke' && typeof step.input.input === 'object' && step.input.input !== null
            && !isArray(step.input.input) ? step.input.input : step.input;
        return typeof operand.environmentId === 'string' && environmentIds.has(operand.environmentId)
            && typeof operand.serverId === 'string' && ports.isSameHome(operand.serverId, input.serverId);
    })).map(approval => ({ automationId: set.automationId, triggerId: approval.triggerId, revision: set.revision,
        approvedByAccountId: approval.operation.approvedBy.accountId, steps: approval.operation.steps })));
    await account.assertCurrent(context);
    context.signal?.throwIfAborted();
    return { input, source, environments: details, artifacts, machines: machineAccess, usedSecrets: [...usedSecrets.values()],
        ciTokens: tokens, triggers, defaults: defaults };
}
export type ProjectSourceTeamMoveInventory = Awaited<ReturnType<typeof readProjectSourceTeamMoveInventoryV1>>;
export function projectSourceTeamMoveInputKey(input: ProjectSourcesMoveToTeamInputV1): string {
    return JSON.stringify([input.serverId, input.sourceId, input.expectedRevision, input.teamId, input.requestKey]);
}

/** Every host prepares the same Source-scoped review before the Action asks a person. */
type ProjectSourceTeamMovePreparationV1 = Required<Pick<ActionExecutorDeps, 'prepareHostReviewedChildren'>> & Readonly<{
    prepare(raw: unknown, context: ActionExecutorContext): Promise<ProjectSourceTeamMoveInventory>;
    prepareFailure(error: unknown): ActionExecuteFailure;
    buildApprovalPreview(raw: unknown, context: ActionExecutorContext, defaultPreview: unknown): Promise<unknown>;
}>;
export function createProjectSourceTeamMovePreparationV1(account: ProjectSourceTeamMoveAccountV1, ports: ProjectSourceTeamMoveReadPortsV1): ProjectSourceTeamMovePreparationV1 {
    let preparation: Readonly<{ key: string; value: Promise<ProjectSourceTeamMoveInventory> }> | undefined;
    const prepare = (raw: unknown, context: ActionExecutorContext) => {
        const input = ProjectSourcesMoveToTeamInputV1Schema.parse(raw);
        const key = projectSourceTeamMoveInputKey(input);
        if (preparation && preparation.key !== key) throw new ProjectSourceTeamMoveReadFailure(moveFailure('plan_changed'));
        preparation ??= { key, value: readProjectSourceTeamMoveInventoryV1(account, input, context, ports) };
        return preparation.value;
    };
    const prepareFailure = (error: unknown): ActionExecuteFailure => {
        if (error instanceof ProjectSourceTeamMoveReadFailure) return 'errorCode' in error.result ? error.result : moveFailure(error.result.error);
        if (account.invocationSignal?.aborted) return moveFailure('cancelled');
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') return moveFailure(error.code);
        return moveFailure('home_unreachable');
    };
    const role = (kind: string, id: string) => `${kind}:${id}`;
    const teamPrincipal = (teamId: string) => ({ kind: 'team' as const, teamId });
    const childPlan = (inventory: ProjectSourceTeamMoveInventory): HostReviewedChildrenPlanV1 => {
        const { input } = inventory;
        const children: HostReviewedChildrenPlanV1['children'][number][] = [];
        for (const machine of inventory.machines) {
            children.push({ action: 'machines.access.grant.set', role: role('machine', machine.machineId),
                input: { serverId: input.serverId, machineId: machine.machineId, principal: teamPrincipal(input.teamId), level: 'admin' } });
            if (machine.withdrawDirectGrant) children.push({ action: 'machines.access.grant.remove', role: role('withdraw-machine', machine.machineId),
                input: { serverId: input.serverId, machineId: machine.machineId, principal: { kind: 'account', accountId: account.accountId } } });
        }
        inventory.usedSecrets.forEach((_secret, index) => children.push({ action: 'secrets.shared.create', role: role('secret', String(index)) }));
        for (const artifactId of inventory.artifacts) children.push({ action: 'artifact.access.grants.set', role: role('artifact', artifactId),
            input: { artifactId, principal: teamPrincipal(input.teamId), accessLevel: 'admin' } });
        for (const detail of inventory.environments) if (detail.environment.deletedAtMs === undefined
            && detail.content.bindings.some(binding => binding.source.kind === 'secret')) {
            children.push({ action: 'deployments.bindings.set', role: role('bindings', detail.environment.id),
                scopeInput: { serverId: input.serverId, environmentId: detail.environment.id } },
                { action: 'artifact.access.grants.set', role: role('binding-artifact', detail.environment.id) });
        }
        children.push({ action: 'projects.sources.update', role: 'source-owner', input: {
            serverId: input.serverId, sourceId: input.sourceId, expectedRevision: input.expectedRevision, patch: { owner: teamPrincipal(input.teamId) },
        } });
        for (const token of inventory.ciTokens) children.push({ action: 'account.apiTokens.update', role: role('token', token.tokenId),
            input: { tokenId: token.tokenId, authorizeUnattendedTeamAccess: true } });
        for (const trigger of inventory.triggers) children.push({ action: 'workflow.trigger.update', role: role('trigger', `${trigger.automationId}/${trigger.triggerId}`) });
        // A new grant response identifies only this actor's removable explicit grant.
        // Intrinsic Artifact/Machine custody and unrelated audiences are never withdrawn.
        for (const artifactId of inventory.artifacts) children.push({ action: 'artifact.access.grants.remove', role: role('withdraw-artifact', artifactId),
            input: { artifactId, principal: { kind: 'account', accountId: account.accountId } } });
        if (inventory.source.audience.some(grant => grant.principal.kind === 'account' && grant.principal.accountId === account.accountId)) {
            children.push({ action: 'projects.sources.update', role: 'withdraw-source-audience' });
        }
        return { children };
    };
    return { prepare, prepareFailure,
        prepareHostReviewedChildren: async request => {
            if (request.actionId !== PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1) return null;
            try { return childPlan(await prepare(request.input, request.context)); }
            catch (error) { return prepareFailure(error); }
        },
        buildApprovalPreview: async (raw, context, defaultPreview) => {
            try {
                const inventory = await prepare(raw, context);
                return { ...(defaultPreview && typeof defaultPreview === 'object' ? defaultPreview : {}), moveToTeam: {
                    teamId: inventory.input.teamId, source: inventory.source,
                    environments: inventory.environments.map(({ environment, targetLinks, receipts }) => ({
                        environmentId: environment.id, revision: environment.revision, purpose: environment.purpose,
                        ...(environment.deletedAtMs === undefined ? {} : { deletedAtMs: environment.deletedAtMs }),
                        ...(environment.previewTemplateEnvironmentId ? { previewTemplateEnvironmentId: environment.previewTemplateEnvironmentId } : {}),
                        targetLinkIds: targetLinks.map(link => link.id), receiptIds: receipts.map(receipt => receipt.id),
                    })), machines: inventory.machines.map(({ machineId, roles }) => ({ machineId, roles })),
                    withdrawal: { accountId: account.accountId, artifactIds: inventory.artifacts,
                        removableMachineIds: inventory.machines.filter(machine => machine.withdrawDirectGrant).map(machine => machine.machineId) },
                    usedSecrets: inventory.usedSecrets, artifactIds: inventory.artifacts,
                    ciTokens: inventory.ciTokens.map(({ tokenId, label, hasUnattendedTeamAccess, activeChildCount, parentTokenId }) =>
                        ({ tokenId, label, hasUnattendedTeamAccess, activeChildCount, parentTokenId })),
                    triggers: inventory.triggers.map(({ automationId, triggerId, revision, approvedByAccountId }) =>
                        ({ automationId, triggerId, revision, approvedByAccountId })),
                    previews: inventory.environments.filter(detail => detail.environment.purpose === 'preview').map(({ environment }) => ({
                        environmentId: environment.id, previewTemplateEnvironmentId: environment.previewTemplateEnvironmentId,
                        previewTargetLinkId: environment.previewTargetLinkId,
                    })),
                } };
            } catch (error) { return prepareFailure(error); }
        }
    };
}
