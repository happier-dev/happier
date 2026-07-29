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

function isLateEmptyResponseError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const data = record?.data;
  const details =
    data && typeof data === 'object' && typeof (data as Record<string, unknown>).details === 'string'
      ? (data as Record<string, unknown>).details as string
      : '';
  return record?.code === -32603 && details.includes('Model stream ended with empty response text');
}

function writeFakeAcpAgentScript(params: {
  dir: string;
  promptAckDelayMs: number;
  promptAckMode?: 'ok' | 'gemini_late_empty_response_error';
  emitUpdate?: boolean;
}): string {
  const ackDelayMs = Number.isFinite(params.promptAckDelayMs) ? params.promptAckDelayMs : 0;
  const ackMode = params.promptAckMode ?? 'ok';
  const emitUpdate = params.emitUpdate ?? true;
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
          if (${JSON.stringify(emitUpdate)}) {
            // Emit a session/update quickly, but delay the request-scoped result.
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
          }

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
  it('does not accept an early session/update before the exact prompt response', async () => {
    await withTempDir('happier-acp-sendprompt-first-update-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, promptAckDelayMs: 150 });
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
        const sending = backend.sendPrompt(started.sessionId, 'hi');
        const earlyOutcome = await Promise.race([
          sending.then(() => 'resolved' as const),
          delay(50).then(() => 'pending' as const),
        ]);
        expect(earlyOutcome).toBe('pending');

        await expect(sending).resolves.toEqual({
          kind: 'accepted_by_prompt_response',
        });
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('reports effect ambiguity when an early update is followed by a rejected prompt response', async () => {
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
          transportHandler: createAcpTestTransportHandler({ agentName: 'gemini', idleTimeoutMs: 1 }),
        });
        backendForCleanup = backend;

        const emitted: any[] = [];
        backend.onMessage((msg) => emitted.push(msg));

        const started = await backend.startSession();
        const sendOutcome = await backend.sendPrompt(started.sessionId, 'hi');
        expect(sendOutcome).toMatchObject({
          kind: 'effect_may_have_occurred',
        });
        expect(isLateEmptyResponseError(
          sendOutcome.kind === 'effect_may_have_occurred' ? sendOutcome.error : null,
        )).toBe(true);

        const errorStatuses = emitted.filter((m) => m?.type === 'status' && m?.status === 'error');
        expect(errorStatuses).toHaveLength(1);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('does not downgrade correlated provider-effect acceptance after a late prompt rejection', async () => {
    await withTempDir('happier-acp-sendprompt-monotonic-acceptance-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        promptAckDelayMs: 75,
        promptAckMode: 'gemini_late_empty_response_error',
        emitUpdate: false,
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'gemini',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({ agentName: 'gemini', idleTimeoutMs: 1 }),
        });
        backendForCleanup = backend;
        const emitted: any[] = [];
        backend.onMessage((msg) => emitted.push(msg));

        const started = await backend.startSession();
        const sending = backend.sendPrompt(started.sessionId, 'hi');
        await delay(10);
        expect(backend.submitCompletionEvidence({ kind: 'completed' })).toBe(true);
        await expect(sending).resolves.toEqual({
          kind: 'accepted_by_correlated_provider_effect',
        });

        await delay(100);
        expect(emitted.filter((m) => m?.type === 'status' && m?.status === 'error')).toHaveLength(0);
        expect(backend.getLastTurnOutcome()).toEqual({
          kind: 'completed',
          stopReason: 'end_turn',
        });
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('reports a request-scoped RPC rejection before any provider effect as rejected before effect', async () => {
    await withTempDir('happier-acp-sendprompt-pre-effect-rejection-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        promptAckDelayMs: 10,
        promptAckMode: 'gemini_late_empty_response_error',
        emitUpdate: false,
      });
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
        const outcome = await backend.sendPrompt(started.sessionId, 'hi');
        expect(outcome).toMatchObject({
          kind: 'rejected_before_effect',
        });
        expect(isLateEmptyResponseError(
          outcome.kind === 'rejected_before_effect' ? outcome.error : null,
        )).toBe(true);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('reports effect ambiguity when an attempted prompt produces no exact result or evidence', async () => {
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
        await expect(backend.sendPrompt(started.sessionId, 'hi')).resolves.toMatchObject({
          kind: 'effect_may_have_occurred',
          error: expect.objectContaining({
            message: expect.stringMatching(/prompt response|provider-effect evidence|liveness/i),
          }),
        });
      } finally {
        envScope.restore();
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);
});
