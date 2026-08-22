import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/protocol/agents/claude';

import { ProviderEnforcedPermissionHandler } from './handler';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import { ServerBoundPermissionRpcHandlerManager } from '../testkit/serverBoundPermissionRpcHandlerManager';

class FakeSession {
  sessionId = 'test-session-id';
  rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  agentState: any = { requests: {}, completedRequests: {} };
  metadata: any = null;

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  getMetadataSnapshot() {
    return this.metadata;
  }
}

class DeferredUpdateSession extends FakeSession {
  private deferredUpdate: Promise<void> | null = null;
  private resolveDeferredUpdate: (() => void) | null = null;
  private deferredUpdater: ((state: any) => any) | null = null;

  deferNextUpdate(): void {
    this.deferredUpdate = new Promise<void>((resolve) => {
      this.resolveDeferredUpdate = resolve;
    });
  }

  releaseNextUpdate(): void {
    const update = this.deferredUpdater;
    this.deferredUpdater = null;
    if (update) this.agentState = update(this.agentState);
    this.resolveDeferredUpdate?.();
    this.resolveDeferredUpdate = null;
    this.deferredUpdate = null;
  }

  override updateAgentState(updater: any) {
    if (!this.deferredUpdate) return super.updateAgentState(updater);
    this.deferredUpdater = updater;
    return this.deferredUpdate;
  }
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  const pending = Symbol('pending');
  const result = await Promise.race([
    promise.then(() => 'fulfilled' as const, () => 'rejected' as const),
    Promise.resolve(pending),
  ]);
  return result === pending ? 'pending' : result;
}

