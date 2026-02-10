import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';

function writeFakeAcpAgentScript(params: {
  dir: string;
  exitCodeAfterPrompt?: number;
  stderrAfterPromptText?: string;
  emitMessageChunkAfterPrompt?: boolean;
}): string {
  const scriptPath = join(params.dir, 'fake-acp-agent.mjs');
  const shouldExitAfterPrompt = typeof params.exitCodeAfterPrompt === 'number';
  const exitCode = params.exitCodeAfterPrompt ?? 0;
  const stderrAfterPromptText = params.stderrAfterPromptText ? JSON.stringify(params.stderrAfterPromptText) : 'null';
  const emitMessageChunkAfterPrompt = params.emitMessageChunkAfterPrompt ?? true;
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
          if (${shouldExitAfterPrompt ? 'true' : 'false'}) {
            setTimeout(() => process.exit(${exitCode}), 20);
          } else {
            if (${emitMessageChunkAfterPrompt ? 'true' : 'false'}) {
              // Emit a single message chunk. The backend should follow with an idle status shortly after.
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

describe('AcpBackend.waitForResponseComplete', () => {
  it('resolves when idle status is emitted before waitForResponseComplete starts waiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-idle-'));
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects waitForResponseComplete when ACP process exits non-zero after prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-exit-'));
    const scriptPath = writeFakeAcpAgentScript({ dir, exitCodeAfterPrompt: 52 });
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
      });
      backendForCleanup = backend;

      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'hi');

      await expect(backend.waitForResponseComplete(250)).rejects.toThrow(/52/);
    } finally {
      await backendForCleanup?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects waitForResponseComplete when transport emits a status:error from stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-stderr-error-'));
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
        transportHandler: {
          agentName: 'test',
          getInitTimeout: () => 1_000,
          getToolPatterns: () => [] as ToolPattern[],
          getIdleTimeout: () => 1,
          handleStderr: (text) => {
            if (!text.includes('401')) return { message: null };
            return { message: { type: 'status', status: 'error', detail: 'auth invalid' } };
          },
        } satisfies TransportHandler,
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the first transport error when stderr error is followed by a non-zero process exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-stderr-then-exit-'));
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
        transportHandler: {
          agentName: 'test',
          getInitTimeout: () => 1_000,
          getToolPatterns: () => [] as ToolPattern[],
          getIdleTimeout: () => 1,
          handleStderr: (text) => {
            if (!text.includes('401')) return { message: null };
            return { message: { type: 'status', status: 'error', detail: 'auth invalid' } };
          },
        } satisfies TransportHandler,
      });
      backendForCleanup = backend;

      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'hi');

      await expect(backend.waitForResponseComplete(1_000)).rejects.toThrow(/auth invalid/);
    } finally {
      await backendForCleanup?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
