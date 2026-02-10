import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';

function writeFakeAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent.mjs');
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    let waitingForPermResponse = false;

    function sendPermissionRequest() {
      send({
        jsonrpc: '2.0',
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'test-session',
          toolCall: { toolCallId: 'call-1', kind: 'execute' },
          options: [
            { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      waitingForPermResponse = true;
    }

    function sendToolCallUpdateAndMessage() {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'test-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: 'completed',
            // Mimic providers that set output to an empty string but include details in content.
            output: '',
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: 'Command: echo hi\\\\nOutput: (empty)\\\\nExit Code: 0',
                },
              },
            ],
          },
        },
      });

      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'test-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'done' },
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

        // Handle client responses (permission request response)
        if (waitingForPermResponse && req.id === 'perm-1') {
          waitingForPermResponse = false;
          setTimeout(sendToolCallUpdateAndMessage, 10);
          continue;
        }

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
          setTimeout(sendPermissionRequest, 10);
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('AcpBackend permission seed + tool_call_update fallback', () => {
  it('reuses tool name from permission request when tool_call_update lacks kind, and preserves content when output is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-perm-seed-'));
    const scriptPath = writeFakeAcpAgentScript({ dir });
    let backendForCleanup: AcpBackend | undefined;

    try {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        transportHandler: {
          agentName: 'test',
          getInitTimeout: () => 1_000,
          getToolPatterns: () => [] as ToolPattern[],
          getIdleTimeout: () => 1,
        } satisfies TransportHandler,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'approved' as const };
          },
        },
      });
      backendForCleanup = backend;

      const toolResults: Array<{ toolName: string; result: unknown }> = [];
      backend.onMessage((msg) => {
        if (msg.type !== 'tool-result') return;
        toolResults.push({ toolName: msg.toolName, result: msg.result });
      });

      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'hi');
      await backend.waitForResponseComplete(5_000);

      expect(toolResults.length).toBeGreaterThan(0);
      const last = toolResults[toolResults.length - 1]!;
      expect(last.toolName).toBe('execute');
      expect(last.result).not.toBe('');
      expect(Array.isArray(last.result)).toBe(true);
    } finally {
      await backendForCleanup?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
