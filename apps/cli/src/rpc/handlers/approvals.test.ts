import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { JsonValue } from '@happier-dev/protocol';

import { registerApprovalRpcHandlers } from './approvals';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { resolveSessionRpcContent } from '@/session/transport/rpc/sessionRpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import tweetnacl from 'tweetnacl';
import { ApprovalRequestV2Schema, buildApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildApprovalExecutionOriginV1, createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';

const fixtureSource = new URL('../../../../../packages/tests/src/testkit/actionExecutorBoundary.ts', import.meta.url).href;
const { createActionExecutorBoundaryFixture }: {
  createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps;
} = await import(fixtureSource);

function requesterApproval(family: 'built_in' | 'target') {
  const actionId = family === 'built_in' ? 'session.message.send' : 'action.invoke';
  const actionArgs: JsonValue = family === 'built_in' ? { sessionId: 'destination', message: 'exact preview' }
    : { action: { pluginId: 'acme.account', localId: 'write' }, input: { key: 'sample' } };
  const caller = { kind: 'session' as const, sessionId: 'bot-session', starterDepth: 0, turnDepth: 0 };
  const target = { kind: 'session' as const, sessionId: 'destination' };
  const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const };
  const actionRequestAttributionV1 = { requestRef: 'bob-request', requester: { serverId: 'home', accountId: 'bob' },
    persona: { serverId: 'home', sessionId: 'original-manager' }, origin: null };
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(39));
  const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'alice',
    defaultSessionId: 'bot-session', serverId: 'home', serverIdentityId: 'srv_home', actionRequestId: 'bot-request',
    actionCaller: caller, callerPermissionMode: 'yolo', causalPermissionAuthority, externalActionTarget: target,
    sessionInputSource: { sourceSessionId: 'bot-session', sourceTurnId: 'turn-1', via: 'action' },
    actionRequestAttributionV1,
    externalActionExecutionAuthorization: { v: 1, token: 'original-bot-source', binding: {
      serverIdentityId: 'srv_home', accountId: 'alice', custodianAccountId: 'alice', machineId: 'bot-machine',
      installationId: 'installation', actionId, requestId: 'bot-request', target,
      authentication: { kind: 'account', tokenEpoch: 1 },
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'bot-request', target, input: actionArgs }),
      sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn-1', callerPermissionMode: 'yolo', causalPermissionAuthority, requestId: 'bot-request', actionRequestAttributionV1 },
      sessionActionSource: { machineId: 'bot-machine', installationId: 'installation' },
    } },
    signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
      actionId: args.actionId, target: args.target, input: args.input, privateKey: key.secretKey,
      requesterConfirmation: args.requesterConfirmation, sessionTargetsV1: args.sessionTargetsV1 }),
  };
  const requesterConfirmation = buildApprovalRequesterConfirmationV1({ context, actionId, input: actionArgs });
  if (!requesterConfirmation) throw new Error('Expected requester confirmation');
  const executionOriginV1 = buildApprovalExecutionOriginV1({ context, actionId, input: actionArgs,
    targetSessionId: 'destination', requesterConfirmation });
  if (!executionOriginV1) throw new Error('Expected signed origin');
  const common = { status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
    summary: 'Original requester preview', executionOriginV1, requesterConfirmation };
  return family === 'built_in' ? ApprovalRequestV2Schema.parse({ ...common, v: 2, actionId, actionArgs })
    : TargetActionApprovalRequestV1Schema.parse({ ...common, v: 1, kind: 'plugin_target_action',
      qualifiedActionId: 'acme.account/actions/write', input: { key: 'sample' }, secretInputPaths: [], approvalInputCustody: 'live_only',
      sourceCustody: { kind: 'development', registeredRootId: 'account-root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64) });
}

describe('approval RPC handlers', () => {
  it.each(['built_in', 'target'] as const)('retains authenticated requester Voice modality through real %s decision ingress and settlement', async family => {
    for (const decision of ['approve', 'reject'] as const) for (const source of [undefined, 'voice'] as const) {
      let stored = requesterApproval(family);
      const originalOrigin = stored.executionOriginV1;
      const originalRequester = stored.requesterConfirmation;
      const rpc = new RpcHandlerManager({ scopePrefix: 'bot-machine', encryptionMode: 'plain', logger: () => {},
        resolveSessionDecisionContext: async () => ({ content: { mode: 'plain' }, isCurrent: async () => true }) });
      const targetOwner = createTargetActionApprovalDecision({
        read: async () => 'kind' in stored ? stored : null,
        update: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request))); return { ok: true }; },
        isRequesterSourceCurrent: async () => true,
      });
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        approvalsGet: async () => 'kind' in stored ? null : stored,
        approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request))); return { ok: true }; },
        targetActionApprovalReplay: targetOwner,
        isApprovalExecutionOriginCurrent: async () => true,
        sessionSendMessage: async () => ({ status: 'accepted', localId: 'same-bot-effect' }),
      }));
      registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor });
      const authorization = { kind: 'session.permission.respond' as const, sessionId: 'bot-session', authentication: { tokenEpoch: 1 },
        actor: { kind: 'accountUser' as const, accountId: 'bob', relationship: 'sharedApprover' as const } };
      if (decision === 'reject' && source === undefined) {
        for (const field of ['decidedVia', 'decisionSource']) {
          expect(await executor.execute('approval.request.decide', { artifactId: 'requester-preview', decision, [field]: 'voice' },
            { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        }
        expect(await rpc.handleRequest({ method: 'bot-session:approval.request.decide', callerAuthority: 'present_user', authorization,
          params: { artifactId: 'requester-preview', sessionId: 'bot-session', decision, decisionSource: 'unknown' },
        })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        expect(await rpc.handleRequest({ method: 'bot-machine:approval.request.decide', callerAuthority: 'present_user',
          params: { artifactId: 'requester-preview', sessionId: 'bot-session', decision, decisionSource: 'voice' },
        })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(stored.status).toBe('open');
      }
      expect(await rpc.handleRequest({ method: 'bot-session:approval.request.decide', callerAuthority: 'present_user',
        authorization,
        params: { artifactId: 'requester-preview', sessionId: 'bot-session', decision,
          ...(source ? { decisionSource: source } : {}) },
      })).toEqual({ ok: true, status: decision === 'approve' ? family === 'target' ? 'approved' : 'executed' : 'rejected',
        ...(decision === 'approve' && family === 'built_in' ? { execution: expect.objectContaining({ ok: true }) } : {}) });
      expect(stored.decision).toMatchObject({ kind: decision, authority: 'present_user', decidingAccountId: 'bob',
        ...(source ? { decidedVia: 'voice' } : {}) });
      if (!source) expect(stored.decision).not.toHaveProperty('decidedVia');
      expect(stored.executionOriginV1).toEqual(originalOrigin);
      expect(stored.requesterConfirmation).toEqual(originalRequester);
    }
  });
  it('keeps a verified requester decision on the original executor even when requester Account custody is attached', async () => {
    const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
    const original = vi.fn<RpcActionExecutor['execute']>(async () => ({ ok: true, result: { account: 'alice' } }));
    const requester = vi.fn<RpcActionExecutor['execute']>(async () => ({ ok: true, result: { account: 'bob' } }));
    registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      actionExecutor: { execute: original } });
    const decide = handlers.get(RPC_METHODS.APPROVAL_REQUEST_DECIDE);
    if (!decide) throw new Error('missing decision handler');
    expect(await decide({ artifactId: 'request', decision: 'approved', sessionId: 'bot-session' }, {
      signal: new AbortController().signal, callerAuthority: 'present_user',
      requesterApprovalDecision: { sessionId: 'bot-session',
        actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' }, isCurrent: async () => true },
      callerInputAuthorization: { v: 1, token: 'admitted-root', binding: {
        accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'bot-machine', installationId: 'installation',
        actionId: 'approval.request.decide', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'bot-machine' },
      }, requesterAccountExecutor: { execute: requester } },
    })).toEqual({ account: 'alice' });
    expect(requester).not.toHaveBeenCalled();
  });
  it('preserves ordinary owner decisions on the existing Machine handler without minting requester authority', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'bot-machine', encryptionMode: 'plain', logger: () => {} });
    const execute = vi.fn<RpcActionExecutor['execute']>(async (_actionId, _input, context) => ({ ok: true,
      result: { authority: context?.authority, requesterDecision: context?.requesterApprovalDecision ?? null } }));
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: { execute } });
    expect(await rpc.handleRequest({ method: 'bot-machine:approval.request.decide', callerAuthority: 'present_user',
      params: { artifactId: 'request', decision: 'approved' } }))
      .toEqual({ authority: 'present_user', requesterDecision: null });
  });
  it('binds a requester decision to its authenticated Session actor and rechecks current access after forwarding', async () => {
    let current = true;
    const rpc = new RpcHandlerManager({ scopePrefix: 'bot-machine', encryptionMode: 'plain', logger: () => {},
      resolveSessionDecisionContext: async () => ({ content: { mode: 'plain' }, isCurrent: async () => current }),
    });
    const execute = vi.fn<RpcActionExecutor['execute']>(async (_actionId, _input, context) => {
      if (!context?.requesterApprovalDecision) throw new Error('missing requester decision');
      expect(context.requesterApprovalDecision.actor.accountId).toBe('bob');
      expect(context.requesterApprovalDecision.sessionId).toBe('bot-session');
      expect(await context.requesterApprovalDecision.isCurrent()).toBe(true);
      current = false;
      return { ok: true as const, result: { effectAllowed: await context.requesterApprovalDecision.isCurrent() } };
    });
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: { execute } });
    const request = { method: 'bot-session:approval.request.decide',
      params: { artifactId: 'request', decision: 'approved', sessionId: 'bot-session' },
      callerAuthority: 'present_user' as const,
      authorization: { kind: 'session.permission.respond' as const, sessionId: 'bot-session',
        authentication: { tokenEpoch: 1 },
        actor: { kind: 'accountUser' as const, accountId: 'bob', relationship: 'sharedApprover' as const } },
    };
    expect(await rpc.handleRequest(request)).toEqual({ effectAllowed: false });
    expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['account_automation', 'missing_actor', 'missing_authentication', 'wrong_session', 'no_verifier'])(
    'does not supply requester decision authority for %s', async scenario => {
      const rpc = new RpcHandlerManager({ scopePrefix: 'bot-machine', encryptionMode: 'plain', logger: () => {},
        ...(scenario === 'no_verifier' ? {} : { resolveSessionDecisionContext: async () => ({ content: { mode: 'plain' as const }, isCurrent: async () => true }) }),
      });
      const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
      registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: { execute } });
      const result = await rpc.handleRequest({ method: 'bot-session:approval.request.decide',
        params: { artifactId: 'request', decision: 'approved', sessionId: 'bot-session', decisionSource: 'voice' },
        callerAuthority: scenario === 'account_automation' ? 'account_automation' : 'present_user',
        ...(scenario === 'missing_actor' ? {} : { authorization: {
          kind: 'session.permission.respond' as const, sessionId: scenario === 'wrong_session' ? 'other' : 'bot-session',
          ...(scenario === 'missing_authentication' ? {} : { authentication: { tokenEpoch: 1 } }),
          actor: { kind: 'accountUser' as const, accountId: 'bob', relationship: 'sharedApprover' as const },
        } }),
      });
      expect(result).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('retains the exact Session cipher and wire binding while dispatching the existing Machine handler', async () => {
    const content = resolveSessionRpcContent({ mode: 'e2ee', ctx: {
      encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey',
    } });
    const rpc = new RpcHandlerManager({ scopePrefix: 'bot-machine', encryptionMode: 'e2ee',
      encryptionKey: new Uint8Array(32).fill(9), encryptionVariant: 'dataKey', logger: () => {},
      resolveSessionDecisionContext: async () => ({ content, isCurrent: async () => true }),
    });
    const execute = vi.fn<RpcActionExecutor['execute']>(async (_actionId, input, context) => ({ ok: true,
      result: { input, actor: context?.requesterApprovalDecision?.actor.accountId } }));
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: { execute } });
    const binding = { method: 'bot-session:approval.request.decide', callId: '0123456789abcdef0123456789abcdef' };
    const input = { artifactId: 'request', decision: 'approved', sessionId: 'bot-session' };
    const authorization = { kind: 'session.permission.respond' as const, sessionId: 'bot-session',
      authentication: { tokenEpoch: 1 },
      actor: { kind: 'accountUser' as const, accountId: 'bob', relationship: 'sharedApprover' as const } };
    const response = await rpc.handleRequest({ method: binding.method,
      params: await socketRpcCodec.encodeParams(content, input, binding), callerAuthority: 'present_user', authorization });
    expect(await socketRpcCodec.decodeResult(content, { ok: true, result: response }, binding.callId))
      .toEqual({ input, actor: 'bob' });
    const wrongInput = { ...input, sessionId: 'other' };
    const refused = await rpc.handleRequest({ method: binding.method,
      params: await socketRpcCodec.encodeParams(content, wrongInput, binding), callerAuthority: 'present_user', authorization });
    await expect(socketRpcCodec.decodeResult(content, { ok: true, result: refused }, binding.callId))
      .resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not admit payload-labelled human authority through the private continuation handler', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {} });
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc });
    const response = await rpc.handleRequest({
      method: `machine-1:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`,
      params: { authority: 'present_user', choice: { kind: 'once', value: 'private-test-value' } },
      callerAuthority: 'account_automation',
    });
    expect(response).toEqual({ status: 'refused', code: 'approval_required' });
    expect(JSON.stringify(response)).not.toContain('private-test-value');
  });
});
