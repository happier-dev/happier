import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPermissionHandlerSessionStub } from '../utils/permissionHandler.testkit';
import { ClaudeLocalPermissionBridge } from './localPermissionBridge';

describe('ClaudeLocalPermissionBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out non-interactive requests by default when no UI response arrives', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-default-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm --version' },
      tool_use_id: 'toolu_default_timeout_1',
    });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PermissionRequest' },
    });
    expect(client.agentState.requests.toolu_default_timeout_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_default_timeout_1).toMatchObject({
      status: 'canceled',
      reason: 'Timed out waiting for permission response',
    });
  });

  it('publishes pending permission requests and resolves allow decisions', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-1');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'hello' },
      tool_use_id: 'toolu_allow_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_allow_1).toMatchObject({
      tool: 'Write',
      arguments: { file_path: '/tmp/test.txt', content: 'hello' },
    });

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_allow_1', approved: true });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_allow_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_allow_1).toMatchObject({
      status: 'approved',
      tool: 'Write',
    });
  });

  it('publishes one request for duplicate hook ids and resolves all duplicate callers after approval', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-duplicate-local-waiters');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/duplicate-local.txt', content: 'first' },
      tool_use_id: 'toolu_duplicate_local_1',
    });
    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/duplicate-local.txt', content: 'first' },
      tool_use_id: 'toolu_duplicate_local_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(client.agentState.requests)).toEqual(['toolu_duplicate_local_1']);

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_duplicate_local_1', approved: true });

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    await expect(second).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(client.agentState.requests.toolu_duplicate_local_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_duplicate_local_1).toMatchObject({
      status: 'approved',
      tool: 'Write',
    });
  });

  it('does not let the first duplicate waiter timeout cancel a newer duplicate waiter', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-duplicate-local-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 200 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/duplicate-timeout.txt', content: 'first' },
      tool_use_id: 'toolu_duplicate_timeout_1',
    });
    let firstResolved = false;
    first.then(() => {
      firstResolved = true;
    });

    await vi.advanceTimersByTimeAsync(199);

    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/duplicate-timeout.txt', content: 'first' },
      tool_use_id: 'toolu_duplicate_timeout_1',
    });
    let secondResolved = false;
    second.then(() => {
      secondResolved = true;
    });

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(false);
    expect(client.agentState.requests.toolu_duplicate_timeout_1).toBeDefined();
    expect(client.agentState.completedRequests.toolu_duplicate_timeout_1).toBeUndefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_duplicate_timeout_1', approved: true });
    await expect(second).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
  });

  it('ignores permission RPCs for requests without the local bridge source marker', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-local-source-guard');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    client.updateAgentState((current) => ({
      ...current,
      requests: {
        ...current.requests,
        toolu_remote_owned_1: {
          tool: 'Read',
          kind: 'permission',
          arguments: { file_path: '/tmp/remote-owned.txt' },
          createdAt: Date.now(),
        },
      },
    }));

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_remote_owned_1',
      approved: true,
      mode: 'yolo',
      allowedTools: ['Read(/tmp/remote-owned.txt)'],
    });

    expect(client.agentState.requests.toolu_remote_owned_1).toBeDefined();
    expect(client.agentState.completedRequests.toolu_remote_owned_1).toBeUndefined();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/still-requires-local-prompt.txt', content: 'hello' },
      tool_use_id: 'toolu_after_remote_rpc_1',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(client.agentState.requests.toolu_after_remote_rpc_1).toBeDefined();
    bridge.dispose();
    await expect(pending).resolves.toMatchObject({
      hookSpecificOutput: { hookEventName: 'PermissionRequest' },
    });
  });

  it('includes updatedPermissions in allow hook responses when supplied by the UI', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-updated-permissions');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do things' },
      tool_use_id: 'toolu_allow_updates_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_allow_updates_1',
      approved: true,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        },
      },
    });

    expect(client.agentState.completedRequests.toolu_allow_updates_1).toMatchObject({
      status: 'approved',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });

  it('auto-approves non-interactive tools immediately when permissionMode=yolo in metadata', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-yolo-auto-approve');
    client.updateMetadata((m) => ({ ...m, permissionMode: 'yolo', permissionModeUpdatedAt: 123 }));

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const res = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'mcp__happier__change_title',
      tool_input: { title: 'QA Agent Team Setup' },
      tool_use_id: 'toolu_yolo_1',
    });

    expect(res).toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_yolo_1).toBeUndefined();
  });

  it('auto-approves session title tools immediately in default mode', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-default-title-auto-approve');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const res = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Set session title',
      tool_input: { title: 'QA Agent Team Setup' },
      tool_use_id: 'toolu_default_title_1',
    });

    expect(res).toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_default_title_1).toBeUndefined();
  });

  it('publishes Happier execution-run MCP tools as normal permission requests in default mode', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-default-execution-run-permission-request');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'mcp__happier__execution_run_start',
      tool_input: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        instructions: 'Reply exactly QA_CODEX_READY.',
      },
      tool_use_id: 'toolu_execution_run_start_default_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_execution_run_start_default_1).toMatchObject({
      tool: 'mcp__happier__execution_run_start',
    });

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_execution_run_start_default_1', approved: true });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_execution_run_start_default_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_execution_run_start_default_1).toMatchObject({
      status: 'approved',
      tool: 'mcp__happier__execution_run_start',
    });
  });

  it('auto-approves a pending request when metadata permissionMode flips to yolo', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-yolo-auto-approve-pending');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/qa-agent-team-setup.txt', content: 'hello' },
      tool_use_id: 'toolu_yolo_pending_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_yolo_pending_1).toBeDefined();

    client.updateMetadata((m) => ({ ...m, permissionMode: 'yolo', permissionModeUpdatedAt: 456 }));
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_yolo_pending_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_yolo_pending_1).toMatchObject({ status: 'approved' });
  });

  it('hard-denies new write-like permission hooks immediately when permissionMode=read-only in metadata', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-read-only-immediate-deny');
    client.updateMetadata((m) => ({ ...m, permissionMode: 'read-only', permissionModeUpdatedAt: 123 }));

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const res = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'hello' },
      tool_use_id: 'toolu_read_only_1',
    });

    expect(res).toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny' },
      },
    });
    expect(client.agentState.requests.toolu_read_only_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_read_only_1).toMatchObject({
      status: 'denied',
      tool: 'Write',
      mode: 'read-only',
    });
  });

  it('hard-denies a pending write-like request when metadata permissionMode flips to read-only', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-read-only-pending-deny');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'hello' },
      tool_use_id: 'toolu_read_only_pending_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_read_only_pending_1).toBeDefined();

    client.updateMetadata((m) => ({ ...m, permissionMode: 'read-only', permissionModeUpdatedAt: 456 }));
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny' },
      },
    });
    expect(client.agentState.requests.toolu_read_only_pending_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_read_only_pending_1).toMatchObject({
      status: 'denied',
      tool: 'Write',
      mode: 'read-only',
    });
  });

  it('captures permission_suggestions from hook payloads into agentState requests', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-suggestions');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/file.txt' },
      tool_use_id: 'toolu_suggest_1',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    } as any);

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_suggest_1).toMatchObject({
      tool: 'Read',
      permissionSuggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });

  it('maps deny decisions from RPC responses to hook deny responses', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-2');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/x' },
      tool_use_id: 'toolu_deny_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({
      id: 'toolu_deny_1',
      approved: false,
      reason: 'Denied from UI',
    });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied from UI' },
      },
      systemMessage: 'Denied from UI',
    });
    expect(client.agentState.completedRequests.toolu_deny_1).toMatchObject({
      status: 'denied',
      reason: 'Denied from UI',
    });
  });

  it('auto-allows new permission hooks after a session allowlist update', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-auto-allow');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'unset FOO; find .' },
      tool_use_id: 'toolu_allowlist_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_allowlist_1).toBeDefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_allowlist_1',
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
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });

    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'unset BAR; find src -maxdepth 1' },
      tool_use_id: 'toolu_allowlist_2',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_allowlist_2).toBeUndefined();
    await expect(second).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });
  });

  it('times out to ask and marks the request as canceled', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-3');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 200 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a.txt' },
      tool_use_id: 'toolu_timeout_1',
    });

    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PermissionRequest' },
    });
    expect(client.agentState.requests.toolu_timeout_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_timeout_1).toMatchObject({
      status: 'canceled',
    });
  });

  it('does not time out interactive AskUserQuestion requests even when the bridge has a finite timeout', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-ask-user-question-no-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 200 });
    bridge.activate();

    let resolved = false;
    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            header: 'File write',
            question: 'May I create the file /tmp/qa.txt?',
            multiSelect: false,
            options: [
              { label: 'Yes, go ahead', description: 'Create the file' },
              { label: `No, don't create it`, description: 'Skip file creation' },
            ],
          },
        ],
      },
      tool_use_id: 'toolu_ask_1',
    });
    pending.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(false);
    expect(client.agentState.requests.toolu_ask_1).toMatchObject({
      tool: 'AskUserQuestion',
    });
    // Freeform escape hatch: agent-state copy of the request exposes
    // `freeform: {}` on every question so the mobile UI surfaces its own
    // localized text-input fallback (mirrors Claude's native "Other" in CLI).
    // Happier's bridge synthesizes this because Claude's AskUserQuestion tool
    // schema has no freeform field of its own.
    const publishedArguments = (client.agentState.requests.toolu_ask_1 as any)?.arguments;
    expect(publishedArguments?.questions?.[0]?.freeform).toEqual({});
    expect(client.agentState.completedRequests.toolu_ask_1).toBeUndefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_ask_1',
      approved: true,
      answers: { 'May I create the file /tmp/qa.txt?': 'Yes, go ahead' },
    });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: {
            questions: [
              {
                header: 'File write',
                question: 'May I create the file /tmp/qa.txt?',
                multiSelect: false,
                options: [
                  { label: 'Yes, go ahead', description: 'Create the file' },
                  { label: `No, don't create it`, description: 'Skip file creation' },
                ],
              },
            ],
            answers: { 'May I create the file /tmp/qa.txt?': 'Yes, go ahead' },
          },
        },
      },
    });
    expect(client.agentState.completedRequests.toolu_ask_1).toMatchObject({
      status: 'approved',
      tool: 'AskUserQuestion',
    });
  });

  it('waits indefinitely when responseTimeoutMs is null', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-infinite-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();

    let resolved = false;
    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm --version' },
      tool_use_id: 'toolu_infinite_1',
    });
    pending.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(resolved).toBe(false);
    expect(client.agentState.requests.toolu_infinite_1).toBeDefined();
  });

  it('generates a request id when tool_use_id is missing', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-4');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm --version' },
    });

    await vi.advanceTimersByTimeAsync(0);
    const pendingIds = Object.keys(client.agentState.requests);
    expect(pendingIds).toHaveLength(1);

    const [generatedId] = pendingIds;
    expect(typeof generatedId).toBe('string');
    expect(generatedId.length).toBeGreaterThan(0);
    expect(client.agentState.requests[generatedId]).toMatchObject({
      tool: 'Bash',
      arguments: { command: 'npm --version' },
    });

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({ id: generatedId, approved: true });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.completedRequests[generatedId]).toMatchObject({
      status: 'approved',
      tool: 'Bash',
    });
  });

  it('recovers tool_use_id from transcript_path when missing in the hook payload', async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-perm-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    try {
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_transcript_1',
                name: 'Bash',
                input: { command: 'npm --version', description: 'Check npm version (may need permission)' },
              },
            ],
          },
        })}\n`,
        'utf8',
      );

      const { session, client } = createPermissionHandlerSessionStub('session-5');
      const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
      bridge.activate();

      const pending = bridge.handlePermissionHook({
        hook_event_name: 'PermissionRequest',
        transcript_path: transcriptPath,
        tool_name: 'Bash',
        tool_input: { command: 'npm --version', description: 'Check npm version (may need permission)' },
      });

      const waitStarted = Date.now();
      while (Object.keys(client.agentState.requests).length === 0 && Date.now() - waitStarted < 250) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      const pendingIds = Object.keys(client.agentState.requests);
      expect(pendingIds).toContain('toolu_transcript_1');
      expect(client.agentState.requests.toolu_transcript_1).toMatchObject({
        tool: 'Bash',
        arguments: { command: 'npm --version' },
      });

      const permissionHandler = client.rpcHandlerManager.getHandler('permission');
      await permissionHandler?.({ id: 'toolu_transcript_1', approved: true });

      await expect(pending).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      });
      expect(client.agentState.completedRequests.toolu_transcript_1).toMatchObject({
        status: 'approved',
        tool: 'Bash',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers tool_use_id from the session transcriptPath when transcript_path is missing in the hook payload', async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-perm-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    try {
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_transcript_2',
                name: 'Bash',
                input: { command: 'node --version' },
              },
            ],
          },
        })}\n`,
        'utf8',
      );

      const { session, client } = createPermissionHandlerSessionStub('session-6');
      (session as any).transcriptPath = transcriptPath;

      const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
      bridge.activate();

      const pending = bridge.handlePermissionHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'node --version' },
      });

      const waitStarted = Date.now();
      while (Object.keys(client.agentState.requests).length === 0 && Date.now() - waitStarted < 250) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }

      const pendingIds = Object.keys(client.agentState.requests);
      expect(pendingIds).toContain('toolu_transcript_2');

      const permissionHandler = client.rpcHandlerManager.getHandler('permission');
      await permissionHandler?.({ id: 'toolu_transcript_2', approved: true });

      await expect(pending).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts the metadata watcher when disposed', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-dispose-aborts-watcher');
    const waitSpy = vi.spyOn(client, 'waitForMetadataUpdate');

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    expect(waitSpy).toHaveBeenCalled();
    const signal = waitSpy.mock.calls[0]?.[0];
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    bridge.dispose();

    expect(signal?.aborted).toBe(true);
  });

  it('backs off after metadata watcher failures instead of spinning immediately', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-metadata-watcher-backoff');
    let calls = 0;
    const waitSpy = vi.spyOn(client, 'waitForMetadataUpdate').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return false;
      }
      return await new Promise<boolean>(() => {});
    });

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    await Promise.resolve();
    expect(waitSpy).toHaveBeenCalledTimes(1);
    const signal = waitSpy.mock.calls[0]?.[0] as AbortSignal;
    const removeSpy = vi.spyOn(signal, 'removeEventListener');

    await vi.advanceTimersByTimeAsync(25);
    expect(waitSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(waitSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    bridge.dispose();
  });
});
