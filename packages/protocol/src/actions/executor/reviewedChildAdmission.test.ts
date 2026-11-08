import { describe, expect, it } from 'vitest';
import * as issuer from './deploymentRoleChild.js';
import type { ActionExecutorContext } from './types.js';
import { ExternalActionExecutionAuthorizationV1Schema } from '../externalActionApi.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { SESSION_AGENT_READINESS_CHILDREN_V1, readSessionAgentReadinessChildActionV1 } from '../../machines/managed/actionIdsV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../../auth/apiTokenGrant.js';
import { readOriginalActionEnvelopeMachineRpcKindV1 } from '../../rpc/socket.js';
import { RPC_METHODS } from '../../rpc/methods.js';

describe('ordinary reviewed child admission transport', () => {
  it.each(['template.instantiate', 'deployments.prepare', 'discussion.second_opinion.start'] as const)('retains the admitted %s root while its Session readiness leaf awaits ordinary admission', async rootActionId => {
    const requests: unknown[] = [];
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
      serverIdentityId: 'home', accountId: 'member', principalId: 'member', credentialId: 'credential',
      grant: API_TOKEN_FULL_GRANT_V1, custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation',
      actionId: rootActionId, requestId: 'request', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' }, admittedMachineRole: 'use',
      ...(rootActionId === 'deployments.prepare' ? { deploymentPreparationAdmission: {
        operation: 'prepare', source: { id: 'source', revision: 1 }, workspace: { kind: 'workspace-ref', id: 'workspace' },
      } } : {}),
    } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: {
      createRequestHeaders: async (request: unknown) => { requests.push(request); return { Authorization: 'fixture' }; },
    } });
    const context: ActionExecutorContext = { runtimeAccountId: 'member',
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target };
    const parent = { actionId: rootActionId, input: { machineId: 'machine' } };
    const spawnInput = { machineId: 'machine' };
    const inventory = SESSION_AGENT_READINESS_CHILDREN_V1.inventory;
    const inventoryInput = { machineId: 'machine', agentId: 'codex' };
    await issuer.invokeHostReviewedChildV1({ context, parent,
      child: { action: 'session.spawn_new', role: 'create-session', input: spawnInput },
      admittedReview: { action: 'session.spawn_new', role: 'create-session', surface: 'cli' },
      execute: async (_input, spawnContext) => issuer.invokeHostReviewedChildV1({ context: spawnContext,
        parent: { actionId: 'session.spawn_new', input: spawnInput }, child: { ...inventory, input: inventoryInput },
        execute: async (_input, inventoryContext) => {
          expect(issuer.readHostAdmittedReviewedRootV1(inventoryContext)).toEqual(parent);
          expect(issuer.readHostAdmittedReviewedChildV1(inventoryContext)).toBeNull();
          const admitted = issuer.retainHostReviewedChildAdmissionV1(inventoryContext, inventory.action, inventoryInput);
          expect(issuer.readHostAdmittedReviewedChildV1(admitted)).toEqual({ actionId: inventory.action,
            role: inventory.role, input: inventoryInput,
            inputDigest: computeActionInputApprovalDigestV1(inventory.action, inventoryInput) });
          expect(issuer.readHostAdmittedReviewedRootV1(admitted)).toEqual(parent);
          const leaf = issuer.readHostAdmittedReviewedChildV1(admitted) ?? undefined;
          expect(readSessionAgentReadinessChildActionV1(authorization.binding, leaf)).toBe(inventory.action);
          expect(readOriginalActionEnvelopeMachineRpcKindV1({ machineId: 'machine',
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            envelope: { v: 1, requestId: 'request', target: authorization.binding.target, input: parent.input },
            execution: { v: 1, authorization, effectActionId: inventory.action,
              target: authorization.binding.target, installationId: 'installation', machineSignature: 'fixture', reviewedChild: leaf },
            params: { machineId: 'machine', selection: 'agents' },
          })).toBe('child');
          expect(readSessionAgentReadinessChildActionV1({ ...authorization.binding, actionId: 'template.updates.apply' }, leaf)).toBeNull();
          expect(readSessionAgentReadinessChildActionV1(authorization.binding, leaf,
            { machineId: 'different', installationId: 'installation' })).toBeNull();
          const projection = admitted?.externalActionExecutionAuthorization?.requesterHttpProjection;
          expect(projection).toBeDefined();
          await projection?.createRequestHeaders({ effectActionId: inventory.action, method: 'GET', path: '/v1/machines/machine' });
          expect(requests).toEqual([{ effectActionId: inventory.action, method: 'GET', path: '/v1/machines/machine',
            reviewedChild: { actionId: inventory.action, role: inventory.role,
              inputDigest: computeActionInputApprovalDigestV1(inventory.action, inventoryInput) } }]);
          expect(issuer.readHostAdmittedReviewedRootV1({ ...inventoryContext,
            externalActionExecutionAuthorization: { ...authorization, binding: { ...authorization.binding, actionId: 'machines.agents.list' } },
          })).toBeNull();
          expect(issuer.retainHostReviewedChildAdmissionV1(inventoryContext, inventory.action,
            { ...inventoryInput, machineId: 'different' })).toBeUndefined();
          expect(issuer.readHostAdmittedReviewedChildV1(inventoryContext)).toBeNull();
          return { ok: true, result: null };
        } }).then(async result => {
          const reboundRequests: unknown[] = [];
          const reboundAuthorization = { ...authorization, token: 'independently-bound-root' };
          Object.defineProperty(reboundAuthorization, 'requesterHttpProjection', { value: {
            createRequestHeaders: async (request: unknown) => { reboundRequests.push(request); return { Authorization: 'rebound' }; },
          } });
          await issuer.invokeHostReviewedChildV1({ context: { ...spawnContext,
            externalActionExecutionAuthorization: reboundAuthorization },
            parent: { actionId: 'session.spawn_new', input: spawnInput }, child: { ...inventory, input: inventoryInput },
            execute: async (_input, pendingContext) => {
              const admitted = issuer.retainHostReviewedChildAdmissionV1(pendingContext, inventory.action, inventoryInput);
              await admitted?.externalActionExecutionAuthorization?.requesterHttpProjection?.createRequestHeaders({
                effectActionId: inventory.action, method: 'GET', path: '/v1/machines/machine',
              });
              expect(reboundRequests).toHaveLength(1);
              expect(requests).toHaveLength(1);
              return { ok: true, result: null };
            } });
          return result;
        }),
    });
  });

  it('retains the exact accepted operand without admitting a serialized or different child', async () => {
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
      serverIdentityId: 'home', accountId: 'member', principalId: 'member', credentialId: 'credential',
      grant: API_TOKEN_FULL_GRANT_V1, custodianAccountId: 'owner',
      machineId: 'machine', installationId: 'installation', actionId: 'session.spawn_new',
      requestId: 'request', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' }, admittedMachineRole: 'use',
    } });
    const context: ActionExecutorContext = { runtimeAccountId: 'member',
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target };
    const child = SESSION_AGENT_READINESS_CHILDREN_V1.acquire;
    const input = { machineId: 'machine', agentId: 'codex', intent: 'install' };
    await issuer.invokeHostReviewedChildV1({ context,
      parent: { actionId: 'session.spawn_new', input: { machineId: 'machine' } },
      child: { ...child, input }, execute: async (_input, childContext) => {
        expect(issuer.readHostAdmittedReviewedChildV1(childContext)).toBeNull();
        const retain: unknown = Reflect.get(issuer, 'retainHostReviewedChildAdmissionV1');
        if (typeof retain !== 'function') throw new Error('ordinary accepted child admission is not retained');
        const admitted: ActionExecutorContext | undefined = retain(childContext, child.action, input);
        expect(issuer.readHostAdmittedReviewedChildV1(admitted)).toEqual({ actionId: child.action,
          role: child.role, input, inputDigest: computeActionInputApprovalDigestV1(child.action, input) });
        expect(retain(childContext, child.action, { ...input, agentId: 'claude' })).toBeUndefined();
        expect(retain(context, child.action, input)).toBeUndefined();
        expect(retain({ ...childContext, externalActionExecutionAuthorization: {
          ...authorization, binding: { ...authorization.binding, actionId: 'machines.agents.list' },
        } }, child.action, input)).toBeUndefined();
        expect(issuer.readHostAdmittedReviewedChildV1(childContext)).toBeNull();
        return { ok: true, result: null };
      } });
  });
});
