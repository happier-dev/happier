import { describe, expect, it } from 'vitest';
import * as issuer from './deploymentRoleChild.js';
import type { ActionExecutorContext } from './types.js';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentPreparationAdmissionV1 } from '../externalActionApi.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { SESSION_AGENT_READINESS_CHILDREN_V1, readSessionAgentReadinessChildActionV1 } from '../../machines/managed/actionIdsV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../../auth/apiTokenGrant.js';
import { readOriginalActionEnvelopeMachineRpcKindV1 } from '../../rpc/socket.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { createActionExecutor } from '../actionExecutor.js';
import { ActionsSettingsV1Schema } from '../actionSettings.js';

describe('ordinary reviewed child admission transport', () => {
  it.each(['before reentry', 'during execution'] as const)('keeps exact reviewed HTTP effects on the admitted operation lifetime after caller cancellation %s', async cancellationPhase => {
    const caller = new AbortController();
    const operation = new AbortController();
    const parent = { actionId: 'deployments.templates.instantiate', input: {
      mode: 'apply', serverId: 'home', machineId: 'machine', projectSourceId: 'source',
      templateRef: { sourceId: 'builtin:apps', itemId: 'app', version: '1',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      environment: { kind: 'create', name: 'App', requestKey: 'create-app', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine' },
      target: { kind: 'new', installationId: 'installation' }, destination: { kind: 'stored' }, bindings: [],
      deploy: { requestKey: 'deploy-app' },
    } };
    const child = { action: 'deployments.deploy' as const, role: 'deploy', input: {
      serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-app',
      targetLinkId: 'link', expectedTargetLinkRevision: 4,
      contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1,
    } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
      serverIdentityId: 'home', accountId: 'member', custodianAccountId: 'member',
      authentication: { kind: 'account', tokenEpoch: 1 }, machineId: 'machine', installationId: 'installation',
      actionId: parent.actionId, requestId: 'request', requestEnvelopeDigest: 'A'.repeat(43),
      deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(parent.actionId, parent.input),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    const ingressRequests: unknown[] = [];
    const ownedRequests: unknown[] = [];
    const makeHttp = (signal: AbortSignal, requests: unknown[]) => ({
      accountId: 'member', serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
      isCurrent: async () => !signal.aborted,
      createRequestHeaders: async (request: unknown) => {
        if (signal.aborted) return null;
        requests.push(request);
        return { Authorization: 'fixture' };
      },
    });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: makeHttp(caller.signal, ingressRequests) });
    const request = { effectActionId: child.action, method: 'POST', path: '/v1/deployments/environments/environment/transition' };
    const expectedProof = { actionId: child.action, role: child.role, input: child.input,
      inputDigest: computeActionInputApprovalDigestV1(child.action, child.input) };
    let entered = false;
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input: child.input, preview: {} }),
      // The host operation and native effect are process boundaries; the real
      // executor reentry, private issuer and HTTP child projection stay intact.
      runActionOperation: async admitted => {
        const retained = { ...authorization };
        Object.defineProperty(retained, 'requesterHttpProjection', { value: makeHttp(operation.signal, ownedRequests) });
        if (cancellationPhase === 'before reentry') caller.abort();
        return admitted.execute({ ...admitted.context, signal: operation.signal,
          externalActionExecutionAuthorization: retained,
          operationAcceptance: { operationId: 'owned-child', actionId: admitted.actionId, accept() {} } });
      },
      deploymentAction: async (_actionId, _input, context) => {
        entered = true;
        expect(context.signal).toBe(operation.signal);
        caller.abort();
        expect(issuer.readHostAdmittedReviewedRootV1(context)).toEqual(parent);
        expect(issuer.readHostAdmittedReviewedChildV1(context)).toEqual(expectedProof);
        const http = context.externalActionExecutionAuthorization?.requesterHttpProjection;
        expect(await http?.createRequestHeaders(request)).toEqual({ Authorization: 'fixture' });
        expect(ownedRequests).toEqual([{ ...request, reviewedChild: {
          actionId: child.action, role: child.role, inputDigest: expectedProof.inputDigest,
        } }]);
        expect(ingressRequests).toEqual([]);
        operation.abort();
        expect(issuer.readHostAdmittedReviewedChildV1(context)).toBeNull();
        expect(await http?.createRequestHeaders(request)).toBeNull();
        return { ok: true, environmentId: 'environment', revision: 4, kind: 'pending', actionOperationId: 'owned-child' };
      },
    });
    const rootContext: ActionExecutorContext = { surface: 'cli', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'member', signal: caller.signal,
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'deployments.deploy': ['cli'] } }) };
    const port = issuer.createHostReviewedChildPortV1({ actionId: parent.actionId, input: parent.input,
      context: rootContext, plan: { children: [child] }, reviewAdmitted: true,
      policies: [{ action: child.action, role: child.role, surface: 'cli' }],
      execute: (input, context, actionId) => executor.execute(actionId, input, context) });
    const result = await port.invoke(child);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, kind: 'pending', actionOperationId: 'owned-child' } });
    expect(entered).toBe(true);
    expect(await port.invoke(child)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });

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
        expect(retain(childContext, child.action, { ...input, agentId: 'claude' }, input)).toBeUndefined();
        expect(retain(context, child.action, input)).toBeUndefined();
        expect(retain({ ...childContext, externalActionExecutionAuthorization: {
          ...authorization, binding: { ...authorization.binding, actionId: 'machines.agents.list' },
        } }, child.action, input)).toBeUndefined();
        expect(issuer.readHostAdmittedReviewedChildV1(childContext)).toBeNull();
        return { ok: true, result: null };
      } });
  });
});
