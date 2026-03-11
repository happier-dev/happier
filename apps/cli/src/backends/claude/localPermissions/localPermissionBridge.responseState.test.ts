import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPermissionHandlerSessionStub } from '../utils/permissionHandler.testkit';
import { ClaudeLocalPermissionBridge } from './localPermissionBridge';

describe('ClaudeLocalPermissionBridge (response state)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-approves pending requests immediately when a permission response switches mode to yolo', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-yolo-via-response');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a.txt' },
      tool_use_id: 'toolu_mode_1',
    });

    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/b.txt' },
      tool_use_id: 'toolu_mode_2',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_mode_1).toBeDefined();
    expect(client.agentState.requests.toolu_mode_2).toBeDefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_mode_1', approved: true, mode: 'yolo' });

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });
    await expect(second).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_mode_1).toBeUndefined();
    expect(client.agentState.requests.toolu_mode_2).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_mode_1).toMatchObject({ status: 'approved', mode: 'yolo' });
    expect(client.agentState.completedRequests.toolu_mode_2).toMatchObject({ status: 'approved', mode: 'yolo' });
    bridge.dispose();
  });

  it('finalizes agentState and applies late-response side effects after in-memory pending state is lost', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-late-response');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    void bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'unset FOO; ls' },
      tool_use_id: 'toolu_late_1',
    });
    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'unset BAR; ls src' },
      tool_use_id: 'toolu_late_2',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_late_1).toBeDefined();
    expect(client.agentState.requests.toolu_late_2).toBeDefined();

    const firstPending = (bridge as any).pendingRequests.get('toolu_late_1');
    expect(firstPending).toBeDefined();
    if (firstPending?.timeout) {
      clearTimeout(firstPending.timeout);
    }
    (bridge as any).pendingRequests.delete('toolu_late_1');

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_late_1',
      approved: true,
      mode: 'yolo',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        },
      ],
    });

    await expect(second).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_late_1).toBeUndefined();
    expect(client.agentState.requests.toolu_late_2).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_late_1).toMatchObject({
      status: 'approved',
      mode: 'yolo',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        },
      ],
    });

    const third = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'unset BAZ; ls packages' },
      tool_use_id: 'toolu_late_3',
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(third).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_late_3).toBeUndefined();
    bridge.dispose();
  });

  it('allows a newer metadata snapshot to override a mode applied from a permission RPC response', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-response-mode-metadata-override');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a.txt' },
      tool_use_id: 'toolu_mode_override_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_mode_override_1', approved: true, mode: 'yolo' });
    await expect(pending).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });

    client.updateMetadata((metadata) => ({
      ...metadata,
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 123,
    }));
    await vi.advanceTimersByTimeAsync(0);

    const writeAttempt = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/a.txt', content: 'hello' },
      tool_use_id: 'toolu_mode_override_2',
    });

    expect(writeAttempt).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'deny' } },
    });
    bridge.dispose();
  });

  it('does not apply denied mode side-effects to pending or future requests', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-denied-mode');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a.txt' },
      tool_use_id: 'toolu_denied_mode_1',
    });

    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/b.txt' },
      tool_use_id: 'toolu_denied_mode_2',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_denied_mode_1',
      approved: false,
      mode: 'yolo',
      reason: 'deny despite mode payload',
    });

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'deny' } },
    });
    expect(client.agentState.requests.toolu_denied_mode_2).toBeDefined();

    const third = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/c.txt' },
      tool_use_id: 'toolu_denied_mode_3',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_denied_mode_3).toBeDefined();
    expect(client.agentState.completedRequests.toolu_denied_mode_2).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_denied_mode_3).toBeUndefined();
    bridge.dispose();
    await expect(second).resolves.toMatchObject({ suppressOutput: true });
    await expect(third).resolves.toMatchObject({ suppressOutput: true });
  });
});
