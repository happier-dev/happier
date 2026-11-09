import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BasePermissionHandler, type PermissionResult } from './BasePermissionHandler';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import { withToolTraceFile } from '@/testkit/logger/toolTraceFile';
import { ServerBoundPermissionRpcHandlerManager } from './testkit/serverBoundPermissionRpcHandlerManager';

class FakeSession {
    sessionId = 'test-session-id';
    rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
    agentState: any = { requests: {}, completedRequests: {} };

    updateAgentState(updater: any) {
        this.agentState = updater(this.agentState);
        return this.agentState;
    }

    getAgentStateSnapshot() {
        return this.agentState;
    }
}

class TestPermissionHandler extends BasePermissionHandler {
    protected getLogPrefix(): string {
        return '[Test]';
    }

    request(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
            this.addPendingRequestToState(toolCallId, toolName, input);
        });
    }

    requestPrivate(input: unknown, traceSummary?: { kind?: string; id?: string; mode?: string; itemCount?: number; optionCount?: number }) {
        return this.requestPermissionDecision('private-dialog', 'AskUserQuestion', input, {
            source: 'custom_native_dialog', traceSummary,
        });
    }
}

describe('BasePermissionHandler tool trace', () => {
  afterEach(() => {
    __resetToolTraceForTests();
  });

  it.each([undefined, { kind: 'recognized', id: 'native_dialog', mode: 'notice', itemCount: 1, optionCount: 2 }])(
    'traces only producer-supplied safe facts for a private native dialog (%j)', async (traceSummary) => {
      await withToolTraceFile('happy-tool-trace-private-dialog-', async (filePath) => {
        const session = new FakeSession();
        const handler = new TestPermissionHandler(session as never, {
          toolTrace: () => ({ protocol: 'native', agent: { pluginId: 'acme.agents', localId: 'custom' } }),
        });
        const pending = handler.requestPrivate({ questions: [{ question: 'private-secret', options: ['secret-choice'] }] }, traceSummary);
        const raw = readFileSync(filePath, 'utf8');
        expect(raw).not.toContain('private-secret');
        expect(raw).not.toContain('secret-choice');
        expect(JSON.parse(raw.trim()).payload.options.input).toEqual({ redacted: true, ...traceSummary });
        await session.rpcHandlerManager.handlers.get('permission')?.({ id: 'private-dialog', approved: false, decision: 'denied' });
        await pending;
      });
    },
  );

  it('records permission-request events when tool tracing is enabled', async () => {
    await withToolTraceFile('happy-tool-trace-permissions-', async (filePath) => {
      const session = new FakeSession();
      const handler = new TestPermissionHandler(session as any, {
        toolTrace: () => ({ protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } }),
      } as any);

      const pending = handler.request('perm-1', 'bash', { command: ['bash', '-lc', 'echo hello'] });

      expect(existsSync(filePath)).toBe(true);
      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        v: 2,
        direction: 'outbound',
        sessionId: 'test-session-id',
        source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        kind: 'permission-request',
        payload: expect.objectContaining({
          type: 'permission-request',
          permissionId: 'perm-1',
          toolName: 'bash',
        }),
      });

      const rpcHandler = session.rpcHandlerManager.handlers.get('permission');
      expect(rpcHandler).toBeDefined();
      await rpcHandler?.({ id: 'perm-1', approved: false, decision: 'denied' });
      await pending;
    });
  });

  it('records permission-response events when a permission is resolved', async () => {
    await withToolTraceFile('happy-tool-trace-permissions-', async (filePath) => {
      const session = new FakeSession();
      const handler = new TestPermissionHandler(session as any, {
        toolTrace: () => ({ protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } }),
      } as any);

      const pending = handler.request('perm-1', 'bash', { command: ['bash', '-lc', 'echo hello'] });
      const rpcHandler = session.rpcHandlerManager.handlers.get('permission');
      expect(rpcHandler).toBeDefined();

      await rpcHandler?.({ id: 'perm-1', approved: true, decision: 'approved' });
      await pending;

      expect(existsSync(filePath)).toBe(true);
      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1])).toMatchObject({
        v: 2,
        direction: 'inbound',
        sessionId: 'test-session-id',
        source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        kind: 'permission-response',
        payload: {
          type: 'permission-response',
          permissionId: 'perm-1',
          approved: true,
          decision: 'approved',
        },
      });
    });
  });
});
