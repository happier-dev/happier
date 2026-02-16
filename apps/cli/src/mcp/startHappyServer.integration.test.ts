import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentBackend } from '@/agent/core/AgentBackend';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { startHappyServer, type HappyMcpSessionClient } from '@/mcp/startHappyServer';

function createStaticBackend(responseText: string): AgentBackend {
  const handlers = new Set<(msg: any) => void>();
  let fullText = '';

  return {
    async startSession() {
      return { sessionId: 'child_sess_1' };
    },
    async sendPrompt(_sessionId, _prompt) {
      fullText = responseText;
      for (const h of handlers) h({ type: 'model-output', fullText });
    },
    async cancel() {},
    onMessage(handler) {
      handlers.add(handler);
    },
    async dispose() {
      handlers.clear();
    },
  };
}

function parseMcpJsonText(result: any): any {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Missing MCP text response');
  }
  return JSON.parse(text);
}

describe('startHappyServer (MCP integration)', () => {
  it('exposes execution_run_* tools and can start/get/action a review run over HTTP transport', async () => {
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];

    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    registerExecutionRunHandlers(rpcHandlerManager, {
      sessionId: 'sess_mcp_1',
      cwd: process.cwd(),
      parentProvider: 'claude',
      createBackend: () =>
        createStaticBackend(
          JSON.stringify({
            findings: [
              { id: 'f1', title: 'Example', severity: 'low', category: 'style', summary: 'One paragraph.' },
            ],
            summary: 'Summary.',
          }),
        ),
      sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
        sent.push({ body, meta: opts?.meta }),
    });

    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_1',
      rpcHandlerManager,
      // Not used by this test, but required by the MCP server for change_title.
      sendClaudeSessionMessage: () => {},
    };

    const server = await startHappyServer(fakeClient);
    try {
      const client = new Client({ name: 'mcp-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const tools = await client.listTools();
      const names = new Set((tools.tools ?? []).map((t: any) => String(t.name)));
      expect(names.has('action_spec_list')).toBe(true);
      expect(names.has('action_spec_get')).toBe(true);
      expect(names.has('review_start')).toBe(true);
      expect(names.has('plan_start')).toBe(true);
      expect(names.has('delegate_start')).toBe(true);
      expect(names.has('execution_run_start')).toBe(true);
      expect(names.has('execution_run_get')).toBe(true);
      expect(names.has('execution_run_action')).toBe(true);

      const startedRaw = await client.callTool({
        name: 'execution_run_start',
        arguments: {
          intent: 'review',
          backendId: 'claude',
          instructions: 'Review.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
      });
      const started = parseMcpJsonText(startedRaw);
      expect(String(started.runId)).toMatch(/^run_/);

      const gotNoStructuredRaw = await client.callTool({
        name: 'execution_run_get',
        arguments: { runId: started.runId },
      });
      const gotNoStructured = parseMcpJsonText(gotNoStructuredRaw);
      expect(gotNoStructured.run?.runId).toBe(started.runId);
      expect(gotNoStructured.structuredMeta).toBeUndefined();

      const gotStructuredRaw = await client.callTool({
        name: 'execution_run_get',
        arguments: { runId: started.runId, includeStructured: true },
      });
      const gotStructured = parseMcpJsonText(gotStructuredRaw);
      expect(gotStructured.structuredMeta?.kind).toBe('review_findings.v1');
      expect(gotStructured.structuredMeta?.payload?.runRef?.runId).toBe(started.runId);

      const actionRaw = await client.callTool({
        name: 'execution_run_action',
        arguments: {
          runId: started.runId,
          actionId: 'review.triage',
          input: { findings: [{ id: 'f1', status: 'accept' }] },
        },
      });
      const action = parseMcpJsonText(actionRaw);
      expect(action.ok).toBe(true);

      // Verify the run emitted tool-call/tool-result into transcript (via sendAcp).
      expect(sent.some((m) => (m.body as any)?.type === 'tool-call')).toBe(true);
      expect(sent.some((m) => (m.body as any)?.type === 'tool-result')).toBe(true);
    } finally {
      server.stop();
    }
  });

  it('hides disabled action-spec tools and rejects action_spec_get for disabled actions', async () => {
    const prev = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['mcp'], disabledPlacements: [] },
      },
    });

    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_disabled_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    registerExecutionRunHandlers(rpcHandlerManager, {
      sessionId: 'sess_mcp_disabled_1',
      cwd: process.cwd(),
      parentProvider: 'claude',
      createBackend: () => createStaticBackend(JSON.stringify({ ok: true })),
      sendAcp: () => {},
    });

    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_disabled_1',
      rpcHandlerManager,
      sendClaudeSessionMessage: () => {},
    };

    const server = await startHappyServer(fakeClient);
    try {
      const client = new Client({ name: 'mcp-test-disabled', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const tools = await client.listTools();
      const names = new Set((tools.tools ?? []).map((t: any) => String(t.name)));
      expect(names.has('review_start')).toBe(false);
      expect(names.has('plan_start')).toBe(true);

      const got = await client.callTool({
        name: 'action_spec_get',
        arguments: { id: 'review.start' },
      });
      const parsed = parseMcpJsonText(got);
      expect(parsed.errorCode).toBe('action_disabled');
    } finally {
      server.stop();
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = prev;
    }
  });

  it('allows multiple independent MCP clients to connect without sharing transport initialization state', async () => {
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_seq_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    registerExecutionRunHandlers(rpcHandlerManager, {
      sessionId: 'sess_mcp_seq_1',
      cwd: process.cwd(),
      parentProvider: 'claude',
      createBackend: () => createStaticBackend(JSON.stringify({ ok: true })),
      sendAcp: () => {},
    });

    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_seq_1',
      rpcHandlerManager,
      sendClaudeSessionMessage: () => {},
    };

    const server = await startHappyServer(fakeClient);
    try {
      const clientA = new Client({ name: 'mcp-test-a', version: '1.0.0' }, { capabilities: {} });
      const clientB = new Client({ name: 'mcp-test-b', version: '1.0.0' }, { capabilities: {} });

      await clientA.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const toolsA = await clientA.listTools();
      const namesA = new Set((toolsA.tools ?? []).map((t: any) => String(t.name)));
      expect(namesA.has('execution_run_start')).toBe(true);

      await clientB.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const toolsB = await clientB.listTools();
      const namesB = new Set((toolsB.tools ?? []).map((t: any) => String(t.name)));
      expect(namesB.has('execution_run_start')).toBe(true);

      await (clientA as any).close?.();
      await (clientB as any).close?.();
    } finally {
      server.stop();
    }
  });
});
