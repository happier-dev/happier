import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';
import type { ActionExecutorContext } from './executor/types.js';
import { invokeHostReviewedChildV1 } from './executor/deploymentRoleChild.js';
import * as reviewedChildIssuer from './executor/deploymentRoleChild.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import type { ActionId } from './actionIds.js';


const child = { action: { pluginId: 'acme.fixture', localId: 'inspect' }, role: 'inspect',
  input: { machineId: 'machine', config: { network: 'reviewed' } } };
const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user',
  actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner',
  actionRequestId: 'parent-request', externalActionTarget: { kind: 'machine', machineId: 'machine' },
  actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) };

describe('generic reviewed host children', () => {
  it('projects the admitted native parent even when its trusted internal children are not predeclared', async () => {
    const input = { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' };
    let port: ActionExecutorContext['hostReviewedChild'];
    const executor = createActionExecutor({ machineReboot: async ({ context }) => {
      port = context.hostReviewedChild;
      return { kind: 'unavailable', reason: 'needs_attendance' };
    } });
    expect(await executor.execute('machines.reboot', input, {
      ...context, surface: 'ui', actionRequestId: 'native-parent',
      presentUserConfirmation: { actionId: 'machines.reboot', accountId: 'owner', serverId: 'home',
        requestId: 'native-parent', target: context.externalActionTarget,
        inputDigest: computeActionInputApprovalDigestV1('machines.reboot', input) },
    })).toMatchObject({ ok: true });
    expect(port).toMatchObject({ parent: { actionId: 'machines.reboot', input } });
  });

  it('projects only admitted live children onto the root HTTP port and keeps private root facets', async () => {
    const root = { actionId: 'machines.reboot', input: { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-token', binding: {
      serverIdentityId: 'home-identity', accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', actionId: root.actionId, requestId: 'root-request',
      requestEnvelopeDigest: 'A'.repeat(43), target: context.externalActionTarget,
      authentication: { kind: 'account', tokenEpoch: 1 },
    } });
    const networkRequests: unknown[] = [];
    const requesterHttpProjection = { accountId: 'owner', serverId: 'home', serverIdentityId: 'home-identity',
      serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
      createRequestHeaders: async (request: unknown) => { networkRequests.push(request); return {}; } };
    const requesterAccountExecutor = createActionExecutor({});
    Object.defineProperties(authorization, {
      requesterHttpProjection: { value: requesterHttpProjection, enumerable: false },
      requesterAccountExecutor: { value: requesterAccountExecutor, enumerable: false },
    });
    const abort = new AbortController();
    const rootContext = { ...context, signal: abort.signal, externalActionExecutionAuthorization: authorization };
    const request = { effectActionId: 'deployments.environment.get', method: 'GET', path: '/v1/deployments/environments/new' };
    let expectsAdmittedProof = false;
    const execute = async (_input: unknown, childContext: ActionExecutorContext) => {
      // Read through the module so the RED names the missing capability without
      // introducing an unloadable named import into the shared package graph.
      const readProof = Reflect.get(reviewedChildIssuer, 'readHostAdmittedReviewedChildV1');
      const expectedProof = expectsAdmittedProof ? { actionId: 'acme.fixture/actions/inspect',
        role: child.role, input: child.input,
        inputDigest: computeActionInputApprovalDigestV1('acme.fixture/actions/inspect' as ActionId, child.input) } : null;
      expect(typeof readProof === 'function' ? readProof(childContext) : null).toEqual(expectedProof);
      if (typeof readProof === 'function') {
        expect(readProof({ ...childContext })).toEqual(expectedProof);
        expect(readProof(JSON.parse(JSON.stringify(childContext)))).toBeNull();
        expect(readProof(context)).toBeNull();
      }
      const carried = childContext.externalActionExecutionAuthorization!;
      expect(carried.token).toBe(authorization.token);
      expect(carried.binding).toBe(authorization.binding);
      expect(carried.requesterAccountExecutor).toBe(requesterAccountExecutor);
      expect(Object.getOwnPropertyDescriptor(carried, 'requesterAccountExecutor')?.enumerable).toBe(false);
      await carried.requesterHttpProjection!.createRequestHeaders(request);
      if (expectsAdmittedProof) {
        const parentRequest = { ...request, effectActionId: root.actionId };
        await carried.requesterHttpProjection!.createRequestHeaders(parentRequest);
        // Host admission reads keep the root purpose; the plugin child proof
        // describes the plugin's own calls, not the host's deployment reads.
        expect(networkRequests.pop()).toEqual(parentRequest);
      }
      return { ok: true as const, result: {} };
    };
    // A serialized role alone and an independently Home-bound child retain
    // their incumbent HTTP ceiling instead of borrowing the parent's.
    await invokeHostReviewedChildV1({ parent: root, context: rootContext, child, execute });
    expect(networkRequests.pop()).toEqual(request);
    const policy = { action: child.action, role: child.role, surface: 'cli' as const };
    await invokeHostReviewedChildV1({ parent: { ...root, actionId: 'another-root' }, context: rootContext,
      child, admittedReview: policy, execute });
    expect(networkRequests.pop()).toEqual(request);
    expectsAdmittedProof = true;
    await invokeHostReviewedChildV1({ parent: root, context: rootContext, child, admittedReview: policy, execute });
    expect(networkRequests.pop()).toEqual({ ...request, effectActionId: 'acme.fixture/actions/inspect',
      reviewedChild: { actionId: 'acme.fixture/actions/inspect', role: child.role,
        inputDigest: computeActionInputApprovalDigestV1('acme.fixture/actions/inspect' as ActionId, child.input) } });
    await invokeHostReviewedChildV1({ parent: root, context: rootContext, child, admittedReview: policy,
      execute: async (_input, childContext) => {
        abort.abort();
        const readProof = Reflect.get(reviewedChildIssuer, 'readHostAdmittedReviewedChildV1');
        expect(typeof readProof === 'function' ? readProof(childContext) : null).toBeNull();
        expect(await childContext.externalActionExecutionAuthorization!.requesterHttpProjection!.createRequestHeaders(request)).toBeNull();
        return { ok: true as const, result: {} };
      } });
    expect(networkRequests).toEqual([]);
    expect(authorization.requesterHttpProjection).toBe(requesterHttpProjection);
  });
});
