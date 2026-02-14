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
});
