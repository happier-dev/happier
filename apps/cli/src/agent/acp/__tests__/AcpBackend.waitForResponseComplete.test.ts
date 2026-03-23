import { describe, expect, it, vi } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenCodeTransport } from '@/backends/opencode/acp/transport';
import { AcpBackend } from '../AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';
import { createAcpTestTransportHandler } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeAcpAgentScript(params: {
  dir: string;
  exitCodeAfterPrompt?: number;
  stderrAfterPromptText?: string;
  stdoutAfterPromptText?: string;
  emitMessageChunkAfterPrompt?: boolean;
  messageChunkDelayMs?: number;
  selfTerminateSignalAfterPrompt?: NodeJS.Signals;
}): string {
  const scriptPath = join(params.dir, 'fake-acp-agent.mjs');
  const shouldExitAfterPrompt = typeof params.exitCodeAfterPrompt === 'number';
  const exitCode = params.exitCodeAfterPrompt ?? 0;
  const stderrAfterPromptText = params.stderrAfterPromptText ? JSON.stringify(params.stderrAfterPromptText) : 'null';
  const stdoutAfterPromptText = params.stdoutAfterPromptText ? JSON.stringify(params.stdoutAfterPromptText) : 'null';
  const emitMessageChunkAfterPrompt = params.emitMessageChunkAfterPrompt ?? true;
  const messageChunkDelayMs = Number.isFinite(params.messageChunkDelayMs) ? params.messageChunkDelayMs : 0;
  const selfTerminateSignalAfterPrompt =
    typeof params.selfTerminateSignalAfterPrompt === 'string' ? params.selfTerminateSignalAfterPrompt : null;
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
          ok(id, {});
          const stderrText = ${stderrAfterPromptText};
          if (stderrText) {
            process.stderr.write(String(stderrText) + '\\n');
          }
          const stdoutText = ${stdoutAfterPromptText};
          if (stdoutText) {
            // Some ACP agents (incorrectly) write error output to stdout instead of stderr.
            // Our transport filters non-JSON stdout lines, so the backend must still surface
            // these to avoid a "silent" failure in the UI.
            process.stdout.write(String(stdoutText) + '\\n');
          }
          const selfSignal = ${selfTerminateSignalAfterPrompt ? JSON.stringify(selfTerminateSignalAfterPrompt) : 'null'};
          if (selfSignal) {
            setTimeout(() => process.kill(process.pid, selfSignal), 20);
            continue;
          }
          if (${shouldExitAfterPrompt ? 'true' : 'false'}) {
            setTimeout(() => process.exit(${exitCode}), 20);
          } else {
            if (${emitMessageChunkAfterPrompt ? 'true' : 'false'}) {
              // Emit a single message chunk. The backend should follow with an idle status shortly after.
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
              }, ${messageChunkDelayMs});
            }
          }
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

function writeFakeAcpHangingToolCallAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-hanging-tool-call-agent.mjs');
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
          // Emit a tool call update that never completes so the client keeps waiting.
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tool_call_hang_1',
                status: 'pending',
                kind: 'execute',
                title: 'Shell: sleep 999',
                rawInput: { command: ['sleep', '999'] },
              },
            },
          });
          continue;
        }

        if (id !== undefined && id !== null && typeof method === 'string') {
          ok(id, {});
        }
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

function writeFakeAcpStreamingMessageChunksAgentScript(params: {
  dir: string;
  chunkIntervalMs: number;
  chunkCount: number;
}): string {
  const scriptPath = join(params.dir, 'fake-acp-streaming-chunks-agent.mjs');
  const chunkIntervalMs = Number.isFinite(params.chunkIntervalMs) ? Math.max(1, Math.trunc(params.chunkIntervalMs)) : 1;
  const chunkCount = Number.isFinite(params.chunkCount) ? Math.max(1, Math.trunc(params.chunkCount)) : 1;
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
          ok(id, {});
          let i = 0;
          const interval = setInterval(() => {
            i += 1;
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'test-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'chunk_' + i },
                },
              },
            });
            if (i >= ${chunkCount}) {
              clearInterval(interval);
            }
          }, ${chunkIntervalMs});
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

