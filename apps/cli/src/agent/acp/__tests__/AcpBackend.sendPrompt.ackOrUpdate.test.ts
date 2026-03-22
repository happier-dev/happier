import { describe, expect, it } from 'vitest';

import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import {
  createAcpSubprocessEnvScope,
  createAcpTestTransportHandler,
  writeAcpTestAgentScript,
} from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeFakeAcpAgentScript(params: {
  dir: string;
  promptAckDelayMs: number;
  promptAckMode?: 'ok' | 'gemini_late_empty_response_error';
}): string {
  const ackDelayMs = Number.isFinite(params.promptAckDelayMs) ? params.promptAckDelayMs : 0;
  const ackMode = params.promptAckMode ?? 'ok';
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function err(id, code, message, data) {
      send({ jsonrpc: '2.0', id, error: { code, message, data } });
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
          // Emit a session/update quickly, but delay the RPC ACK significantly.
          setTimeout(() => {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'test-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'hello' },
                },
              },
            });
          }, 10);

          setTimeout(() => {
            if (${JSON.stringify(ackMode)} === 'gemini_late_empty_response_error') {
              err(id, -32603, 'Internal error', { details: 'Model stream ended with empty response text.' });
              return;
            }
            ok(id, {});
          }, ${ackDelayMs});
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent-delayed-prompt-ack.mjs',
    source: src,
  });
}

function writeFakeAcpAgentNeverAckPromptScript(params: { dir: string }): string {
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
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
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent-never-ack-prompt.mjs',
    source: src,
  });
}

describe('AcpBackend.sendPrompt (prompt ACK vs first session/update)', () => {
  it('resolves once a session/update arrives even when the prompt ACK is delayed', async () => {
    await withTempDir('happier-acp-sendprompt-first-update-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, promptAckDelayMs: 5_000 });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
        });
        backendForCleanup = backend;

        const started = await backend.startSession();
        const outcome = await Promise.race([
          backend.sendPrompt(started.sessionId, 'hi').then(() => 'resolved' as const),
          delay(500).then(() => 'timeout' as const),
        ]);

        expect(outcome).toBe('resolved');
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('ignores late Gemini empty-stream errors when sendPrompt returns early on first session/update', async () => {
    await withTempDir('happier-acp-sendprompt-gemini-late-error-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        promptAckDelayMs: 50,
        promptAckMode: 'gemini_late_empty_response_error',
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'gemini',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            agentName: 'gemini',
            idleTimeoutMs: 1,
          }),
        });
        backendForCleanup = backend;

        const emitted: any[] = [];
        backend.onMessage((msg) => emitted.push(msg));

        const started = await backend.startSession();
        const sendOutcome = await Promise.race([
          backend.sendPrompt(started.sessionId, 'hi').then(() => 'resolved' as const),
          delay(500).then(() => 'timeout' as const),
        ]);
        expect(sendOutcome).toBe('resolved');

        await backend.waitForResponseComplete(2_000);
        await delay(200);

        const errorStatuses = emitted.filter((m) => m?.type === 'status' && m?.status === 'error');
        expect(errorStatuses).toHaveLength(0);
        expect((backend as any).responseCompletionError).toBeNull();
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('rejects when neither a prompt ACK nor a first session/update arrives', async () => {
    await withTempDir('happier-acp-sendprompt-no-ack-no-update-', async (dir) => {
      const scriptPath = writeFakeAcpAgentNeverAckPromptScript({ dir });
      let backendForCleanup: AcpBackend | undefined;
      const envScope = createAcpSubprocessEnvScope();
      envScope.patch({ HAPPIER_ACP_PROMPT_LIVENESS_TIMEOUT_MS: '50' });

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
        });
        backendForCleanup = backend;

        const started = await backend.startSession();
        await expect(backend.sendPrompt(started.sessionId, 'hi')).rejects.toThrow(/prompt ack|first session\/update|liveness/i);
      } finally {
        envScope.restore();
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);
});
