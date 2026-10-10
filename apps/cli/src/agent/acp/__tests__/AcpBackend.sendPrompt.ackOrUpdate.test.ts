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
  promptAckMode?: 'ok' | 'gemini_late_empty_response_error' | 'rejected_after_update_same_batch';
  emitUpdate?: boolean;
  updateKind?: 'agent_message_chunk' | 'current_mode_update';
}): string {
  const ackDelayMs = Number.isFinite(params.promptAckDelayMs) ? params.promptAckDelayMs : 0;
  const ackMode = params.promptAckMode ?? 'ok';
  const emitUpdate = params.emitUpdate ?? true;
  const updateKind = params.updateKind ?? 'agent_message_chunk';
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
          if (${JSON.stringify(ackMode)} === 'rejected_after_update_same_batch') {
            // One transport write keeps output and rejection in the same dispatch batch.
            process.stdout.write([
              { jsonrpc: '2.0', method: 'session/update', params: {
                sessionId: 'test-session',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
              } },
              { jsonrpc: '2.0', id, error: { code: -32603, message: 'rejected after output' } },
            ].map(JSON.stringify).join('\\n') + '\\n');
            continue;
          }
          if (${JSON.stringify(emitUpdate)}) {
            // Emit a session/update quickly, but delay the request-scoped result.
            setTimeout(() => {
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'test-session',
                  update: ${JSON.stringify(updateKind === 'current_mode_update'
                    ? { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }
                    : { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })},
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
  it('reports transport submission separately from eventual provider custody', async () => {
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
          sending,
          delay(50).then(() => 'pending' as const),
        ]);
        expect(earlyOutcome).toEqual(expect.objectContaining({ kind: 'submitted_to_transport' }));
        if (earlyOutcome === 'pending' || earlyOutcome.kind !== 'submitted_to_transport') {
          throw new Error('expected prompt transport submission');
        }
        await expect(earlyOutcome.settlement).resolves.toEqual({ kind: 'effect_observed_without_prompt_response' });
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('reports observed provider effect without fabricating acceptance before a late rejection', async () => {
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
        expect(sendOutcome).toEqual(expect.objectContaining({ kind: 'submitted_to_transport' }));
        if (sendOutcome.kind !== 'submitted_to_transport') throw new Error('expected prompt transport submission');
        await expect(sendOutcome.settlement).resolves.toEqual({
          kind: 'effect_observed_without_prompt_response',
        });
        await delay(75);

        const errorStatuses = emitted.filter((m) => m?.type === 'status' && m?.status === 'error');
        expect(errorStatuses).toHaveLength(1);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('preserves observed provider effect when output and prompt rejection share a transport batch', async () => {
    await withTempDir('happier-acp-sendprompt-same-batch-rejection-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        promptAckDelayMs: 0,
        promptAckMode: 'rejected_after_update_same_batch',
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
      });
      try {
        const started = await backend.startSession();
        const submitted = await backend.sendPrompt(started.sessionId, 'hi');
        const settled = submitted.kind === 'submitted_to_transport' ? await submitted.settlement : submitted;
        expect(settled).toEqual({ kind: 'effect_observed_without_prompt_response' });
        await expect(backend.waitForResponseComplete()).rejects.toThrow('rejected after output');
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('does not treat catalog-only traffic as provider effect before prompt rejection', async () => {
    await withTempDir('happier-acp-sendprompt-catalog-rejection-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        promptAckDelayMs: 50,
        promptAckMode: 'gemini_late_empty_response_error',
        updateKind: 'current_mode_update',
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
      });
      try {
        const started = await backend.startSession();
        const submitted = await backend.sendPrompt(started.sessionId, 'hi');
        const settled = submitted.kind === 'submitted_to_transport' ? await submitted.settlement : submitted;
        expect(settled).toEqual({ kind: 'rejected_before_effect', error: expect.any(Error) });
      } finally {
        await backend.dispose();
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
        const submitted = await sending;
        expect(submitted).toEqual(expect.objectContaining({ kind: 'submitted_to_transport' }));
        if (submitted.kind !== 'submitted_to_transport') throw new Error('expected prompt transport submission');
        await expect(submitted.settlement).resolves.toEqual({ kind: 'accepted_by_correlated_provider_effect' });

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

  it('reports request-scoped rejection before provider effect', async () => {
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
        expect(outcome).toEqual(expect.objectContaining({ kind: 'submitted_to_transport' }));
        if (outcome.kind !== 'submitted_to_transport') throw new Error('expected prompt transport submission');
        await expect(outcome.settlement).resolves.toEqual(expect.objectContaining({
          kind: 'rejected_before_effect',
        }));
        await delay(25);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('reports unknown effect when neither prompt response nor provider evidence arrives', async () => {
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
        const outcome = await backend.sendPrompt(started.sessionId, 'hi');
        expect(outcome).toEqual(expect.objectContaining({ kind: 'submitted_to_transport' }));
        if (outcome.kind !== 'submitted_to_transport') throw new Error('expected prompt transport submission');
        await expect(outcome.settlement).resolves.toEqual(expect.objectContaining({
          kind: 'effect_may_have_occurred',
        }));
      } finally {
        envScope.restore();
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('accepts in-flight steer custody when the provider never returns a prompt response', async () => {
    await withTempDir('happier-acp-steer-no-ack-', async (dir) => {
      const scriptPath = writeFakeAcpAgentNeverAckPromptScript({ dir });
      let backendForCleanup: AcpBackend | undefined;
      const envScope = createAcpSubprocessEnvScope();
      envScope.patch({ HAPPIER_ACP_PROMPT_LIVENESS_TIMEOUT_MS: '100' });

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
        const primary = backend.sendPrompt(started.sessionId, 'primary');
        await delay(10);
        await expect(Promise.race([
          backend.sendSteerPrompt(started.sessionId, 'follow up').then(() => 'written' as const),
          delay(250).then(() => 'timeout' as const),
        ])).resolves.toBe('written');
        const submitted = await primary;
        expect(submitted).toEqual(expect.objectContaining({ kind: 'submitted_to_transport' }));
        if (submitted.kind !== 'submitted_to_transport') throw new Error('expected prompt transport submission');
        await expect(submitted.settlement).resolves.toEqual(expect.objectContaining({
          kind: 'effect_may_have_occurred',
        }));
      } finally {
        envScope.restore();
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);
});
