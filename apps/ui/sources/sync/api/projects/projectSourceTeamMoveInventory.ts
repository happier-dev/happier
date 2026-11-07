import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectSourcesMoveToTeamInputV1Schema, type ProjectSourcesFailureV1,
    type ProjectSourcesMoveToTeamInputV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema,
    DeploymentReceiptListResultV1Schema, deploymentInProgressStates,
    type DeploymentEnvironmentHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ProjectDeploymentDefaultsOutputV1Schema } from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';
import { WorkflowTriggerListResultV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { MachineAccessGrantsListResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { readDeploymentEnvironmentArtifactV1 } from '@happier-dev/deployment-protocol/v1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { createProjectSourceActionDeps } from './projectSourceActions';
import { readProjectSourceTeamApiTokens } from './projectSourceTeamAuthority';

export type ProjectSourceTeamMoveReadPorts = Required<Pick<ActionExecutorDeps,
    'deploymentAction' | 'workflowAction' | 'machineAccessAction'>>;
export const moveFailure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
export class ProjectSourceTeamMoveReadFailure extends Error {
    constructor(readonly result: ActionExecuteFailure | ProjectSourcesFailureV1) { super('project_source_move_read_failed'); }
}

type MachineRole = 'runtime' | 'build' | 'controller' | 'edge' | 'data' | 'backup' | 'cleanup';
const refuse: (code: string) => never = (code) => { throw new ProjectSourceTeamMoveReadFailure(moveFailure(code)); };
const isArray: (value: unknown) => value is readonly unknown[] = Array.isArray;

/** One demanded, Source-scoped inventory for this Action invocation and its review. */
export async function readProjectSourceTeamMoveInventory(account: LazyActionAccountContext, raw: unknown,
    context: ActionExecutorContext, ports: ProjectSourceTeamMoveReadPorts) {
    const input = ProjectSourcesMoveToTeamInputV1Schema.parse(raw);
    account.assertCurrent();
    context.signal?.throwIfAborted();
    if (account.credentialAuthorityKind !== 'account') refuse('action_forbidden');
    const read = await createProjectSourceActionDeps(account).projectSourcesRead({ serverId: input.serverId, sourceId: input.sourceId }, context);
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
        if ('errorCode' in response) throw new ProjectSourceTeamMoveReadFailure(response);
        const page = DeploymentEnvironmentListResultV1Schema.parse(response);
        if (!page.ok) refuse(page.error);
        if (page.coverage === 'partial') refuse('deployment_content_unavailable');
        headers.push(...page.items);
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const environments = await Promise.all(headers.map(async header => {
        const response = await ports.deploymentAction('deployments.environments.get', { serverId: input.serverId,
            environmentId: header.id, includeRetainedTargetLinkCleanup: true }, context);
        if ('errorCode' in response) throw new ProjectSourceTeamMoveReadFailure(response);
        const detail = DeploymentEnvironmentGetResultV1Schema.parse(response);
        if (!detail.ok) return refuse(detail.error);
        if (!detail.retainedTargetLinkCleanupCompleteIds) return refuse('deployment_content_unavailable');
        if (detail.environment.id !== header.id || detail.environment.projectSourceId !== source.id
            || !areServerProfileIdentifiersEquivalent(detail.environment.serverId, input.serverId)) return refuse('deployment_invalid');
        const receipts = [];
        let receiptCursor: string | undefined;
        do {
            const response = await ports.deploymentAction('deployments.receipts.list', { serverId: input.serverId,
                environmentId: header.id, ...(receiptCursor ? { cursor: receiptCursor } : {}) }, context);
            if ('errorCode' in response) throw new ProjectSourceTeamMoveReadFailure(response);
            const page = DeploymentReceiptListResultV1Schema.parse(response);
            if (!page.ok) return refuse(page.error);
            if (page.items.some(receipt => receipt.environmentId !== header.id)) return refuse('deployment_invalid');
            receipts.push(...page.items);
            receiptCursor = page.nextCursor ?? undefined;
        } while (receiptCursor);
        return { ...detail, retainedTargetLinkCleanupCompleteIds: detail.retainedTargetLinkCleanupCompleteIds, receipts };
    }));
    const defaults = await requestHomeDomain({ scope: account.accountLifetime.scope,
        path: `/v1/projects/${encodeURIComponent(source.id)}/deployment-defaults?serverId=${encodeURIComponent(account.serverIdentityId ?? input.serverId)}`,
        method: 'GET', input: undefined, schema: ProjectDeploymentDefaultsOutputV1Schema, effect: 'read', signal: context.signal, requestAuthority: account });
    if (!defaults.ok) refuse(homeDomainFailureCode(defaults.failure));
    if (!defaults.value.ok) refuse(defaults.value.error);
    if (defaults.value.sourceRevision !== source.revision || defaults.value.projectSourceId !== source.id) refuse('source_conflict');
    const artifacts = [...new Set(environments.flatMap(detail => [detail.environment.contentArtifactId,
        ...detail.targetLinks.map(link => link.contentArtifactId), ...detail.receipts.map(receipt => receipt.contentArtifactId)])
        .concat(defaults.value.content ? [defaults.value.content.contentArtifactId] : []))];
    // Only Environment bodies supply Move operands. The existing sharing writer
    // opens every other Artifact when it prepares that grant's recipients.
    const environmentArtifactIds = [...new Set(environments.map(detail => detail.environment.contentArtifactId))];
    const documents = await account.readArtifactContents(environmentArtifactIds, { signal: context.signal });
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
            input: { serverId: input.serverId, machineId }, context, signal: context.signal });
        const access = MachineAccessGrantsListResultV1Schema.parse(response);
        if ('kind' in access) return refuse(access.code);
        if (!access.canManage) return refuse('access_denied');
        return { machineId, roles: [...roles], withdrawDirectGrant: access.ownDirectGrant && access.custodian.accountId !== account.accountId };
    }));
    const tokens = await readProjectSourceTeamApiTokens({ account, environmentIds: headers.map(header => header.id), context });
    if ('errorCode' in tokens) throw new ProjectSourceTeamMoveReadFailure(tokens);
    const triggerSets: WorkflowTriggerSetV1[] = [];
    if (headers.length) {
        const triggerResponse = await ports.workflowAction({ actionId: 'workflow.trigger.list', input: { scope: 'account_all' }, context, signal: context.signal });
        if ('errorCode' in triggerResponse) refuse(triggerResponse.errorCode);
        triggerSets.push(...WorkflowTriggerListResultV1Schema.parse(triggerResponse).sets);
    }
    if (triggerSets.some(set => set.health !== 'available')) refuse('source_unavailable');
    const environmentIds = new Set(headers.map(header => header.id));
    const triggers = triggerSets.flatMap(set => (set.context?.actionApprovals ?? []).filter(approval => approval.operation.steps.some(step => {
        const operand = step.actionId === 'action.invoke' && typeof step.input.input === 'object' && step.input.input !== null
            && !isArray(step.input.input) ? step.input.input : step.input;
        return typeof operand.environmentId === 'string' && environmentIds.has(operand.environmentId)
            && typeof operand.serverId === 'string' && areServerProfileIdentifiersEquivalent(operand.serverId, input.serverId);
    })).map(approval => ({ automationId: set.automationId, triggerId: approval.triggerId, revision: set.revision,
        approvedByAccountId: approval.operation.approvedBy.accountId, steps: approval.operation.steps })));
    account.assertCurrent();
    context.signal?.throwIfAborted();
    return { input, source, environments: details, artifacts, machines: machineAccess, usedSecrets: [...usedSecrets.values()],
        ciTokens: tokens.tokens, triggers, defaults: defaults.value };
}
export type ProjectSourceTeamMoveInventory = Awaited<ReturnType<typeof readProjectSourceTeamMoveInventory>>;
export function projectSourceTeamMoveInputKey(input: ProjectSourcesMoveToTeamInputV1): string {
    return JSON.stringify([input.serverId, input.sourceId, input.expectedRevision, input.teamId, input.requestKey]);
}
