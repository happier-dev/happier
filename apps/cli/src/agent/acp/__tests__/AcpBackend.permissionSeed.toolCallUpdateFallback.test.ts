import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeAcpAgentScript(params: { dir: string }): string {
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
            setTimeout(sendToolCallUpdateAndMessage, 0);
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
            setTimeout(sendPermissionRequest, 0);
            continue;
          }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

function writeFakeAcpWebFetchRefinementScript(params: { dir: string }): string {
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
        id: 'perm-web-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'test-session',
          toolCall: {
            toolCallId: 'call-web-1',
            kind: 'read',
            rawInput: {
              title: 'web_fetch',
              description: 'web_fetch',
              _acp: { title: 'web_fetch' },
              url: 'https://example.com/docs',
            },
          },
          options: [
            { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      waitingForPermResponse = true;
    }

    function sendTerminalUpdateAndMessage() {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'test-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-web-1',
            status: 'completed',
            title: 'web_fetch',
            output: {
              url: 'https://example.com/docs',
              title: 'Example documentation',
            },
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

        if (waitingForPermResponse && req.id === 'perm-web-1') {
          waitingForPermResponse = false;
          setTimeout(sendTerminalUpdateAndMessage, 0);
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
          setTimeout(sendPermissionRequest, 0);
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-web-fetch-refinement.mjs',
    source: src,
  });
}

describe('AcpBackend permission seed + tool_call_update fallback', () => {
  it('reuses tool name from permission request when tool_call_update lacks kind, and preserves content when output is empty', async () => {
    await withTempDir('happier-acp-perm-seed-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            initTimeoutMs: 1_000,
            idleTimeoutMs: 50,
          }),
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

        const startMs = Date.now();
        while (toolResults.length === 0 && Date.now() - startMs < 2_000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(toolResults.length).toBeGreaterThan(0);
        const last = toolResults[toolResults.length - 1]!;
        expect(last.toolName).toBe('execute');
        expect(last.result).not.toBe('');
        expect(Array.isArray((last.result as any)?.output)).toBe(true);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  });

  it('upgrades a generic read tool call to web_fetch when permission metadata becomes more specific later', async () => {
    await withTempDir('happier-acp-perm-refine-', async (dir) => {
      const scriptPath = writeFakeAcpWebFetchRefinementScript({ dir });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            initTimeoutMs: 1_000,
            idleTimeoutMs: 50,
          }),
          permissionHandler: {
            async handleToolCall() {
              return { decision: 'approved' as const };
            },
          },
        });
        backendForCleanup = backend;

        const toolCalls: Array<{ toolName: string; args: unknown }> = [];
        const toolResults: Array<{ toolName: string; result: unknown }> = [];
        backend.onMessage((msg) => {
          if (msg.type === 'tool-call') {
            toolCalls.push({ toolName: msg.toolName, args: msg.args });
            return;
          }
          if (msg.type === 'tool-result') {
            toolResults.push({ toolName: msg.toolName, result: msg.result });
          }
        });

        const started = await backend.startSession();
        ((backend as unknown as { toolCallIdToNameMap: Map<string, string> }).toolCallIdToNameMap).set(
          'call-web-1',
          'read',
        );
        await backend.sendPrompt(started.sessionId, 'hi');

        const startMs = Date.now();
        while ((toolCalls.length === 0 || toolResults.length === 0) && Date.now() - startMs < 2_000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(toolCalls.length).toBeGreaterThan(0);
        expect(toolResults.length).toBeGreaterThan(0);
        expect(toolCalls[toolCalls.length - 1]?.toolName).toBe('web_fetch');
        expect(toolResults[toolResults.length - 1]?.toolName).toBe('web_fetch');
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  });
});
