import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexLikePermissionHandler } from './CodexLikePermissionHandler';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(_name: string, handler: any) {
    this.handlers.set(_name, handler);
  }
}

class FakeSession {
  sessionId = 'test-session-id';
  rpcHandlerManager = new FakeRpcHandlerManager();
  agentState: any = { requests: {}, completedRequests: {} };
  metadata: Record<string, unknown> = {};

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  getMetadataSnapshot() {
    return this.metadata;
  }
}

describe('CodexLikePermissionHandler tool trace', () => {
  afterEach(() => {
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    __resetToolTraceForTests();
  });

  it('records permission-request events when enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-codexlike-'));
    const filePath = join(dir, 'tool-trace.jsonl');
    process.env.HAPPIER_STACK_TOOL_TRACE = '1';
    process.env.HAPPIER_STACK_TOOL_TRACE_FILE = filePath;

    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({
      session: session as any,
      logPrefix: '[TestCodexLike]',
      toolTrace: { protocol: 'acp', provider: 'codex' },
    });

    void handler.handleToolCall('perm-1', 'writeTextFile', { path: '/tmp/file.txt', bytes: 1 });

    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      v: 1,
      direction: 'outbound',
      sessionId: 'test-session-id',
      protocol: 'acp',
      provider: 'codex',
      kind: 'permission-request',
      payload: expect.objectContaining({
        type: 'permission-request',
        permissionId: 'perm-1',
        toolName: 'writeTextFile',
      }),
    });
  });
});
