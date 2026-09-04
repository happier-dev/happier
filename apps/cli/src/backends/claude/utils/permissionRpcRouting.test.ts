import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/agents';

import type { SDKAssistantMessage } from '../sdk';
import { Query } from '../sdk/query';
import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';
import { ClaudePermissionRpcRouter } from './permissionRpcRouter';
import type { PermissionRpcPayload } from './permissionRpc';

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

function bashToolUseMessage(): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm --version' } }],
    },
  };
}

const defaultMode = { permissionMode: 'default' } as EnhancedMode;

describe('permission RPC routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
  });

  it('does not break remote approvals when the local permission bridge activates later', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    handler.onMessage(bashToolUseMessage());

    const permissionPromise = handler.handleToolCall('Bash', { command: 'npm --version' }, defaultMode, {
      signal: new AbortController().signal,
      toolUseId: 'toolu_1',
    });

    // This mirrors the production ordering risk: a later activation overwrites the `permission` handler.
    const { ClaudeLocalPermissionBridge } = await import('../localPermissions/localPermissionBridge');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();
    await permissionRpc?.({ id: 'toolu_1', approved: true });

    const result = await Promise.race([
      permissionPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('permission routing timed out')), 50)),
    ]);

    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'npm --version' } });
  });

  it('does not let the local permission bridge steal remote approvals when it activates first', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { ClaudeLocalPermissionBridge } = await import('../localPermissions/localPermissionBridge');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    handler.onMessage(bashToolUseMessage());

    const permissionPromise = handler.handleToolCall('Bash', { command: 'npm --version' }, defaultMode, {
      signal: new AbortController().signal,
      toolUseId: 'toolu_1',
    });

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();
    await permissionRpc?.({ id: 'toolu_1', approved: true });

    const result = await Promise.race([
      permissionPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('permission routing timed out')), 50)),
    ]);

    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'npm --version' } });
  });

  it('refuses a claimed remote tool-use ID before bypass-permissions can auto-allow it', async () => {
    const { session, client } = createPermissionHandlerSessionStub('claimed-remote-auto-allow');
    const opaqueClaim = { malformed: { newerRuntime: true } };
    client.updateAgentState((state) => ({
      ...state,
      requests: {
        ...state.requests,
        toolu_1: {
          tool: 'Bash',
          kind: 'permission',
          arguments: { command: 'npm --version' },
          createdAt: 1,
          permissionResponseClaimV1: opaqueClaim,
        },
      },
    }));

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    handler.onMessage(bashToolUseMessage());

    await expect(handler.handleToolCall('Bash', { command: 'npm --version' }, {
      permissionMode: 'bypassPermissions',
    } as EnhancedMode, {
      signal: new AbortController().signal,
      toolUseId: 'toolu_1',
    })).rejects.toThrow(/reserved/i);

    const retained = client.getAgentStateSnapshot().requests.toolu_1 as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
    expect(retained.permissionResponseClaimV1).toBe(opaqueClaim);
    expect(client.getAgentStateSnapshot().completedRequests.toolu_1).toBeUndefined();
    handler.dispose();
    expect(client.getAgentStateSnapshot().requests.toolu_1).toEqual(expect.objectContaining({
      permissionResponseClaimV1: opaqueClaim,
    }));
    expect(client.getAgentStateSnapshot().completedRequests.toolu_1).toBeUndefined();
  });

  it('fails closed before the legacy callback without a canonical tool-use ID, leaving an opaque remote deny claim untouched', async () => {
    const { session, client } = createPermissionHandlerSessionStub('claimed-remote-no-id');
    const opaqueRemoteDenyClaim = {
      version: 1,
      origin: 'remoteMediation',
      actor: {
        kind: 'externalHuman',
        assurance: 'pluginAsserted',
        namespace: 'telegram',
        principalId: 'remote-user',
        assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'telegram' },
      },
      mediatorPluginId: 'happier.channels',
      sourceRef: 'conversation-1',
      sourceRevisionOrEpoch: 'rev-1',
      idempotencyKey: 'reply-1',
      decision: 'deny',
      scope: 'request',
    };
    client.updateAgentState((state) => ({
      ...state,
      requests: {
        ...state.requests,
        toolu_1: {
          tool: 'Bash',
          kind: 'permission',
          arguments: { command: 'npm --version' },
          createdAt: 1,
          permissionResponseClaimV1: opaqueRemoteDenyClaim,
        },
      },
    }));

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    const canCallTool = vi.fn(async (
      toolName: string,
      input: unknown,
      options: { signal: AbortSignal; toolUseId?: string | null },
    ) => handler.handleToolCall(toolName, input, {
      permissionMode: 'bypassPermissions',
    } as EnhancedMode, options));
    const stdout = new PassThrough();
    const query = new Query(null, stdout, Promise.resolve(), canCallTool) as any;

    await expect(query.processControlRequest({
      type: 'control_request',
      request_id: 'permission-request-without-tool-use-id',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'npm --version' },
      },
    }, new AbortController().signal)).rejects.toThrow(/canonical tool-use id/i);

    expect(canCallTool).not.toHaveBeenCalled();
    const retained = client.getAgentStateSnapshot().requests.toolu_1 as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
    expect(retained.permissionResponseClaimV1).toBe(opaqueRemoteDenyClaim);
    expect(client.getAgentStateSnapshot().completedRequests.toolu_1).toBeUndefined();
    stdout.end();
    handler.dispose();
  });

  it('keeps bypass-permissions behavior for an unclaimed canonical tool-use ID', async () => {
    const { session, client } = createPermissionHandlerSessionStub('unclaimed-remote-bypass');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    await expect(handler.handleToolCall('Bash', { command: 'npm --version' }, {
      permissionMode: 'bypassPermissions',
    } as EnhancedMode, {
      signal: new AbortController().signal,
      toolUseId: 'toolu_unclaimed_1',
    })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm --version' },
    });

    expect(client.getAgentStateSnapshot().requests.toolu_unclaimed_1).toBeUndefined();
    expect(client.getAgentStateSnapshot().completedRequests.toolu_unclaimed_1).toBeUndefined();
    handler.dispose();
  });

  it('returns an unhandled result for stale permission ids', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { ClaudeLocalPermissionBridge } = await import('../localPermissions/localPermissionBridge');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await expect(permissionRpc?.({ id: 'toolu_missing_permission_1', approved: true })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      requestId: 'toolu_missing_permission_1',
    });
  });

  it('returns an unhandled result for stale user-action ids', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { ClaudeLocalPermissionBridge } = await import('../localPermissions/localPermissionBridge');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await expect(permissionRpc?.({ id: 'toolu_missing_ask_1', approved: true, answers: { Continue: 'Yes' } })).rejects.toMatchObject({
      rpcErrorCode: 'STRUCTURED_QUESTION_RECEIVER_NOT_OWNER',
    });
  });

  it('maps an expired consumer outcome to a typed permission_request_expired result', async () => {
    const registered = new Map<string, (payload: PermissionRpcPayload) => unknown>();
    const router = new ClaudePermissionRpcRouter({
      registerHandler: (method, handler) => {
        registered.set(method, handler);
      },
    });
    router.registerConsumer({
      name: 'expiring',
      tryHandlePermissionRpc: () => ({ status: 'expired' }),
    });

    await expect(registered.get('permission')!({ id: 'toolu_expired_1', approved: true })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_expired',
      errorMessage: 'permission_request_expired',
      requestId: 'toolu_expired_1',
    });
  });

  it('treats a handled object outcome like a boolean true and continues past unhandled outcomes', async () => {
    const registered = new Map<string, (payload: PermissionRpcPayload) => unknown>();
    const router = new ClaudePermissionRpcRouter({
      registerHandler: (method, handler) => {
        registered.set(method, handler);
      },
    });
    router.registerConsumer({ name: 'skip', tryHandlePermissionRpc: () => ({ status: 'unhandled' }) });
    router.registerConsumer({ name: 'take', tryHandlePermissionRpc: () => ({ status: 'handled' }) });

    await expect(registered.get('permission')!({ id: 'toolu_handled_1', approved: true })).resolves.toEqual({ ok: true });
  });

  it('does not acknowledge a handled RPC until its async consumer has finished', async () => {
    const registered = new Map<string, (payload: PermissionRpcPayload) => unknown>();
    const router = new ClaudePermissionRpcRouter({
      registerHandler: (method, handler) => {
        registered.set(method, handler);
      },
    });
    let finishConsumer!: () => void;
    const consumerFinished = new Promise<void>((resolve) => {
      finishConsumer = resolve;
    });
    router.registerConsumer({
      name: 'terminal-answer',
      tryHandlePermissionRpc: async () => {
        await consumerFinished;
        return true;
      },
    });

    let rpcSettled = false;
    const rpc = Promise.resolve(registered.get('permission')!({ id: 'dialog_1', approved: true }))
      .then((result) => {
        rpcSettled = true;
        return result;
      });
    await Promise.resolve();
    expect(rpcSettled).toBe(false);

    finishConsumer();
    await expect(rpc).resolves.toEqual({ ok: true });
  });

  it('does not let remote permission cleanup cancel local-bridge requests', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { ClaudeLocalPermissionBridge } = await import('../localPermissions/localPermissionBridge');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const localPermission = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/local-bridge.txt', content: 'hello' },
      tool_use_id: 'toolu_local_bridge_pending_1',
    });

    expect(client.getAgentStateSnapshot().requests.toolu_local_bridge_pending_1).toBeDefined();

    const { PermissionHandler } = await import('./permissionHandler');
    const remoteHandler = new PermissionHandler(session);
    await remoteHandler.abortPendingRequestsAndFlush('Remote session ended');

    expect(client.getAgentStateSnapshot().requests.toolu_local_bridge_pending_1).toBeDefined();
    expect(client.getAgentStateSnapshot().completedRequests.toolu_local_bridge_pending_1).toBeUndefined();

    bridge.dispose();
    remoteHandler.dispose();
    await expect(localPermission).resolves.toMatchObject({
      hookSpecificOutput: { hookEventName: 'PermissionRequest' },
    });
  });

  it('does not let the remote permission handler consume resume-choice user-action answers from agent-state fallback', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    client.updateAgentState((state) => ({
      ...state,
      requests: {
        ...state.requests,
        claude_resume_choice_1: {
          toolName: 'AskUserQuestion',
          toolInput: { questions: [{ question: 'How should Claude resume this session?' }] },
          createdAt: 1,
          kind: 'user_action',
          source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
        },
      },
    }));

    const { PermissionHandler } = await import('./permissionHandler');
    const remoteHandler = new PermissionHandler(session);
    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await expect(permissionRpc?.({
      id: 'claude_resume_choice_1',
      approved: true,
      answers: { 'How should Claude resume this session?': 'Resume from summary' },
    })).rejects.toMatchObject({ rpcErrorCode: 'STRUCTURED_QUESTION_RECEIVER_NOT_OWNER' });

    expect(client.getAgentStateSnapshot().requests.claude_resume_choice_1).toBeDefined();
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_1).toBeUndefined();
    remoteHandler.dispose();
  });

  it('does not let remote permission cleanup cancel resume-choice user-action requests', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    client.updateAgentState((state) => ({
      ...state,
      requests: {
        ...state.requests,
        claude_resume_choice_1: {
          toolName: 'AskUserQuestion',
          toolInput: { questions: [{ question: 'How should Claude resume this session?' }] },
          createdAt: 1,
          kind: 'user_action',
          source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
        },
      },
    }));

    const { PermissionHandler } = await import('./permissionHandler');
    const remoteHandler = new PermissionHandler(session);
    await remoteHandler.abortPendingRequestsAndFlush('Remote session ended');

    expect(client.getAgentStateSnapshot().requests.claude_resume_choice_1).toBeDefined();
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_1).toBeUndefined();
    remoteHandler.dispose();
  });
});
