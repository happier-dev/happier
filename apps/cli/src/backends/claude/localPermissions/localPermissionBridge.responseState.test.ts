import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPermissionHandlerSessionStub,
  createPermissionHandlerSessionStubWithMetadata,
} from '../utils/permissionHandler.testkit';
import { ClaudeLocalPermissionBridge, DEFAULT_PROVIDER_HOOK_CEILING_MS } from './localPermissionBridge';

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

  it('keeps unrelated pending requests visible after approving one request without side effects', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-one-approval-keeps-unrelated');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/a.txt', content: 'a' },
      tool_use_id: 'toolu_single_approval_1',
    });
    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/b.txt', old_string: 'b', new_string: 'c' },
      tool_use_id: 'toolu_single_approval_2',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_single_approval_1).toBeDefined();
    expect(client.agentState.requests.toolu_single_approval_2).toBeDefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_single_approval_1', approved: true });

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(client.agentState.requests.toolu_single_approval_1).toBeUndefined();
    expect(client.agentState.requests.toolu_single_approval_2).toBeDefined();
    expect(client.agentState.completedRequests.toolu_single_approval_2).toBeUndefined();

    bridge.dispose();
    await expect(second).resolves.toMatchObject({ suppressOutput: true });
  });

  it('auto-completes only pending requests that match allowlist side effects', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-allowlist-side-effects-match-only');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'unset FOO; find .' },
      tool_use_id: 'toolu_allowlist_match_1',
    });
    const matching = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'find src -maxdepth 1' },
      tool_use_id: 'toolu_allowlist_match_2',
    });
    const unrelated = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'unset BAZ; rm -rf /tmp/keep-prompting' },
      tool_use_id: 'toolu_allowlist_unrelated_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_allowlist_match_1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    await expect(matching).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(client.agentState.requests.toolu_allowlist_match_1).toBeUndefined();
    expect(client.agentState.requests.toolu_allowlist_match_2).toBeUndefined();
    expect(client.agentState.requests.toolu_allowlist_unrelated_1).toBeDefined();
    expect(client.agentState.completedRequests.toolu_allowlist_unrelated_1).toBeUndefined();

    bridge.dispose();
    await expect(unrelated).resolves.toMatchObject({ suppressOutput: true });
  });

  it('auto-completes only pending requests that match mode side effects', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-mode-side-effects-match-only');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a.txt' },
      tool_use_id: 'toolu_mode_match_1',
    });
    const matching = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/b.txt' },
      tool_use_id: 'toolu_mode_match_2',
    });
    const writeLike = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/c.txt', content: 'c' },
      tool_use_id: 'toolu_mode_write_like_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_mode_match_1', approved: true, mode: 'safe-yolo' });

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    await expect(matching).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(client.agentState.requests.toolu_mode_match_1).toBeUndefined();
    expect(client.agentState.requests.toolu_mode_match_2).toBeUndefined();
    expect(client.agentState.requests.toolu_mode_write_like_1).toBeDefined();
    expect(client.agentState.completedRequests.toolu_mode_write_like_1).toBeUndefined();

    bridge.dispose();
    await expect(writeLike).resolves.toMatchObject({ suppressOutput: true });
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

  it('ignores older metadata snapshots after a permission RPC response updates the mode', async () => {
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

    const readAttempt = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/b.txt' },
      tool_use_id: 'toolu_mode_override_2',
    });

    expect(readAttempt).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });

    client.updateMetadata((metadata) => ({
      ...metadata,
      permissionMode: 'read-only',
      permissionModeUpdatedAt: Date.now() + 1_000,
    }));
    await vi.advanceTimersByTimeAsync(0);

    const writeAttempt = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/a.txt', content: 'hello' },
      tool_use_id: 'toolu_mode_override_3',
    });

    expect(writeAttempt).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'deny' } },
    });
    bridge.dispose();
  });

  it('returns a typed expired result for a late interactive answer after the provider hook timeout', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-interactive-expired');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const ask = bridge.handlePermissionHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }] },
      tool_use_id: 'toolu_ask_expire_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_ask_expire_1).toBeDefined();

    // No Happier timeout fires before the provider hook ceiling: still pending well past 5s.
    await vi.advanceTimersByTimeAsync(5_001);
    expect(client.agentState.requests.toolu_ask_expire_1).toBeDefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    const lateAnswer = await permissionHandler?.({
      id: 'toolu_ask_expire_1',
      approved: true,
      answers: { 'Pick a color': 'Red' },
    });

    expect(lateAnswer).toEqual({
      ok: false,
      errorCode: 'permission_request_expired',
      errorMessage: 'permission_request_expired',
      requestId: 'toolu_ask_expire_1',
    });
    expect(client.agentState.requests.toolu_ask_expire_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_ask_expire_1).toMatchObject({ status: 'canceled' });
    expect(client.agentState.completedRequests.toolu_ask_expire_1).not.toMatchObject({ status: 'approved' });

    await expect(ask).resolves.toMatchObject({ suppressOutput: true });
    bridge.dispose();
  });

  it('returns a typed expired result for a late ExitPlanMode answer after the provider hook timeout', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-exit-plan-expired');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const exit = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do the thing' },
      tool_use_id: 'toolu_exit_expire_1',
    });

    await vi.advanceTimersByTimeAsync(5_001);
    expect(client.agentState.requests.toolu_exit_expire_1).toBeDefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    const lateAnswer = await permissionHandler?.({ id: 'toolu_exit_expire_1', approved: true });

    expect(lateAnswer).toEqual({
      ok: false,
      errorCode: 'permission_request_expired',
      errorMessage: 'permission_request_expired',
      requestId: 'toolu_exit_expire_1',
    });
    expect(client.agentState.completedRequests.toolu_exit_expire_1).toMatchObject({ status: 'canceled' });
    await expect(exit).resolves.toMatchObject({ suppressOutput: true });
    bridge.dispose();
  });

  it('cancels a non-interactive PermissionRequest at the provider timeout so a late answer is not found', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-noninteractive-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const write = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/a.txt', content: 'a' },
      tool_use_id: 'toolu_write_timeout_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_write_timeout_1).toBeDefined();

    // The bridge's own waiter cancels non-interactive requests at the provider timeout.
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(write).resolves.toMatchObject({ suppressOutput: true });
    expect(client.agentState.completedRequests.toolu_write_timeout_1).toMatchObject({ status: 'canceled' });

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    const lateAnswer = await permissionHandler?.({ id: 'toolu_write_timeout_1', approved: true });
    expect(lateAnswer).toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      requestId: 'toolu_write_timeout_1',
    });
    bridge.dispose();
  });

  it('keeps no Happier timeout for an interactive answer delivered before the provider hook ceiling', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-interactive-in-window');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const ask = bridge.handlePermissionHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }] },
      tool_use_id: 'toolu_ask_in_window_1',
    });

    await vi.advanceTimersByTimeAsync(4_000);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    const inWindow = await permissionHandler?.({
      id: 'toolu_ask_in_window_1',
      approved: true,
      answers: { 'Pick a color': 'Blue' },
    });

    expect(inWindow).toEqual({ ok: true });
    await expect(ask).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { answers: { 'Pick a color': 'Blue' } },
      },
    });
    expect(client.agentState.completedRequests.toolu_ask_in_window_1).toMatchObject({ status: 'approved' });
    bridge.dispose();
  });

  it('reconciles ExitPlanMode approval into a setMode hook update and clears plan metadata', async () => {
    const { session, client } = createPermissionHandlerSessionStubWithMetadata({
      sessionId: 'session-exit-plan',
      metadata: { sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } },
    });
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const exit = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do the thing' },
      tool_use_id: 'toolu_exit_plan_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({ id: 'toolu_exit_plan_1', approved: true });

    await expect(exit).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'default' }],
        },
      },
    });
    expect(client.getMetadataSnapshot().sessionModeOverrideV1).toMatchObject({ modeId: null });
    bridge.dispose();
  });

  it('uses the requested follow-up mode for ExitPlanMode setMode reconciliation', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-exit-plan-mode');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const exit = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do the thing' },
      tool_use_id: 'toolu_exit_plan_mode_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({ id: 'toolu_exit_plan_mode_1', approved: true, mode: 'yolo' });

    await expect(exit).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }],
        },
      },
    });
    bridge.dispose();
  });

  it('respects caller-provided updatedPermissions for ExitPlanMode instead of synthesizing setMode', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-exit-plan-explicit');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const exit = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do the thing' },
      tool_use_id: 'toolu_exit_plan_explicit_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({
      id: 'toolu_exit_plan_explicit_1',
      approved: true,
      updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }],
    });

    await expect(exit).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }],
        },
      },
    });
    bridge.dispose();
  });

  it('never auto-completes an interactive pending request when a mode switch resolves non-interactive ones', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-interactive-isolation');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const ask = bridge.handlePermissionHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Pick', options: ['A', 'B'] }] },
      tool_use_id: 'toolu_iso_ask_1',
    });
    const read = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a.txt' },
      tool_use_id: 'toolu_iso_read_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({ id: 'toolu_iso_read_1', approved: true, mode: 'yolo' });

    await expect(read).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(client.agentState.requests.toolu_iso_read_1).toBeUndefined();
    expect(client.agentState.requests.toolu_iso_ask_1).toBeDefined();
    expect(client.agentState.completedRequests.toolu_iso_ask_1).toBeUndefined();

    bridge.dispose();
    await expect(ask).resolves.toMatchObject({ suppressOutput: true });
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

  describe('provider hook ceiling under wait-indefinitely', () => {
    // Regression for the stuck-session bug (session cmq9hemcs / provider 20b9e29f): with the default
    // `waitIndefinitely` configuration the bridge had no finite `responseTimeoutMs`, so it never expired a
    // pending request — yet Claude still kills the permission hook forwarder at its installed 600s ceiling.
    // A UI answer arriving past that ceiling was finalized `approved` into a dead socket, leaving the session
    // stuck. The provider hook ceiling must expire the request regardless of `waitIndefinitely`.
    //
    // The default ceiling is now effectively unlimited (7 days) and aligned with the installed hook
    // `timeout` (`generateHookSettings` `DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS`), so a user can launch
    // a session before sleeping and answer the permission on waking. Expiry only fires once the huge
    // ceiling is exceeded — i.e. the forwarder is genuinely dead — never at an artificial short timeout.
    const PROVIDER_HOOK_CEILING_MS = DEFAULT_PROVIDER_HOOK_CEILING_MS;

    it('uses the 7-day effectively-unlimited default ceiling under wait-indefinitely', () => {
      expect(PROVIDER_HOOK_CEILING_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('accepts a late answer well past the old 600s ceiling (hours later) under wait-indefinitely', async () => {
      const { session, client } = createPermissionHandlerSessionStub('session-wait-indefinitely-bash-late-accept');
      const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
      bridge.activate();

      const bash = bridge.handlePermissionHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'cat > /tmp/start-here.txt' },
        tool_use_id: 'toolu_wait_bash_late_accept_1',
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(client.agentState.requests.toolu_wait_bash_late_accept_1).toBeDefined();

      // 6 hours later — far past the old 600s ceiling, but well inside the 7-day window: still ACCEPTED.
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

      const permissionHandler = client.rpcHandlerManager.getHandler('permission');
      const lateAnswer = await permissionHandler?.({ id: 'toolu_wait_bash_late_accept_1', approved: true });

      expect(lateAnswer).toEqual({ ok: true });
      expect(client.agentState.completedRequests.toolu_wait_bash_late_accept_1).toMatchObject({ status: 'approved' });
      await expect(bash).resolves.toMatchObject({
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      });
      bridge.dispose();
    });

    it('expires a late non-interactive answer only past the huge provider hook ceiling', async () => {
      const { session, client } = createPermissionHandlerSessionStub('session-wait-indefinitely-bash-expired');
      // `responseTimeoutMs: null` mirrors the default `claudeLocalPermissionBridgeWaitIndefinitely` runtime:
      // no active Happier waiter, so the bridge never cancels the pending request on its own.
      const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
      bridge.activate();

      const bash = bridge.handlePermissionHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'cat > /tmp/start-here.txt' },
        tool_use_id: 'toolu_wait_bash_1',
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(client.agentState.requests.toolu_wait_bash_1).toBeDefined();

      // No Happier waiter fires; the request is still pending right up to the huge provider ceiling.
      await vi.advanceTimersByTimeAsync(PROVIDER_HOOK_CEILING_MS + 27_000);

      const permissionHandler = client.rpcHandlerManager.getHandler('permission');
      expect(permissionHandler).toBeDefined();
      const lateAnswer = await permissionHandler?.({ id: 'toolu_wait_bash_1', approved: true });

      expect(lateAnswer).toEqual({
        ok: false,
        errorCode: 'permission_request_expired',
        errorMessage: 'permission_request_expired',
        requestId: 'toolu_wait_bash_1',
      });
      expect(client.agentState.completedRequests.toolu_wait_bash_1).toMatchObject({ status: 'canceled' });
      expect(client.agentState.completedRequests.toolu_wait_bash_1).not.toMatchObject({ status: 'approved' });

      await expect(bash).resolves.toMatchObject({ suppressOutput: true });
      bridge.dispose();
    });

    it('still accepts an answer delivered before the provider hook ceiling under wait-indefinitely', async () => {
      const { session, client } = createPermissionHandlerSessionStub('session-wait-indefinitely-bash-in-window');
      const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
      bridge.activate();

      const bash = bridge.handlePermissionHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        tool_use_id: 'toolu_wait_bash_in_window_1',
      });

      await vi.advanceTimersByTimeAsync(PROVIDER_HOOK_CEILING_MS - 60_000);
      const permissionHandler = client.rpcHandlerManager.getHandler('permission');
      const inWindow = await permissionHandler?.({ id: 'toolu_wait_bash_in_window_1', approved: true });

      expect(inWindow).toEqual({ ok: true });
      expect(client.agentState.completedRequests.toolu_wait_bash_in_window_1).toMatchObject({ status: 'approved' });
      await expect(bash).resolves.toMatchObject({
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      });
      bridge.dispose();
    });

    it('gives interactive tools (AskUserQuestion) the same huge ceiling under wait-indefinitely', async () => {
      const { session, client } = createPermissionHandlerSessionStub('session-wait-indefinitely-ask-late-accept');
      const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
      bridge.activate();

      const ask = bridge.handlePermissionHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }] },
        tool_use_id: 'toolu_ask_late_accept_1',
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(client.agentState.requests.toolu_ask_late_accept_1).toBeDefined();

      // 6 hours later (past the old 600s ceiling) the interactive request is still answerable.
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      const permissionHandler = client.rpcHandlerManager.getHandler('permission');
      const lateAnswer = await permissionHandler?.({
        id: 'toolu_ask_late_accept_1',
        approved: true,
        answers: { 'Pick a color': 'Blue' },
      });

      expect(lateAnswer).toEqual({ ok: true });
      expect(client.agentState.completedRequests.toolu_ask_late_accept_1).toMatchObject({ status: 'approved' });
      await expect(ask).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { answers: { 'Pick a color': 'Blue' } },
        },
      });

      // And it still expires past the huge ceiling rather than approving into a dead forwarder.
      const { session: session2, client: client2 } = createPermissionHandlerSessionStub('session-wait-indefinitely-ask-expire');
      const bridge2 = new ClaudeLocalPermissionBridge(session2, { responseTimeoutMs: null });
      bridge2.activate();
      const ask2 = bridge2.handlePermissionHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }] },
        tool_use_id: 'toolu_ask_expire_ceiling_1',
      });
      await vi.advanceTimersByTimeAsync(PROVIDER_HOOK_CEILING_MS + 27_000);
      const permissionHandler2 = client2.rpcHandlerManager.getHandler('permission');
      const lateExpired = await permissionHandler2?.({
        id: 'toolu_ask_expire_ceiling_1',
        approved: true,
        answers: { 'Pick a color': 'Red' },
      });
      expect(lateExpired).toEqual({
        ok: false,
        errorCode: 'permission_request_expired',
        errorMessage: 'permission_request_expired',
        requestId: 'toolu_ask_expire_ceiling_1',
      });
      expect(client2.agentState.completedRequests.toolu_ask_expire_ceiling_1).toMatchObject({ status: 'canceled' });
      await expect(ask2).resolves.toMatchObject({ suppressOutput: true });

      bridge.dispose();
      bridge2.dispose();
    });
  });
});
