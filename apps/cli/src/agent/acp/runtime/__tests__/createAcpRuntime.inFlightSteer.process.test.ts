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
function writeSupersedingSteerAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent-superseding-steer.mjs');
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
      await (runtime as any).steerPrompt('steer-now', { localId: 'local-steer-2', userMessageSeq: 42 });
      await primaryPromise;
      await runtime.flushTurn();
      await expect.poll(
        () => sent.find((m) => m.type === 'message' && typeof (m as any).message === 'string')?.message,
        { timeout: 3_000 },
      ).toContain('primary=hello; steer=steer-now');
    } finally {
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
