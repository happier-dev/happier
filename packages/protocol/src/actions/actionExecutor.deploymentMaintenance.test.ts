import { expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { deriveActionChildRequestIdV1 } from '../workflows/workflowInvocationIdentityV1.js';
import type { ActionExecuteResult } from './actionExecutionResult.js';

it('settles two native Domains independently and never retries a CAS refusal', async () => {
  const owner = 'requester';
  const environmentId = 'production';
  const serverId = 'home';
  const content = { contentArtifactId: 'environment-body', contentHeaderVersion: 1, contentBodyVersion: 1 };
  const environment = { v: 1 as const, id: environmentId, serverId, projectSourceId: 'app', revision: 7,
    owner: { kind: 'account' as const, accountId: owner }, protection: 'nonProduction' as const, purpose: 'standard' as const,
    deployerMode: 'managers' as const, dataEditorMode: 'off' as const, dataAgentAccess: 'read' as const,
    controllerMachineId: 'machine', runtimeTargetLinkId: 'target', ...content,
    createdByAccountId: owner, createdAtMs: 1, updatedAtMs: 1,
    capabilities: { editData: false, role: 'manager' as const, read: true, deploy: true, manage: true, manageBindings: true,
      manageTargets: true, delete: true } };
  const link = { v: 1 as const, id: 'target', environmentId, revision: 4, role: 'runtime' as const, state: 'deployed' as const,
    source: { kind: 'host' as const, id: 'own-server' }, targetKind: 'ownServer', machines: ['machine'],
    members: [{ machineId: 'machine', installationId: 'installation', state: 'active' as const }], ...content,
    createdByAccountId: owner, createdAtMs: 1, updatedAtMs: 1 };
  const domains = ['a', 'b', 'provider'].map(id => ({ v: 1 as const, id, environmentId,
    targetLinkId: link.id, revision: 2, state: 'active' as const, ...content, contentArtifactId: id + '-body',
    ...(id === 'provider' ? { provider: true as const } : {}), createdByAccountId: owner, createdAtMs: 1, updatedAtMs: 1 }));
  const writes: unknown[] = [];
  const childRequestIds: (string | undefined)[] = [];
  const storage: NonNullable<ActionExecutorDeps['deploymentAction']> = async actionId => {
    if (actionId === 'deployments.environments.get') return { ok: true, environment, targetLinks: [link] };
    if (actionId === 'deployments.domains.list') return { ok: true, environmentId, revision: 7, domains, nextCursor: null };
    throw new Error('Unexpected Home request: ' + actionId);
  };
  const executor = createActionExecutor({ deploymentAction: storage,
    resolveEnvironmentApprovalScope: async () => ({ scope: 'environment', subjects: [{ kind: 'environment', serverId, environmentId }] }) });
  const result = await executor.execute('deployments.environments.maintenance.set', { serverId, environmentId, enabled: true }, {
    serverId, runtimeAccountId: owner, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    actionRequestId: 'turn-on-page',
    async executeOrdinaryChildAction(actionId, input, options): Promise<ActionExecuteResult> {
      expect(actionId).toBe('deployments.domains.add');
      writes.push(input);
      childRequestIds.push(options?.actionRequestId);
      return writes.length === 1 ? { ok: true, result: { ok: true, environmentId, revision: 8, domain: domains[0]! } }
        : { ok: false, errorCode: 'deployment_conflict', error: 'Conflict' };
    },
  });
  expect(result).toMatchObject({ ok: true, result: { ok: true, outcomes: [
    { domainId: 'a', ok: true }, { domainId: 'b', ok: false, errorCode: 'deployment_conflict' },
  ] } });
  const requestKeys = [0, 1].map(position => deriveActionChildRequestIdV1({ parentRequestId: 'turn-on-page',
    parentActionId: 'deployments.environments.maintenance.set', childActionId: 'deployments.domains.add', position }));
  expect(childRequestIds).toEqual(requestKeys);
  expect(writes).toEqual([
    expect.objectContaining({ domainId: 'a', requestKey: requestKeys[0], expectedRevision: 7, expectedDomainRevision: 2,
      expectedTargetLinkRevision: 4, contentArtifactId: 'a-body', maintenancePage: true }),
    expect.objectContaining({ domainId: 'b', requestKey: requestKeys[1], expectedRevision: 8, expectedDomainRevision: 2,
      expectedTargetLinkRevision: 4, contentArtifactId: 'b-body', maintenancePage: true }),
  ]);
});

it('refuses maintenance without a parent request id before reading the Environment', async () => {
  const executor = createActionExecutor({
    deploymentAction: async () => { throw new Error('Unexpected Home read without a request id'); },
    resolveEnvironmentApprovalScope: async () => ({ scope: 'environment',
      subjects: [{ kind: 'environment', serverId: 'home', environmentId: 'production' }] }),
  });
  expect(await executor.execute('deployments.environments.maintenance.set',
    { serverId: 'home', environmentId: 'production', enabled: false },
    { serverId: 'home', runtimeAccountId: 'requester', surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' } })).toMatchObject({ ok: false, errorCode: 'invalid_action_input' });
});