describe('ProviderEnforcedPermissionHandler always-auto-approve matching', () => {
  it('keeps source-owned terminal-dialog trace redaction on the canonical Protocol policy seam', () => {
    const baseHandlerSource = readFileSync(
      new URL('../BasePermissionHandler.ts', import.meta.url),
      'utf8',
    );

    expect(baseHandlerSource).toContain(
      "import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/protocol/agents/claude';",
    );
    expect(baseHandlerSource).not.toContain(
      "import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/plugin-sdk/agents';",
    );
  });

  afterEach(() => {
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    __resetToolTraceForTests();
  });

  it('hard-denies an explicitly malformed causal permission authority', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('default');

    await expect(handler.handleToolCall(
      'malformed-causal-authority-provider',
      'writeTextFile',
      { path: '/tmp/x', content: 'hi' },
      {
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'not-a-real-mode',
        },
      } as never,
    )).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['malformed-causal-authority-provider']).toBeUndefined();
    expect(session.agentState.completedRequests['malformed-causal-authority-provider']).toEqual(expect.objectContaining({
      status: 'denied',
      decision: 'denied',
    }));
  });

  it('does not let a later mutable mode widening auto-approve a causally bounded provider request', () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');

    expect(handler.getImmediateDecision(
      'causal-ceiling-provider-1',
      'Bash',
      { command: 'echo hi' },
      { causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } } as any,
    )).toBeNull();
  });

  it('does not persist or return a stale yolo Bash approval after host write policy narrows during its AgentState update', async () => {
    const session = new DeferredUpdateSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');
    session.deferNextUpdate();

    const result = handler.handleToolCall(
      'direct-provider-auto-mode-currentness',
      'Bash',
      { command: 'echo hi' },
      { origin: 'host_acp_fs_write' },
    );
    handler.setPermissionMode('read-only');
    session.releaseNextUpdate();

    await expect(result).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['direct-provider-auto-mode-currentness']).toBeUndefined();
    expect(session.agentState.completedRequests['direct-provider-auto-mode-currentness']).toEqual(expect.objectContaining({
      status: 'denied',
      decision: 'denied',
    }));
    expect(session.agentState.completedRequests['direct-provider-auto-mode-currentness'].allowedTools).toBeUndefined();
  });

  it('keeps a failed automatic host-fs denial live and preserves that currentness for a restarted response', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    let reloadedHandler: ProviderEnforcedPermissionHandler | null = null;

    try {
      const pending = handler.handleToolCall(
        'provider-automatic-persistence-restart',
        'Bash',
        { command: 'echo hi' },
        { origin: 'host_acp_fs_write' },
      );
      void pending.catch(() => undefined);
      expect(session.agentState.requests['provider-automatic-persistence-restart']).toBeDefined();

      session.updateAgentState = async () => {
        throw new Error('updateAgentState failed');
      };
      handler.setPermissionMode('read-only');

      expect(await settledState(pending)).toBe('pending');
      expect(session.agentState.requests['provider-automatic-persistence-restart']).toBeDefined();
      expect(session.agentState.completedRequests['provider-automatic-persistence-restart']).toBeUndefined();

      session.updateAgentState = (updater: any) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      reloadedHandler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Reloaded]' });
      reloadedHandler.setPermissionMode('read-only');

      await session.rpcHandlerManager.handlers.get('permission')?.({
        id: 'provider-automatic-persistence-restart',
        approved: true,
        decision: 'approved',
      });

      expect(session.agentState.completedRequests['provider-automatic-persistence-restart']).toEqual(
        expect.objectContaining({
          status: 'denied',
          decision: 'denied',
        }),
      );
    } finally {
      session.updateAgentState = (updater: any) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      await reloadedHandler?.reset();
      await handler.reset();
    }
  });

  it('keeps a causally bounded provider request pending when the mutable mode later widens', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const pending = handler.handleToolCall(
      'causal-pending-provider-1',
      'Bash',
      { command: 'echo hi' },
      { causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
    );
    expect(session.agentState.requests['causal-pending-provider-1']).toBeTruthy();

    handler.setPermissionMode('yolo');

    expect(session.agentState.requests['causal-pending-provider-1']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'causal-pending-provider-1',
      approved: false,
      decision: 'denied',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('auto-approves known safe tools but does not auto-approve substring collisions', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    await expect(handler.handleToolCall('safe-1', 'think', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-2', 'mcp__happier__change_title', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-3', 'happier_change_title', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-4', 'mcp__happier__session_title_set', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-5', 'happier_action_execute', { actionId: 'session.title.set' })).resolves.toEqual({ decision: 'approved' });
    const idOnlyPending = handler.handleToolCall('mcp__happier__change_title-1', 'other', {});
    expect(session.agentState.requests['mcp__happier__change_title-1']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'mcp__happier__change_title-1',
      approved: false,
      decision: 'denied',
    });
    await expect(idOnlyPending).resolves.toEqual({ decision: 'denied' });

    const executionRunPending = handler.handleToolCall('execution-run-1', 'mcp__happier__execution_run_start', {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    });
    expect(session.agentState.requests['execution-run-1']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({ id: 'execution-run-1', approved: true, decision: 'approved' });
    await expect(executionRunPending).resolves.toEqual({ decision: 'approved' });

    const pending = handler.handleToolCall('pending-1', 'think_malware', {});
    expect(session.agentState.requests['pending-1']).toBeTruthy();
    const respond = session.rpcHandlerManager.handlers.get('permission');
    expect(respond).toBeTruthy();
    await respond?.({ id: 'pending-1', approved: false, decision: 'denied' });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['pending-1']).toBeFalsy();
  });

  it('suppresses provider prompts for Happier action tools only when Happier approval is required', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: ['agent'],
            },
          },
        },
      } as any),
    });

    await expect(handler.handleToolCall('list-1', 'mcp__happier__session_list', {})).resolves.toEqual({
      decision: 'approved',
    });
    await expect(handler.handleToolCall('list-2', 'happier__session_list', {})).resolves.toEqual({
      decision: 'approved',
    });
    expect(session.agentState.requests['list-1']).toBeFalsy();
    expect(session.agentState.requests['list-2']).toBeFalsy();

    const pending = handler.handleToolCall('status-1', 'happier_action_execute', { actionId: 'session.status.get' });
    expect(session.agentState.requests['status-1']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({ id: 'status-1', approved: false, decision: 'denied' });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('auto-approves ACP fs bridge tool names to avoid duplicate host-side permission prompts', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    await expect(handler.handleToolCall('fs-read-1', 'readTextFile', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('fs-write-1', 'writeTextFile', {})).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['fs-read-1']).toBeFalsy();
    expect(session.agentState.requests['fs-write-1']).toBeFalsy();
  });

  it('denies every host ACP fs write alias in Read Only and Plan modes before default or custom safe-tool matching', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      alwaysAutoApproveToolNameIncludes: ['write_text_file'],
    });
    const aliases = [
      'writeTextFile',
      'writetextfile',
      'write_text_file',
      'mcp__happier__write_text_file',
      'happier_writeTextFile',
    ];
    for (const permissionMode of ['read-only', 'plan'] as const) {
      handler.setPermissionMode(permissionMode);
      expect(handler.getImmediateDecision(`fs-read-${permissionMode}`, 'readTextFile', {})).toEqual({
        decision: 'approved',
      });

      for (const [index, toolName] of aliases.entries()) {
        const toolCallId = `custom-safe-write-${permissionMode}-${index}`;
        await expect(
          handler.handleToolCall(toolCallId, toolName, {}, { origin: 'host_acp_fs_write' }),
        ).resolves.toEqual({ decision: 'denied' });
        expect(session.agentState.requests[toolCallId]).toBeFalsy();
      }
    }
  });

  it('keeps provider-native operations named writeTextFile under provider enforcement in low-privilege modes', async () => {
    for (const permissionMode of ['read-only', 'plan'] as const) {
      const session = new FakeSession();
      const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
      handler.setPermissionMode(permissionMode);

      await expect(
        handler.handleToolCall(`provider-write-${permissionMode}`, 'writeTextFile', {
          path: 'provider-owned-path',
        }),
      ).resolves.toEqual({ decision: 'approved' });
    }
  });

  it('denies session title tool calls when coding prompt title updates are disabled', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'agent',
        },
      } as any),
    });

    await expect(handler.handleToolCall('title-1', 'mcp__happier__change_title', { title: 'Renamed' })).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('title-2', 'happier_action_execute', { actionId: 'session.title.set' })).resolves.toEqual({
      decision: 'denied',
    });
    expect(session.agentState.requests['title-1']).toBeFalsy();
    expect(session.agentState.requests['title-2']).toBeFalsy();
    expect(session.agentState.completedRequests['title-1']).toMatchObject({
      tool: 'mcp__happier__change_title',
      status: 'denied',
      decision: 'denied',
    });
  });

  it('exposes immediate decisions for always-auto-approved tools', () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    expect(handler.getImmediateDecision('fs-read-1', 'readTextFile', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('fs-write-1', 'writeTextFile', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('spec-search-1', 'action_spec_search', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('spec-search-2', 'mcp__happier__action_spec_search', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('spec-search-3', 'happier_action_spec_search', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('execution-run-1', 'mcp__happier__execution_run_start', {})).toBeNull();
    expect(handler.getImmediateDecision('execution-run-2', 'mcp__happier__subagents_delegate_start', {})).toBeNull();
    expect(handler.getImmediateDecision('perm-1', 'bash', { command: 'pwd' })).toBeNull();
  });

  it('keeps the immediate-decision probe side-effect free until handleToolCall records the approval', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    expect(handler.getImmediateDecision('fs-read-1', 'readTextFile', {})).toEqual({ decision: 'approved' });
    expect(session.agentState.completedRequests['fs-read-1']).toBeUndefined();

    await expect(handler.handleToolCall('fs-read-1', 'readTextFile', {})).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.completedRequests['fs-read-1']).toMatchObject({
      tool: 'readTextFile',
      decision: 'approved',
      status: 'approved',
    });
  });

  it('auto-approves provider permission requests in full-access modes without suppressing user actions', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    const pendingBeforeModeChange = handler.handleToolCall('perm-before-mode-change', 'bash', { command: 'echo later' });
    expect(session.agentState.requests['perm-before-mode-change']).toBeTruthy();

    handler.setPermissionMode('bypassPermissions');

    await expect(pendingBeforeModeChange).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['perm-before-mode-change']).toBeFalsy();
    expect(session.agentState.completedRequests['perm-before-mode-change']).toMatchObject({
      tool: 'bash',
      status: 'approved',
      decision: 'approved',
    });

    expect(handler.getImmediateDecision('perm-1', 'bash', { command: 'echo hello' })).toEqual({
      decision: 'approved',
    });
    await expect(handler.handleToolCall('perm-1', 'bash', { command: 'echo hello' })).resolves.toEqual({
      decision: 'approved',
    });
    expect(session.agentState.requests['perm-1']).toBeFalsy();
    expect(session.agentState.completedRequests['perm-1']).toMatchObject({
      tool: 'bash',
      status: 'approved',
      decision: 'approved',
    });

    handler.setPermissionMode('yolo');

    expect(handler.getImmediateDecision('perm-2', 'TodoWrite', { todos: [] })).toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('perm-2', 'TodoWrite', { todos: [] })).resolves.toEqual({
      decision: 'approved',
    });
    expect(session.agentState.requests['perm-2']).toBeFalsy();

    const pending = handler.handleToolCall('ask-1', 'AskUserQuestion', {
      questions: [{ id: 'language', question: 'Which language?' }],
    });

    expect(session.agentState.requests['ask-1']).toBeTruthy();
    const respond = session.rpcHandlerManager.handlers.get('permission');
    expect(respond).toBeTruthy();
    await respond?.({
      id: 'ask-1',
      approved: true,
      decision: 'approved',
      answers: { language: 'TypeScript' },
    });
    await expect(pending).resolves.toEqual({
      decision: 'approved',
      answers: { language: ['TypeScript'] },
    });
    expect(session.agentState.requests['ask-1']).toBeFalsy();
  });

  it('does not locally settle a pending provider-native request when switching to Read Only or Plan', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const pending = handler.handleToolCall('provider-pending', 'Edit', { path: 'provider-owned-path' });

    handler.setPermissionMode('read-only');
    expect(await settledState(pending)).toBe('pending');
    handler.setPermissionMode('plan');
    expect(await settledState(pending)).toBe('pending');

    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'provider-pending',
      approved: false,
      decision: 'denied',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('cancels only pending requests owned by the deactivated plugin', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    const pluginA = handler.handleToolCall('plugin-a-request', 'Bash', { command: 'echo a' }, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    const pluginB = handler.handleToolCall('plugin-b-request', 'Bash', { command: 'echo b' }, {
      owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
    });

    handler.cancelByPlugin('plugin-a', 'plugin_deactivated');

    await expect(pluginA).rejects.toThrow('plugin_deactivated');
    expect(await settledState(pluginB)).toBe('pending');
    expect(session.agentState.requests['plugin-a-request']).toBeFalsy();
    expect(session.agentState.completedRequests['plugin-a-request']).toMatchObject({
      status: 'canceled',
      reason: 'plugin_deactivated',
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    expect(session.agentState.requests['plugin-b-request']).toMatchObject({
      tool: 'Bash',
      owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
    });

    const respond = session.rpcHandlerManager.handlers.get('permission');
    await respond?.({ id: 'plugin-b-request', approved: false, decision: 'denied' });
    await expect(pluginB).resolves.toEqual({ decision: 'denied' });
  });

  it('terminalizes a caller-aborted plugin request and rejects a later user-action answer as not found', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const abort = new AbortController();

    const first = handler.handleToolCall('plugin-caller-aborted', 'AskUserQuestion', {
      questions: [{ id: 'language', question: 'Language?' }],
    }, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
      signal: abort.signal,
    });
    expect(session.agentState.requests['plugin-caller-aborted']).toBeTruthy();

    abort.abort();
    const racingAnswer = session.rpcHandlerManager.handlers.get('session.user_action.answer')?.({
      id: 'plugin-caller-aborted',
      approved: true,
      decision: 'approved',
      answers: { language: 'TypeScript' },
    });

    await expect(first).rejects.toThrow('Permission request aborted');
    expect(session.agentState.requests['plugin-caller-aborted']).toBeFalsy();
    expect(session.agentState.completedRequests['plugin-caller-aborted']).toMatchObject({
      status: 'canceled',
      decision: 'abort',
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    await expect(racingAnswer).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'plugin-caller-aborted',
    });

    const second = handler.handleToolCall('plugin-second-request', 'AskUserQuestion', {
      questions: [{ id: 'language', question: 'Language?' }],
    }, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    await session.rpcHandlerManager.handlers.get('session.user_action.answer')?.({
      id: 'plugin-second-request',
      approved: true,
      decision: 'approved',
      answers: { language: ['Rust'] },
    });
    await expect(second).resolves.toEqual({ decision: 'approved', answers: { language: ['Rust'] } });
    expect(Object.keys(session.agentState.completedRequests).sort()).toEqual([
      'plugin-caller-aborted',
      'plugin-second-request',
    ]);
  });

  it('does not publish or auto-decide a request whose caller signal was already aborted', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const abort = new AbortController();
    abort.abort();

    await expect(handler.handleToolCall('plugin-pre-aborted', 'think', {}, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
      signal: abort.signal,
    })).rejects.toThrow('Permission request aborted');
    expect(session.agentState.requests).toEqual({});
    expect(session.agentState.completedRequests).toEqual({});
  });

  it('projects a caller-owned source separately from tool input', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    const pending = handler.handleToolCall('plugin-dialog-request', 'AskUserQuestion', {
      happierDialog: { dialogId: 'trust_folder' },
    }, {
      owner: { kind: 'plugin', pluginId: 'happier.agent.claude', runtimeId: 'claude' },
      source: 'claude_unified_terminal_dialog_choice',
    });

    expect(session.agentState.requests['plugin-dialog-request']).toMatchObject({
      tool: 'AskUserQuestion',
      source: 'claude_unified_terminal_dialog_choice',
      owner: { kind: 'plugin', pluginId: 'happier.agent.claude', runtimeId: 'claude' },
    });

    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'plugin-dialog-request',
      approved: false,
      decision: 'denied',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('does not reuse plugin-owned approved-for-session decisions across plugin owners', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const input = { command: 'echo shared' };

    const pluginA = handler.handleToolCall('plugin-a-request', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    const respond = session.rpcHandlerManager.handlers.get('permission');
    expect(respond).toBeTruthy();
    await respond?.({ id: 'plugin-a-request', approved: true, decision: 'approved_for_session' });
    await expect(pluginA).resolves.toEqual({ decision: 'approved_for_session' });

    const pluginASiblingRuntime = handler.handleToolCall('plugin-a-sibling-runtime-request', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-b' },
    });

    expect(await settledState(pluginASiblingRuntime)).toBe('pending');
    expect(session.agentState.requests['plugin-a-sibling-runtime-request']).toMatchObject({
      tool: 'Bash',
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-b' },
    });

    await respond?.({ id: 'plugin-a-sibling-runtime-request', approved: false, decision: 'denied' });
    await expect(pluginASiblingRuntime).resolves.toEqual({ decision: 'denied' });

    const pluginB = handler.handleToolCall('plugin-b-request', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
    });

    expect(await settledState(pluginB)).toBe('pending');
    expect(session.agentState.requests['plugin-b-request']).toMatchObject({
      tool: 'Bash',
      owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
    });

    await respond?.({ id: 'plugin-b-request', approved: false, decision: 'denied' });
    await expect(pluginB).resolves.toEqual({ decision: 'denied' });
  });

  it('reuses approved-for-session decisions across invocations of one stable plugin runtime owner', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const owner = { kind: 'plugin' as const, pluginId: 'acme.plugin', runtimeId: 'acme.plugin/actions/run' };
    const input = { command: 'echo stable-owner' };

    const firstInvocation = handler.handleToolCall('ordinary-invocation-one', 'Bash', input, { owner });
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'ordinary-invocation-one',
      approved: true,
      decision: 'approved_for_session',
    });
    await expect(firstInvocation).resolves.toEqual({ decision: 'approved_for_session' });

    await expect(handler.handleToolCall('ordinary-invocation-two', 'Bash', input, { owner }))
      .resolves.toEqual({ decision: 'approved_for_session' });
    expect(session.agentState.requests['ordinary-invocation-two']).toBeUndefined();
  });

  it('does not let a rejected plugin duplicate mark an unowned request as plugin-owned', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const input = { command: 'echo shared' };

    const unowned = handler.handleToolCall('shared-request-id', 'Bash', input);
    await expect(handler.handleToolCall('shared-request-id', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    })).rejects.toBeInstanceOf(Error);

    const pluginOwned = handler.handleToolCall('plugin-owned-request', 'Bash', input, {
      owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
    });
    const respond = session.rpcHandlerManager.handlers.get('permission');
    await respond?.({ id: 'plugin-owned-request', approved: true, decision: 'approved_for_session' });
    await expect(pluginOwned).resolves.toEqual({ decision: 'approved_for_session' });

    expect(await settledState(unowned)).toBe('pending');
    expect(session.agentState.requests['shared-request-id']).toMatchObject({
      tool: 'Bash',
    });
    expect(session.agentState.requests['shared-request-id']?.owner).toBeUndefined();

    await respond?.({ id: 'shared-request-id', approved: false, decision: 'denied' });
    await expect(unowned).resolves.toEqual({ decision: 'denied' });
  });

  it('records permission-request tool trace events when enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-provider-enforced-'));
    try {
      const filePath = join(dir, 'tool-trace.jsonl');
      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = filePath;

      const session = new FakeSession();
      const handler = new ProviderEnforcedPermissionHandler(session as any, {
        logPrefix: '[Test]',
        // Type-level support for toolTrace is intentionally part of the implementation task.
        // For the RED test, cast to avoid production changes before the failing assertion.
        toolTrace: { protocol: 'acp', provider: 'opencode' },
      } as any);

      const pending = handler.handleToolCall('perm-1', 'Bash', { command: 'echo hello' });

      expect(existsSync(filePath)).toBe(true);
      const lines = readFileSync(filePath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        direction: 'outbound',
        sessionId: 'test-session-id',
        protocol: 'acp',
        provider: 'opencode',
        kind: 'permission-request',
        payload: expect.objectContaining({
          type: 'permission-request',
          permissionId: 'perm-1',
          toolName: 'Bash',
        }),
      });

      const respond = session.rpcHandlerManager.handlers.get('permission');
      expect(respond).toBeTruthy();
      await respond?.({ id: 'perm-1', approved: false, decision: 'denied' });
      await expect(pending).resolves.toEqual({ decision: 'denied' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts source-owned terminal dialog prompts and options from tool traces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-source-dialog-'));
    try {
      const filePath = join(dir, 'tool-trace.jsonl');
      process.env.HAPPIER_STACK_TOOL_TRACE = '1';
      process.env.HAPPIER_STACK_TOOL_TRACE_FILE = filePath;

      const session = new FakeSession();
      const handler = new ProviderEnforcedPermissionHandler(session as any, {
        logPrefix: '[Test]',
        toolTrace: { protocol: 'claude', provider: 'claude' },
      });
      const pending = handler.handleToolCall('dialog-1', 'AskUserQuestion', {
        happierDialog: {
          kind: 'unrecognized',
          mode: 'generic',
          dialogId: 'unrecognized_confirmation',
        },
        questions: [{
          question: 'private prompt text must not reach the trace',
          options: [
            { label: 'private option one', description: 'sensitive description one' },
            { label: 'private option two', description: 'sensitive description two' },
          ],
        }],
      }, {
        source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
        owner: { kind: 'plugin', pluginId: 'happier.agent.claude', runtimeId: 'claude' },
      });

      const raw = readFileSync(filePath, 'utf8');
      expect(raw).not.toContain('private prompt text');
      expect(raw).not.toContain('private option');
      expect(raw).not.toContain('sensitive description');
      expect(JSON.parse(raw.trim())).toMatchObject({
        kind: 'permission-request',
        payload: {
          type: 'permission-request',
          permissionId: 'dialog-1',
          toolName: 'AskUserQuestion',
          options: {
            input: {
              redacted: true,
              dialog: {
                kind: 'unrecognized',
                mode: 'generic',
                dialogId: 'unrecognized_confirmation',
              },
              questionCount: 1,
              optionCount: 2,
            },
          },
        },
      });

      await session.rpcHandlerManager.handlers.get('permission')?.({
        id: 'dialog-1',
        approved: false,
        decision: 'denied',
      });
      await expect(pending).resolves.toEqual({ decision: 'denied' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
