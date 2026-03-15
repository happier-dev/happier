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

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }
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
    await expect(handler.handleToolCall('mcp__happier__change_title-1', 'other', {})).resolves.toEqual({ decision: 'approved' });

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