function writeFakeAcpToolCompletionThenMessageChunksAgentScript(params: {
  dir: string;
  firstChunkDelayMs: number;
  chunkIntervalMs: number;
  chunks: string[];
}): string {
  const scriptPath = join(params.dir, 'fake-acp-tool-complete-then-chunks-agent.mjs');
  const firstChunkDelayMs = Number.isFinite(params.firstChunkDelayMs) ? Math.max(1, Math.trunc(params.firstChunkDelayMs)) : 1;
  const chunkIntervalMs = Number.isFinite(params.chunkIntervalMs) ? Math.max(1, Math.trunc(params.chunkIntervalMs)) : 1;
  const chunks = Array.isArray(params.chunks) && params.chunks.length > 0 ? params.chunks : ['hello'];
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
          ok(id, {});
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tool_call_after_prompt',
                status: 'completed',
                kind: 'execute',
                title: 'Shell: echo marker',
                output: '',
                content: [
                  {
                    type: 'content',
                    content: {
                      type: 'text',
                      text: 'Command: echo marker\\nOutput: marker\\nExit Code: 0',
                    },
                  },
                ],
                meta: {},
              },
            },
          });

          const chunks = ${JSON.stringify(chunks)};
          chunks.forEach((chunkText, index) => {
            setTimeout(() => {
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'test-session',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: chunkText },
                  },
                },
              });
            }, ${firstChunkDelayMs} + index * ${chunkIntervalMs});
          });
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

function writeFakeAcpToolCompletionThenStaggeredMessageChunksAgentScript(params: {
  dir: string;
  chunkDelaysMs: number[];
  chunks: string[];
}): string {
  const scriptPath = join(params.dir, 'fake-acp-tool-complete-then-staggered-chunks-agent.mjs');
  const chunkDelaysMs = params.chunkDelaysMs.map((delayMs) => (
    Number.isFinite(delayMs) ? Math.max(1, Math.trunc(delayMs)) : 1
  ));
  const chunks = Array.isArray(params.chunks) && params.chunks.length > 0 ? params.chunks : ['hello'];
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
          ok(id, {});
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tool_call_after_prompt',
                status: 'completed',
                kind: 'execute',
                title: 'Shell: echo marker',
                output: '',
                content: [
                  {
                    type: 'content',
                    content: {
                      type: 'text',
                      text: 'Command: echo marker\\nOutput: marker\\nExit Code: 0',
                    },
                  },
                ],
                meta: {},
              },
            },
          });

          const chunkDelaysMs = ${JSON.stringify(chunkDelaysMs)};
          const chunks = ${JSON.stringify(chunks)};
          chunks.forEach((chunkText, index) => {
            setTimeout(() => {
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'test-session',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: chunkText },
                  },
                },
              });
            }, chunkDelaysMs[index] ?? 1);
          });
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

