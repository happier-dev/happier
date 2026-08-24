import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { ProviderEnforcedPermissionHandler } from './ProviderEnforcedPermissionHandler';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(name: string, handler: any) {
    this.handlers.set(name, handler);
  }
}

class FakeSession {
  sessionId = 'test-session-id';
  rpcHandlerManager = new FakeRpcHandlerManager();
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

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  await Promise.resolve();
  await Promise.resolve();

  return Promise.race([
    promise.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ]);
}

describe('ProviderEnforcedPermissionHandler always-auto-approve matching', () => {
  afterEach(() => {
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    __resetToolTraceForTests();
  });

  it('auto-approves known safe tools but does not auto-approve substring collisions', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    await expect(handler.handleToolCall('safe-1', 'think', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-2', 'mcp__happier__change_title', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-3', 'happier_change_title', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-4', 'mcp__happier__session_title_set', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-5', 'happier_action_execute', { actionId: 'session.title.set' })).resolves.toEqual({ decision: 'approved' });
    const misleadingIdPending = handler.handleToolCall('mcp__happier__change_title-1', 'other', {});
    expect(session.agentState.requests['mcp__happier__change_title-1']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'mcp__happier__change_title-1',
      approved: false,
      decision: 'denied',
    });
    await expect(misleadingIdPending).resolves.toEqual({ decision: 'denied' });

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

  it('auto-approves ACP fs bridge tool names to avoid duplicate host-side permission prompts', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    await expect(handler.handleToolCall('fs-read-1', 'readTextFile', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('fs-write-1', 'writeTextFile', {})).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['fs-read-1']).toBeFalsy();
    expect(session.agentState.requests['fs-write-1']).toBeFalsy();
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

  it('falls back to account prompt settings when a compatibility session has no metadata snapshot reader', async () => {
    const session = new FakeSession();
    Object.defineProperty(session, 'getMetadataSnapshot', { value: undefined });
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

    await expect(handler.handleToolCall('title-compat-1', 'mcp__happier__change_title', { title: 'Renamed' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('denies session title tool calls when a profile override disables title updates over an enabled global', async () => {
    const session = new FakeSession();
    session.metadata = { profileId: 'profile-no-titles' };
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'ongoing',
          responseOptions: 'agent',
        },
        profiles: [
          {
            id: 'profile-no-titles',
            name: 'Profile (no titles)',
            codingPromptBehaviorV1: {
              v: 1,
              sessionTitleUpdates: 'disabled',
            },
          },
        ],
      } as any),
    });

    // The deny layer must evaluate the same merged decision as the prompt and the
    // tools bridge: the profile override disables title updates even though the
    // global account default is ongoing.
    await expect(handler.handleToolCall('title-1', 'mcp__happier__change_title', { title: 'Renamed' })).resolves.toEqual({
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

  it('suppresses provider-enforced prompts for first-party Happier tools when action approval is required', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: ['session_agent'],
            },
          },
        },
      } as any),
    });

    await expect(handler.handleToolCall('happier-session-list-1', 'mcp__happier__session_list', {})).resolves.toEqual({
      decision: 'approved',
    });
    expect(session.agentState.requests['happier-session-list-1']).toBeFalsy();

    const pending = handler.handleToolCall('custom-session-list-1', 'mcp__custom__session_list', {});
    expect(session.agentState.requests['custom-session-list-1']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'custom-session-list-1',
      approved: true,
      decision: 'approved',
    });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('prompts for action_execute when Happier approval is not required', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: [],
            },
          },
        },
      } as any),
    });

    expect(handler.getImmediateDecision('action-execute-1', 'happier_action_execute', {
      actionId: 'session.list',
    })).toBeNull();

    const pending = handler.handleToolCall('action-execute-1', 'happier_action_execute', {
      actionId: 'session.list',
    });
    expect(session.agentState.requests['action-execute-1']).toEqual(
      expect.objectContaining({ tool: 'happier_action_execute' }),
    );
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'action-execute-1',
      approved: true,
      decision: 'approved',
    });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('suppresses action_execute provider prompts when Happier approval is required', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, {
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: ['session_agent'],
            },
          },
        },
      } as any),
    });

    await expect(handler.handleToolCall('action-execute-approval-1', 'happier_action_execute', {
      actionId: 'session.list',
    })).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['action-execute-approval-1']).toBeFalsy();
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
      answers: { 'Which language?': 'TypeScript' },
    });
    await expect(pending).resolves.toEqual({
      decision: 'approved',
      answers: { 'Which language?': ['TypeScript'] },
    });
    expect(session.agentState.requests['ask-1']).toBeFalsy();
  });

  it('refuses opaque claimed IDs before full-access or safe-tool auto decisions', async () => {
    const session = new FakeSession();
    const opaqueClaim = { malformed: ['future-owner'] };
    session.agentState.requests.claimed = {
      tool: 'readTextFile',
      arguments: { path: '/tmp/reserved' },
      createdAt: 1,
      permissionResponseClaimV1: opaqueClaim,
    };
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');

    expect(handler.getImmediateDecision('claimed', 'readTextFile', { path: '/tmp/reserved' })).toBeNull();
    await expect(handler.handleToolCall('claimed', 'readTextFile', { path: '/tmp/reserved' })).rejects.toThrow(/reserved/i);

    const retained = session.agentState.requests.claimed as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
    expect(retained.permissionResponseClaimV1).toBe(opaqueClaim);
    expect(session.agentState.completedRequests.claimed).toBeUndefined();
  });

  it('resolves every duplicate same-id waiter from one permission response', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const input = { command: 'echo hello' };

    const first = handler.handleToolCall('perm-duplicate', 'bash', input);
    const second = handler.handleToolCall('perm-duplicate', 'bash', input);

    expect(Object.keys(session.agentState.requests)).toEqual(['perm-duplicate']);

    const respond = session.rpcHandlerManager.handlers.get('permission');
    expect(respond).toBeTruthy();
    await respond?.({ id: 'perm-duplicate', approved: true, decision: 'approved' });

    await expect(second).resolves.toEqual({ decision: 'approved' });
    expect(await settledState(first)).toBe('fulfilled');
    await expect(first).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['perm-duplicate']).toBeFalsy();
    expect(session.agentState.completedRequests['perm-duplicate']).toMatchObject({
      tool: 'bash',
      status: 'approved',
      decision: 'approved',
    });
  });

  it('rejects every duplicate same-id waiter when the session is explicitly aborted', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    const input = { command: 'pwd' };

    const first = handler.handleToolCall('perm-abort-duplicate', 'bash', input);
    const second = handler.handleToolCall('perm-abort-duplicate', 'bash', input);

    expect(Object.keys(session.agentState.requests)).toEqual(['perm-abort-duplicate']);

    const acpHandler: AcpPermissionHandler = handler;
    expect(acpHandler.abortPendingRequestsAndFlush).toBeTypeOf('function');
    if (!acpHandler.abortPendingRequestsAndFlush) throw new Error('abortPendingRequestsAndFlush is not exposed');
    await expect(acpHandler.abortPendingRequestsAndFlush('Aborted by user')).resolves.toBeUndefined();

    await expect(second).rejects.toThrow('Aborted by user');
    expect(await settledState(first)).toBe('rejected');
    await expect(first).rejects.toThrow('Aborted by user');
    expect(session.agentState.requests['perm-abort-duplicate']).toBeFalsy();
    expect(session.agentState.completedRequests['perm-abort-duplicate']).toMatchObject({
      tool: 'bash',
      status: 'canceled',
      reason: 'Aborted by user',
      decision: 'abort',
    });
  });

  it('terminalizes pending requests as aborts when the session is explicitly aborted', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    const pending = handler.handleToolCall('perm-abort-1', 'bash', { command: 'pwd' });
    expect(session.agentState.requests['perm-abort-1']).toBeTruthy();

    const acpHandler: AcpPermissionHandler = handler;
    expect(acpHandler.abortPendingRequestsAndFlush).toBeTypeOf('function');
    if (!acpHandler.abortPendingRequestsAndFlush) throw new Error('abortPendingRequestsAndFlush is not exposed');
    await expect(acpHandler.abortPendingRequestsAndFlush('Aborted by user')).resolves.toBeUndefined();

    await expect(pending).rejects.toThrow('Aborted by user');
    expect(session.agentState.requests['perm-abort-1']).toBeFalsy();
    expect(session.agentState.completedRequests['perm-abort-1']).toMatchObject({
      tool: 'bash',
      status: 'canceled',
      reason: 'Aborted by user',
      decision: 'abort',
    });
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
});
