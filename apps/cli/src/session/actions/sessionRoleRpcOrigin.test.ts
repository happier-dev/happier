import { describe, expect, it } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol';

import { hasReceivedWorkflowSessionRoleAuthority, resolveSessionRoleRpcOrigin } from './sessionRoleRpcOrigin';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';

const context: ActionExecutorContext = {
  authority: 'account_automation',
  actionCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 2, turnDepth: 3 },
  sessionInputSource: { sourceSessionId: 'caller-session', sourceTurnId: 'original-turn', sourceInputId: 'original-input' },
  actionRequestId: 'original-request', callerPermissionMode: 'default', workspaceWrites: 'deny',
};

function expectOriginUnavailable(input: ActionExecutorContext) {
  let failure: unknown;
  try { resolveSessionRoleRpcOrigin(input); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'role_rpc_origin_unavailable' });
  expect(readRpcErrorCode(failure)).toBe('role_rpc_origin_unavailable');
}

describe('Session role RPC origin', () => {
  it('consumes only the exact Home-admitted Run Session witness, without inventing source authority', () => {
    const proof = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'home', machineId: 'sender-machine', installationId: 'installed', actionId: 'session.notes.set',
      requestId: 'note', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'session', sessionId: 'target' },
      workflowActionOrigin: { runId: 'run', requestId: 'note', sessionAuthority: {
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, runDepth: 0,
        runOriginSessionId: 'target', directory: '/repo', workspaceWrites: 'allow',
      } },
    } });
    const received = buildActionExecutorContextForRpc({ callerAuthority: 'account_automation', callerInputAuthorization: proof });
    const accepts = (context: ActionExecutorContext, accountId = 'owner', sessionId = 'target') =>
      hasReceivedWorkflowSessionRoleAuthority({ context, accountId, sessionId });
    expect(accepts(received)).toBe(true);
    expect(accepts(received, 'foreign-owner')).toBe(false);
    expect(accepts(received, 'foreign-target')).toBe(false);
    expect(accepts({ ...received, externalActionExecutionAuthorization: undefined })).toBe(false);
    expect(accepts({ ...received, actionRequestId: 'other-request' })).toBe(false);
    expect(accepts({ ...received, actionCaller: { kind: 'workflowRun', runId: 'run',
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'yolo' } } })).toBe(false);
  });
  it('fails closed with the typed origin denial for truthy primitive provenance', () => {
    for (const source of ['untrusted-origin', 1, true]) {
      expectOriginUnavailable({ ...context, sessionInputSource: source });
    }
  });

  it('refuses absent provenance and a source from another Session', () => {
    for (const source of [undefined, null, {}, { sourceSessionId: 'foreign-session', sourceTurnId: 'original-turn' }]) {
      expectOriginUnavailable({ ...context, sessionInputSource: source });
    }
    expectOriginUnavailable({ ...context, actionCaller: { kind: 'host' } });
  });

  it('preserves the current strict origin facts and canonical permission aliases', () => {
    expect(resolveSessionRoleRpcOrigin({ ...context, callerPermissionMode: 'acceptEdits' })).toEqual({
      v: 1, caller: { kind: 'session', sessionId: 'caller-session', starterDepth: 2, turnDepth: 3 },
      callerPermissionMode: 'safe-yolo', causalPermissionAuthority: null,
      sourceTurnId: 'original-turn', sourceInputId: 'original-input', requestId: 'original-request', workspaceWrites: 'deny',
    });
    expect(resolveSessionRoleRpcOrigin({ ...context, callerPermissionMode: undefined }))
      .toMatchObject({ callerPermissionMode: null });
  });

  it('retains strict rejection of invalid caller, turn, request, permission and causal authority facts', () => {
    expectOriginUnavailable({ ...context, actionCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: -1, turnDepth: 3 } });
    expectOriginUnavailable({ ...context, sessionInputSource: { sourceSessionId: 'caller-session' } });
    expectOriginUnavailable({ ...context, actionRequestId: '' });
    expectOriginUnavailable({ ...context, callerPermissionMode: 'not-a-permission' });
    expectOriginUnavailable({ ...context, causalPermissionAuthority: { v: 1 } });
  });

  it.each([undefined, { actionRequestAttributionV1: { requester: { accountId: 'owner' } } }])(
    'keeps unknown Machine input unknown through Session RPC instead of borrowing the owner', async inputAuthority => {
      const cause = deriveSessionInputActionRequestAttributionV1({ requestRef: 'machine-input',
        persona: { serverId: 'home', sessionId: 'caller-session' }, messageRole: 'user', origin: null,
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' }, inputAuthority });
      const origin = resolveSessionRoleRpcOrigin({ ...context, actionRequestAttributionV1: cause });
      const received = buildActionExecutorContextForRpc({ sessionActionOrigin: origin, serverId: 'home' });
      let cards = 0;
      const executor = createActionExecutor({ approvalsCreate: async () => { cards++; return { artifactId: 'forbidden' }; } });
      expect(await executor.execute('mcp.servers.test', { t: 'byId', serverId: 'mcp-server', machineId: 'machine', directory: '/repo' },
        { ...received, runtimeAccountId: 'owner' })).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
      expect(cards).toBe(0);
    });
});