function writeFakeAcpToolPhasesWithLateUpdatesAgentScript(params: {
  dir: string;
  secondPhaseDelayMs: number;
}): string {
  const scriptPath = join(params.dir, 'fake-acp-tool-phases-late-updates-agent.mjs');
  const secondPhaseDelayMs = Number.isFinite(params.secondPhaseDelayMs)
    ? Math.max(1, Math.trunc(params.secondPhaseDelayMs))
    : 1_200;
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function sendToolUpdate(toolCallId, status, kind) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'test-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status,
            kind,
            title: 'Synthetic tool',
            rawInput: { query: toolCallId },
            content: status === 'completed'
              ? [{ type: 'content', content: { type: 'text', text: toolCallId + ' done' } }]
              : undefined,
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
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'planning phase one' },
              },
            },
          });
          sendToolUpdate('tool_call_phase_1', 'pending', 'search');
          sendToolUpdate('tool_call_phase_1', 'in_progress', 'search');
          sendToolUpdate('tool_call_phase_1', 'completed', 'search');

          setTimeout(() => {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'test-session',
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  content: { type: 'text', text: 'planning phase two' },
                },
              },
            });
            sendToolUpdate('tool_call_phase_2', 'pending', 'search');
            sendToolUpdate('tool_call_phase_2', 'in_progress', 'search');
            sendToolUpdate('tool_call_phase_2', 'completed', 'search');
            setTimeout(() => {
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'test-session',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: '{\"summary\":\"Ok\",\"findings\":[]}' },
                  },
                },
              });
            }, 50);
          }, ${secondPhaseDelayMs});
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('AcpBackend.waitForResponseComplete', () => {
  it('does not apply a default timeout when timeoutMs is omitted', async () => {
    vi.useFakeTimers();

    await withTempDir('happier-acp-no-default-timeout-', async (dir) => {
      const scriptPath = writeFakeAcpHangingToolCallAgentScript({ dir });
      let backendForCleanup: AcpBackend | undefined;
      let waiting: Promise<void> | null = null;

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
        await backend.sendPrompt(started.sessionId, 'hi');

        waiting = backend.waitForResponseComplete();
        await vi.advanceTimersByTimeAsync(121_000);

        const marker = new Promise<'marker'>((resolve) => setTimeout(() => resolve('marker'), 0));
        await vi.advanceTimersByTimeAsync(0);

        await expect(
          Promise.race([
            waiting.then(() => 'completed' as const),
            marker,
          ]),
        ).resolves.toBe('marker');
      } finally {
        vi.useRealTimers();
        try {
          await backendForCleanup?.dispose();
        } catch {
          // best-effort
        }
        if (waiting) {
          await waiting.catch(() => {});
        }
      }
    });
  }, 20_000);

  it('rejects waitForResponseComplete with AbortError after cancel', async () => {
    await withTempDir('happier-acp-cancel-', async (dir) => {
      const scriptPath = writeFakeAcpHangingToolCallAgentScript({ dir });
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
        await backend.sendPrompt(started.sessionId, 'hi');

        const waiting = backend.waitForResponseComplete(5_000);
        await backend.cancel(started.sessionId);

        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('rejects waitForResponseComplete with AbortError after dispose', async () => {
    await withTempDir('happier-acp-dispose-', async (dir) => {
      const scriptPath = writeFakeAcpHangingToolCallAgentScript({ dir });
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
        await backend.sendPrompt(started.sessionId, 'hi');

        const waiting = backend.waitForResponseComplete(5_000);
        const waitingExpectation = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
        await backend.dispose();
        backendForCleanup = undefined;

        await waitingExpectation;
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('does not time out while message chunks keep streaming', async () => {
    await withTempDir('happier-acp-streaming-chunks-', async (dir) => {
      const scriptPath = writeFakeAcpStreamingMessageChunksAgentScript({
        dir,
        chunkIntervalMs: 100,
        chunkCount: 6,
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            idleTimeoutMs: 200,
          }),
        });
        backendForCleanup = backend;

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        await expect(backend.waitForResponseComplete(250)).resolves.toBeUndefined();
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('resolves when prompt completes without emitting any session/update events', async () => {
    await withTempDir('happier-acp-prompt-complete-no-updates-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, emitMessageChunkAfterPrompt: false });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            idleTimeoutMs: 1,
            postPromptNoUpdatesTimeoutMs: 1,
          }),
        });
        backendForCleanup = backend;

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        await expect(backend.waitForResponseComplete(250)).resolves.toBeUndefined();
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('does not resolve before the first session/update arrives (delayed first chunk)', async () => {
    await withTempDir('happier-acp-delayed-first-chunk-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        emitMessageChunkAfterPrompt: true,
        messageChunkDelayMs: 200,
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            idleTimeoutMs: 1,
            postPromptNoUpdatesTimeoutMs: 500,
          }),
        });
        backendForCleanup = backend;

        const firstChunkSeen = new Promise<void>((resolve) => {
          backend.onMessage((msg) => {
            if (msg.type !== 'model-output') return;
            resolve();
          });
        });

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        const first = await Promise.race([
          backend.waitForResponseComplete(5_000).then(() => 'wait' as const),
          firstChunkSeen.then(() => 'chunk' as const),
        ]);

        expect(first).toBe('chunk');
        await expect(backend.waitForResponseComplete(5_000)).resolves.toBeUndefined();
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('resolves when idle status is emitted before waitForResponseComplete starts waiting', async () => {
    await withTempDir('happier-acp-idle-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });
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

        const statuses: string[] = [];
        const idleEmitted = new Promise<void>((resolve) => {
          backend.onMessage((msg) => {
            if (msg.type !== 'status') return;
            statuses.push(msg.status);
            if (msg.status === 'idle') resolve();
          });
        });

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        await idleEmitted;
        expect(statuses).toContain('idle');

        await expect(backend.waitForResponseComplete(25)).resolves.toBeUndefined();
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('does not resolve before trailing assistant chunks that arrive after tool completion', async () => {
    await withTempDir('happier-acp-tool-complete-then-chunks-', async (dir) => {
      const scriptPath = writeFakeAcpToolCompletionThenMessageChunksAgentScript({
        dir,
        firstChunkDelayMs: 650,
        chunkIntervalMs: 50,
        chunks: ['PROFILE', '_STACK', '_MARKER_0306'],
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 500 }),
        });
        backendForCleanup = backend;

        const chunks: string[] = [];
        backend.onMessage((msg) => {
          if (msg.type !== 'model-output') return;
          if (typeof msg.textDelta !== 'string') return;
          chunks.push(msg.textDelta);
        });

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        const waiting = backend.waitForResponseComplete(5_000);
        const settledBeforeChunks = await Promise.race([
          waiting.then(() => 'resolved' as const),
          new Promise<'timer'>((resolve) => setTimeout(() => resolve('timer'), 600)),
        ]);
        expect(settledBeforeChunks).toBe('timer');

        await waiting;
        expect(chunks.join('')).toBe('PROFILE_STACK_MARKER_0306');
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('does not resolve before staggered post-tool chunks that match OpenCode idle timing', async () => {
    await withTempDir('happier-acp-opencode-staggered-post-tool-', async (dir) => {
      const scriptPath = writeFakeAcpToolCompletionThenStaggeredMessageChunksAgentScript({
        dir,
        chunkDelaysMs: [100, 1_250, 2_450],
        chunks: ['{"summary":"Open', 'Code delayed ', 'tail"}'],
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const transport = new OpenCodeTransport();
        transport.getInitTimeout = () => 5_000;
        transport.getToolPatterns = () => [] as ToolPattern[];
        const backend = new AcpBackend({
          agentName: 'opencode',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: transport satisfies TransportHandler,
        });
        backendForCleanup = backend;

        const chunks: string[] = [];
        let resolveFirstChunk!: () => void;
        const firstChunkSeen = new Promise<void>((resolve) => {
          resolveFirstChunk = resolve;
        });
        let sawFirstChunk = false;

        backend.onMessage((msg) => {
          if (msg.type !== 'model-output' || typeof msg.textDelta !== 'string') return;
          chunks.push(msg.textDelta);
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            resolveFirstChunk();
          }
        });

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');
        const waiting = backend.waitForResponseComplete(8_000);

        await firstChunkSeen;
        const settledBeforeLateChunk = await Promise.race([
          waiting.then(() => 'resolved' as const),
          new Promise<'timer'>((resolve) => setTimeout(() => resolve('timer'), 700)),
        ]);

        expect(settledBeforeLateChunk).toBe('timer');
        await waiting;
        expect(chunks.join('')).toBe('{"summary":"OpenCode delayed tail"}');
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('does not resolve on a transient idle before a later tool phase resumes the turn', async () => {
    await withTempDir('happier-acp-late-tool-phase-', async (dir) => {
      const scriptPath = writeFakeAcpToolPhasesWithLateUpdatesAgentScript({
        dir,
        secondPhaseDelayMs: 1_200,
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            idleTimeoutMs: 500,
            postToolCallIdleTimeoutMs: 500,
            idleWithoutAssistantMessageTimeoutMs: 1_500,
          }),
        });
        backendForCleanup = backend;

        const statuses: string[] = [];
        const chunks: string[] = [];
        let idleCount = 0;
        let resolveFirstIdle!: () => void;
        const firstIdleSeen = new Promise<void>((resolve) => {
          resolveFirstIdle = resolve;
        });
        let resolveSecondPhase!: () => void;
        const secondPhaseSeen = new Promise<void>((resolve) => {
          resolveSecondPhase = resolve;
        });

        backend.onMessage((msg) => {
          if (msg.type === 'status') {
            statuses.push(msg.status);
            if (msg.status === 'idle') {
              idleCount += 1;
              if (idleCount === 1) resolveFirstIdle();
            }
            return;
          }
          if (msg.type !== 'model-output') return;
          if (typeof msg.textDelta !== 'string') return;
          chunks.push(msg.textDelta);
          if (msg.textDelta.includes('"summary":"Ok"')) {
            resolveSecondPhase();
          }
        });

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        const waiting = backend.waitForResponseComplete(5_000).then(() => 'resolved' as const);
        await firstIdleSeen;

        const firstOutcome = await Promise.race([
          waiting,
          secondPhaseSeen.then(() => 'phase2' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_500)),
        ]);

        expect(firstOutcome).toBe('phase2');
        expect(statuses).toContain('idle');
        expect(chunks.join('')).toContain('"summary":"Ok"');
        await expect(waiting).resolves.toBe('resolved');
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('does not resolve on a transient post-tool idle before a later OpenCode tool phase resumes the turn', async () => {
    await withTempDir('happier-acp-opencode-late-tool-phase-', async (dir) => {
      const scriptPath = writeFakeAcpToolPhasesWithLateUpdatesAgentScript({
        dir,
        secondPhaseDelayMs: 1_200,
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const transport = new OpenCodeTransport();
        transport.getInitTimeout = () => 5_000;
        transport.getToolPatterns = () => [] as ToolPattern[];

        const backend = new AcpBackend({
          agentName: 'opencode',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: transport satisfies TransportHandler,
        });
        backendForCleanup = backend;

        let resolveFirstIdle!: () => void;
        const firstIdleSeen = new Promise<void>((resolve) => {
          resolveFirstIdle = resolve;
        });
        let resolveSecondPhase!: () => void;
        const secondPhaseSeen = new Promise<void>((resolve) => {
          resolveSecondPhase = resolve;
        });

        backend.onMessage((msg) => {
          if (msg.type === 'status') {
            if (msg.status === 'idle') resolveFirstIdle();
            return;
          }
          if (msg.type !== 'model-output' || typeof msg.textDelta !== 'string') return;
          if (msg.textDelta.includes('"summary":"Ok"')) {
            resolveSecondPhase();
          }
        });

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        const waiting = backend.waitForResponseComplete(5_000).then(() => 'resolved' as const);
        await firstIdleSeen;

        const firstOutcome = await Promise.race([
          waiting,
          secondPhaseSeen.then(() => 'phase2' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_500)),
        ]);

        expect(firstOutcome).toBe('phase2');
        await expect(waiting).resolves.toBe('resolved');
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('rejects waitForResponseComplete when ACP process exits non-zero after prompt', async () => {
    await withTempDir('happier-acp-exit-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, exitCodeAfterPrompt: 52 });
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
        await backend.sendPrompt(started.sessionId, 'hi');

        await expect(backend.waitForResponseComplete(250)).rejects.toThrow(/52/);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('rejects waitForResponseComplete when ACP process is terminated by a signal after prompt', async () => {
    await withTempDir('happier-acp-signal-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, selfTerminateSignalAfterPrompt: 'SIGTERM' });
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
        await backend.sendPrompt(started.sessionId, 'hi');

        await expect(backend.waitForResponseComplete(250)).rejects.toThrow(/SIGTERM/);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('rejects waitForResponseComplete when transport emits a status:error from stderr', async () => {
    await withTempDir('happier-acp-stderr-error-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        stderrAfterPromptText: 'Error code: 401 - invalid_authentication_error',
        emitMessageChunkAfterPrompt: false,
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            idleTimeoutMs: 1,
            handleStderr: (text) => {
              if (!text.includes('401')) return { message: null };
              return { message: { type: 'status', status: 'error', detail: 'auth invalid' } };
            },
          }),
        });
        backendForCleanup = backend;

        const errorStatusEmitted = new Promise<void>((resolve) => {
          backend.onMessage((msg) => {
            if (msg.type !== 'status') return;
            if (msg.status !== 'error') return;
            resolve();
          });
        });

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        await errorStatusEmitted;
        await expect(backend.waitForResponseComplete(250)).rejects.toThrow(/auth invalid/);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('rejects waitForResponseComplete when agent writes an error-like non-JSON stdout line during a prompt', async () => {
    await withTempDir('happier-acp-error-chunk-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        emitMessageChunkAfterPrompt: false,
        stdoutAfterPromptText: 'Error: image exceeds 5 MB maximum',
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            idleTimeoutMs: 1,
            filterStdoutLine: (line: string) => {
              const trimmed = line.trim();
              if (!trimmed) return null;
              if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed !== 'object' || parsed === null) return null;
                return line;
              } catch {
                return null;
              }
            },
          }),
        });
        backendForCleanup = backend;

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        await expect(backend.waitForResponseComplete(250)).rejects.toThrow(/image exceeds 5 MB maximum/);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('redacts sensitive tokens in surfaced dropped-stdout errors', async () => {
    await withTempDir('happier-acp-error-redaction-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        emitMessageChunkAfterPrompt: false,
        stdoutAfterPromptText: 'Error: Authorization: Bearer abc/def+ghi==',
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            idleTimeoutMs: 1,
            filterStdoutLine: (line: string) => {
              const trimmed = line.trim();
              if (!trimmed) return null;
              if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed !== 'object' || parsed === null) return null;
                return line;
              } catch {
                return null;
              }
            },
          }),
        });
        backendForCleanup = backend;

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        let caught: unknown;
        try {
          await backend.waitForResponseComplete(250);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).toContain('[REDACTED]');
        expect(message).not.toContain('abc/def+ghi==');
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);

  it('prefers the first transport error when stderr error is followed by a non-zero process exit', async () => {
    await withTempDir('happier-acp-stderr-then-exit-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        stderrAfterPromptText: 'Error code: 401 - invalid_authentication_error',
        exitCodeAfterPrompt: 52,
        emitMessageChunkAfterPrompt: false,
      });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            idleTimeoutMs: 1,
            handleStderr: (text) => {
              if (!text.includes('401')) return { message: null };
              return { message: { type: 'status', status: 'error', detail: 'auth invalid' } };
            },
          }),
        });
        backendForCleanup = backend;

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        await expect(backend.waitForResponseComplete(1_000)).rejects.toThrow(/auth invalid/);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);
});
