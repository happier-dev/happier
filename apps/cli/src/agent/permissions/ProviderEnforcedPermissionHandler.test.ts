import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    await expect(handler.handleToolCall('mcp__happier__change_title-1', 'other', {})).resolves.toEqual({ decision: 'approved' });

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

  it('still prompts provider-enforced tool requests in bypassPermissions mode', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });

    handler.setPermissionMode('bypassPermissions');

    const pending = handler.handleToolCall('perm-1', 'bash', { command: 'echo hello' });

    expect(session.agentState.requests['perm-1']).toBeTruthy();
    const respond = session.rpcHandlerManager.handlers.get('permission');
    expect(respond).toBeTruthy();
    await respond?.({ id: 'perm-1', approved: true, decision: 'approved' });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['perm-1']).toBeFalsy();
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

    await expect(
      (handler as unknown as { abortPendingRequestsAndFlush: (reason?: string) => Promise<void> }).abortPendingRequestsAndFlush('Aborted by user'),
    ).resolves.toBeUndefined();

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

    await expect(
      (handler as unknown as { abortPendingRequestsAndFlush: (reason?: string) => Promise<void> }).abortPendingRequestsAndFlush('Aborted by user'),
    ).resolves.toBeUndefined();

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
