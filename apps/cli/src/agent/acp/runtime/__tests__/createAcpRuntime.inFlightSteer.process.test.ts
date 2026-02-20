import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';

import { createAcpRuntime } from '../createAcpRuntime';
import { createApprovedPermissionHandler } from '../createAcpRuntime.testkit';

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

describe('createAcpRuntime (in-flight steer, real process)', () => {
  it('sends steerPrompt into an in-flight turn without aborting', async () => {
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
        // Keep the prompt "in flight" briefly after the chunk is emitted.
        getIdleTimeout: () => 25,
      } satisfies TransportHandler,
    });

    const sent: Array<{ type: string; [k: string]: unknown }> = [];
    const session = {
      keepAlive: () => {},
      sendAgentMessage: (_provider: string, msg: any) => {
        sent.push(msg);
      },
      sendAgentMessageCommitted: async () => {},
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

      await (runtime as any).steerPrompt('steer-now');
      await primaryPromise;
      runtime.flushTurn();

      const message = await waitForMessage();
      expect(message).not.toBeNull();
      expect((message as any)?.message).toContain('primary=hello');
      expect((message as any)?.message).toContain('steer=steer-now');
    } finally {
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
