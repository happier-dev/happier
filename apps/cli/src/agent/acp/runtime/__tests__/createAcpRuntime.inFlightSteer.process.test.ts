import { describe, expect, it, vi } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';

function writeSteerableAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent-steer.mjs');
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    let promptCount = 0;
    let primary = '';
    let steer = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function emitMessage(text) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'test-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        },
      });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;
        const id = req.id;
        const method = req.method;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, { sessionId: 'test-session' });
          continue;
        }

        if (method === 'session/prompt') {
          ok(id, {});

          const blocks = req?.params?.prompt;
          const text = Array.isArray(blocks) && blocks[0] && typeof blocks[0].text === 'string' ? blocks[0].text : '';
          if (promptCount === 0) {
            primary = text;
            // Hold the response open long enough for a steer to arrive.
            setTimeout(() => {
              emitMessage('primary=' + primary + '; steer=' + steer);
            }, 120);
          } else {
            steer = text;
          }
          promptCount++;
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}


/**
 * agy acp 1.5.18 steering, captured live: a second session/prompt during a running turn resolves the
 * first prompt with end_turn at once, the agent keeps working on the combined turn, and the second
 * prompt resolves when that work ends.
 */
function writeSupersedingSteerAcpAgentScript(params: { dir: string; rejectSteer?: boolean }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent-superseding-steer.mjs');
  const rejectSteer = params.rejectSteer === true;
  const src = `
    let buf = '';
    let primaryId = null;
    let primary = '';
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
    const emitMessage = (text) => send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'test-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    process.stdin.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.id === undefined || typeof req.method !== 'string') continue;
        if (req.method === 'initialize') { send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, authMethods: [] } }); continue; }
        if (req.method === 'session/new') { send({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'test-session' } }); continue; }
        if (req.method === 'session/prompt') {
          const text = req.params?.prompt?.[0]?.text ?? '';
          if (primaryId === null) { primaryId = req.id; primary = text; continue; }
          if (${JSON.stringify(rejectSteer)}) {
            send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'steer refused' } });
            setTimeout(() => send({ jsonrpc: '2.0', id: primaryId, result: { stopReason: 'end_turn' } }), 50);
            continue;
          }
          send({ jsonrpc: '2.0', id: primaryId, result: { stopReason: 'end_turn' } });
          const steerId = req.id;
          setTimeout(() => {
            emitMessage('primary=' + primary + '; steer=' + text);
            setTimeout(() => send({ jsonrpc: '2.0', id: steerId, result: { stopReason: 'end_turn' } }), 50);
          }, 400);
          continue;
        }
        send({ jsonrpc: '2.0', id: req.id, result: {} });
      }
    });
  `;
  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

/**
 * Session cmwo2s7yo03aam2ii4fqdt6ec (agy acp, 2026-11-27): the primary prompt is still running with an
 * open tool call when a steer arrives. agy answers the primary prompt with end_turn at once, closes the
 * tool call, and only starts the steered work after a quiet gap longer than the post-tool idle period,
 * asking for a permission before it answers the steer prompt.
 */
function writeSupersedingSteerWithOpenToolAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent-superseding-steer-open-tool.mjs');
  const src = `
    let buf = '';
    let primaryId = null;
    let steerId = null;
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
    const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'test-session', update: u } });
    const emitMessage = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    process.stdin.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (!req.method && req.id === 'steer-permission') {
          emitMessage('steer-work permission=' + (req.result?.outcome?.outcome ?? 'none'));
          setTimeout(() => send({ jsonrpc: '2.0', id: steerId, result: { stopReason: 'end_turn' } }), 50);
          continue;
        }
        if (req.id === undefined || typeof req.method !== 'string') continue;
        if (req.method === 'initialize') { send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, authMethods: [] } }); continue; }
        if (req.method === 'session/new') { send({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'test-session' } }); continue; }
        if (req.method === 'session/prompt') {
          if (primaryId === null) {
            primaryId = req.id;
            update({ sessionUpdate: 'tool_call', toolCallId: 'long-tool', title: 'Run command', kind: 'execute', status: 'in_progress', rawInput: { command: 'sleep' } });
            emitMessage('primary-work');
            continue;
          }
          steerId = req.id;
          send({ jsonrpc: '2.0', id: primaryId, result: { stopReason: 'end_turn' } });
          setTimeout(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'long-tool', status: 'completed' }), 30);
          setTimeout(() => send({ jsonrpc: '2.0', id: 'steer-permission', method: 'session/request_permission', params: {
            sessionId: 'test-session',
            toolCall: { toolCallId: 'steer-tool', kind: 'execute', rawInput: { command: 'pwd' } },
            options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }],
          } }), 600);
          continue;
        }
        send({ jsonrpc: '2.0', id: req.id, result: {} });
      }
    });
  `;
  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

/**
 * Session cmwrc65fsxshtm23v0gbpvkgx (agy acp 1.5.18, 2026-11-28): a steer arrives while the running
 * prompt is about to wait for a permission answer. agy rejects only the steer prompt with a JSON-RPC
 * error and keeps the original turn running: it asks for later permissions and answers the primary
 * prompt when its work ends.
 */
function writeSteerRejectedDuringPermissionAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent-steer-rejected-during-permission.mjs');
  const src = `
    let buf = '';
    let primaryId = null;
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
    const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'test-session', update: u } });
    const emitMessage = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const requestPermission = (id, toolCallId) => send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
      sessionId: 'test-session',
      toolCall: { toolCallId, kind: 'execute', rawInput: { command: 'pwd' } },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }],
    } });
    process.stdin.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (!req.method && req.id === 'perm-1') {
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-b', status: 'completed' });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-a', status: 'completed' });
          setTimeout(() => requestPermission('perm-2', 'tool-c'), 50);
          continue;
        }
        if (!req.method && req.id === 'perm-2') {
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-c', status: 'completed' });
          emitMessage('later permission=' + (req.result?.outcome?.outcome ?? 'none'));
          setTimeout(() => send({ jsonrpc: '2.0', id: primaryId, result: { stopReason: 'end_turn' } }), 50);
          continue;
        }
        if (req.id === undefined || typeof req.method !== 'string') continue;
        if (req.method === 'initialize') { send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, authMethods: [] } }); continue; }
        if (req.method === 'session/new') { send({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'test-session' } }); continue; }
        if (req.method === 'session/prompt') {
          if (primaryId === null) {
            primaryId = req.id;
            update({ sessionUpdate: 'tool_call', toolCallId: 'tool-a', title: 'Run command', kind: 'execute', status: 'in_progress', rawInput: { command: 'sleep' } });
            emitMessage('primary-work');
            continue;
          }
          update({ sessionUpdate: 'tool_call', toolCallId: 'tool-b', title: 'Run command', kind: 'execute', status: 'pending', rawInput: { command: 'pwd' } });
          requestPermission('perm-1', 'tool-b');
          send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'running prompt is waiting for a permission or question answer' } });
          continue;
        }
        send({ jsonrpc: '2.0', id: req.id, result: {} });
      }
    });
  `;
  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('createAcpRuntime (in-flight steer, real process)', () => {
  it('routes an exact steer ACK through the typed singleton outcome bridge without broad settlement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-steer-proc-'));
    const scriptPath = writeSteerableAcpAgentScript({ dir });

    const backend = new AcpBackend({
      agentName: 'test',
      cwd: dir,
      command: process.execPath,
      args: [scriptPath],
	      transportHandler: {
	        agentName: 'test',
	        getInitTimeout: () => 1_000,
	        getToolPatterns: () => [] as ToolPattern[],
	        // Keep the prompt "in flight" long enough for the chunk to arrive before the backend's
	        // post-prompt "no updates" idle fallback fires.
	        getIdleTimeout: () => 250,
	      } satisfies TransportHandler,
	    });

    const sent: Array<{ type: string; [k: string]: unknown }> = [];
    const session = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendAgentMessageCommitted: async (_provider: string, msg: any) => {
        sent.push(msg);
      },
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    } as any;

    try {
      const waitForMessage = async (): Promise<{ type: string; [k: string]: unknown } | null> => {
        const deadlineMs = Date.now() + 2_000;
        while (Date.now() < deadlineMs) {
          const found = sent.find((m) => m.type === 'message' && typeof (m as any)?.message === 'string');
          if (found) return found;
          await new Promise((r) => setTimeout(r, 10));
        }
        return null;
      };

      const runtime = createAcpRuntime({
        provider: 'codex',
        directory: dir,
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        ensureBackend: async () => backend as any,
        inFlightSteer: { enabled: true },
      } as any);

      runtime.beginTurn();
      await (runtime as any).startOrLoad({});

      const primaryPromise = (runtime as any).sendPrompt('hello');
      await new Promise((r) => setTimeout(r, 10));

      await (runtime as any).steerPrompt('steer-now', {
        localId: 'local-steer-1',
        userMessageSeq: 41,
      });
      await primaryPromise;
      await runtime.flushTurn();

      const message = await waitForMessage();
      expect(message).not.toBeNull();
      expect((message as any)?.message).toContain('primary=hello');
      expect((message as any)?.message).toContain('steer=steer-now');
    } finally {
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('publishes work that continues after a steer resolves the primary prompt early', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-steer-supersede-'));
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: dir,
      command: process.execPath,
      args: [writeSupersedingSteerAcpAgentScript({ dir })],
      transportHandler: {
        agentName: 'test',
        getInitTimeout: () => 1_000,
        getToolPatterns: () => [] as ToolPattern[],
        getIdleTimeout: () => 250,
      } satisfies TransportHandler,
    });
    const sent: Array<{ type: string; [k: string]: unknown }> = [];
    const session = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendAgentMessageCommitted: async (_provider: string, msg: any) => { sent.push(msg); },
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    } as any;
    try {
      const runtime = createAcpRuntime({
        provider: 'codex',
        directory: dir,
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        ensureBackend: async () => backend as any,
        inFlightSteer: { enabled: true },
      } as any);
      runtime.beginTurn();
      await (runtime as any).startOrLoad({});
      const primaryPromise = (runtime as any).sendPrompt('hello');
      await new Promise((r) => setTimeout(r, 10));
      const events: string[] = [];
      const hasPublishedMessage = () => sent.some((m) => m.type === 'message');
      await (runtime as any).steerPrompt('steer-now', {
        localId: 'local-steer-2',
        userMessageSeq: 42,
        onProviderPromptAccepted: () => events.push(hasPublishedMessage() ? 'accepted-after-message' : 'accepted'),
      });
      // The superseded primary prompt answering is the provider's acknowledgement of the steer;
      // acceptance must not wait for the steer prompt's own response at the end of the combined turn.
      await expect.poll(() => events, { timeout: 300 }).toContain('accepted');
      await primaryPromise;
      await runtime.flushTurn();
      await expect.poll(
        () => sent.find((m) => m.type === 'message' && typeof (m as any).message === 'string')?.message,
        { timeout: 3_000 },
      ).toContain('primary=hello; steer=steer-now');
      expect(events).toEqual(['accepted']);
    } finally {
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
  it('does not accept a steer the provider rejected even when the primary prompt then answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-steer-reject-'));
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: dir,
      command: process.execPath,
      args: [writeSupersedingSteerAcpAgentScript({ dir, rejectSteer: true })],
      transportHandler: {
        agentName: 'test',
        getInitTimeout: () => 1_000,
        getToolPatterns: () => [] as ToolPattern[],
        getIdleTimeout: () => 250,
      } satisfies TransportHandler,
    });
    const session = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    } as any;
    try {
      const runtime = createAcpRuntime({
        provider: 'codex',
        directory: dir,
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        ensureBackend: async () => backend as any,
        inFlightSteer: { enabled: true },
      } as any);
      runtime.beginTurn();
      await (runtime as any).startOrLoad({});
      const primaryPromise = (runtime as any).sendPrompt('hello').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 10));
      const onProviderPromptAccepted = vi.fn();
      await (runtime as any).steerPrompt('steer-now', {
        localId: 'local-steer-3',
        userMessageSeq: 43,
        onProviderPromptAccepted,
      }).catch(() => undefined);
      await primaryPromise;
      await new Promise((r) => setTimeout(r, 200));
      expect(onProviderPromptAccepted).not.toHaveBeenCalled();
    } finally {
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
  it('keeps a superseded turn open for the outstanding steer after its last tool call closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-steer-open-tool-'));
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: dir,
      command: process.execPath,
      args: [writeSupersedingSteerWithOpenToolAcpAgentScript({ dir })],
      transportHandler: {
        agentName: 'test',
        getInitTimeout: () => 1_000,
        getToolPatterns: () => [] as ToolPattern[],
        getIdleTimeout: () => 100,
        getPostToolCallIdleTimeoutMs: () => 100,
      } satisfies TransportHandler,
    });
    const sent: Array<{ type: string; [k: string]: unknown }> = [];
    const session = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendAgentMessageCommitted: async (_provider: string, msg: any) => { sent.push(msg); },
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    } as any;
    try {
      const runtime = createAcpRuntime({
        provider: 'codex',
        directory: dir,
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        ensureBackend: async () => backend as any,
        inFlightSteer: { enabled: true },
      } as any);
      runtime.beginTurn();
      await (runtime as any).startOrLoad({});
      const primaryPromise = (runtime as any).sendPrompt('hello');
      // Let the primary reply go quiet while its tool call stays open.
      await new Promise((r) => setTimeout(r, 250));
      await (runtime as any).steerPrompt('steer-now', { localId: 'local-steer-4', userMessageSeq: 44 });
      await primaryPromise;
      await runtime.flushTurn();
      const messages = () => sent
        .filter((m) => m.type === 'message' && typeof (m as any).message === 'string')
        .map((m) => (m as any).message as string)
        .join('\n');
      await expect.poll(messages, { timeout: 3_000 }).toContain('steer-work permission=selected');
    } finally {
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
  it('fails only a rejected steer: the steered turn keeps running, keeps its permissions and holds steering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-steer-rejected-permission-'));
    let runtime: any = null;
    const steerableWhilePermissionPending: boolean[] = [];
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: dir,
      command: process.execPath,
      args: [writeSteerRejectedDuringPermissionAcpAgentScript({ dir })],
      permissionHandler: {
        handleToolCall: async () => {
          steerableWhilePermissionPending.push(runtime.supportsInFlightSteer());
          return { decision: 'approved' };
        },
      } as any,
      transportHandler: {
        agentName: 'test',
        getInitTimeout: () => 1_000,
        getToolPatterns: () => [] as ToolPattern[],
        getIdleTimeout: () => 250,
      } satisfies TransportHandler,
    });
    const sent: Array<{ type: string; [k: string]: unknown }> = [];
    const session = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendAgentMessageCommitted: async (_provider: string, msg: any) => { sent.push(msg); },
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    } as any;
    try {
      runtime = createAcpRuntime({
        provider: 'codex',
        directory: dir,
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        ensureBackend: async () => backend as any,
        inFlightSteer: { enabled: true },
      } as any);
      runtime.beginTurn();
      await runtime.startOrLoad({});
      expect(runtime.supportsInFlightSteer()).toBe(true);
      const primaryOutcome = runtime.sendPrompt('hello').then(() => 'completed', (error: unknown) => error);
      await new Promise((r) => setTimeout(r, 50));
      const onProviderPromptAccepted = vi.fn();
      const onProviderPromptRejected = vi.fn();
      await runtime.steerPrompt('steer-now', {
        localId: 'local-steer-5',
        userMessageSeq: 45,
        onProviderPromptAccepted,
        onProviderPromptRejected,
      });

      expect(await primaryOutcome).toBe('completed');
      await runtime.flushTurn();
      const messages = () => sent
        .filter((m) => m.type === 'message' && typeof (m as any).message === 'string')
        .map((m) => (m as any).message as string)
        .join('\n');
      await expect.poll(messages, { timeout: 3_000 }).toContain('later permission=selected');
      expect(sent.some((m) => m.type === 'turn_failed')).toBe(false);
      expect(onProviderPromptAccepted).not.toHaveBeenCalled();
      expect(onProviderPromptRejected).toHaveBeenCalledTimes(1);
      expect(steerableWhilePermissionPending).toEqual([false, false]);
    } finally {
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
