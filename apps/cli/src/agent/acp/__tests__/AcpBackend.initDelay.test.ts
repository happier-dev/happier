import { describe, expect, it, vi } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';

function writePoisonOnEarlyInputAcpAgentScript(params: { dir: string; readyAfterMs: number }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent-swallow.mjs');
  const src = `
    const decoder = new TextDecoder();
    let buf = '';
    const start = Date.now();
    let poisoned = false;

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

        // Simulate Gemini CLI ACP quirk:
        // The ACP stdio bridge can swallow an early initialize request before it's "ready",
        // and once that happens the session is effectively poisoned.
        const ready = (Date.now() - start) >= ${params.readyAfterMs};
        if (!ready && method === 'initialize') {
          poisoned = true;
          continue;
        }
        if (poisoned) continue;
        if (!ready) {
          // Ignore other early stdin (best-effort); only initialize is used as the poison trigger
          // to keep this test deterministic across environments.
          continue;
        }

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, { sessionId: 'test-session' });
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('AcpBackend.initialize (init delay)', () => {
  it('fails fast when the agent discards early stdin and transport does not delay initialize', async () => {
    // Defensive: other test files may enable fake timers and forget to restore them.
    vi.useRealTimers();

    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-init-nodelay-'));
    // Keep timings small so the test stays deterministic while still simulating "stdin too early" poisoning.
    const scriptPath = writePoisonOnEarlyInputAcpAgentScript({ dir, readyAfterMs: 200 });
    let backendForCleanup: AcpBackend | undefined;

    try {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        transportHandler: {
          agentName: 'test',
          // Keep this low-ish so the test is fast, but not so low that it flakes under load.
          getInitTimeout: () => 400,
          getToolPatterns: () => [] as ToolPattern[],
        } satisfies TransportHandler,
      });
      backendForCleanup = backend;

      await expect(backend.startSession()).rejects.toThrow(/Initialize timeout/i);
    } finally {
      await backendForCleanup?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('waits for transport-provided init delay before sending initialize (prevents swallowed stdin)', async () => {
    // Defensive: other test files may enable fake timers and forget to restore them.
    vi.useRealTimers();

    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-init-delay-'));
    // The "ready" window is relative to when the child script actually starts executing.
    // Under load, process start + module evaluation can be slower than we'd like, so keep
    // headroom to make this test deterministic across CI runners.
    const scriptPath = writePoisonOnEarlyInputAcpAgentScript({ dir, readyAfterMs: 500 });
    let backendForCleanup: AcpBackend | undefined;

    try {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        transportHandler: {
          agentName: 'test',
          // The point of this test is that initDelay prevents "early stdin" poisoning; use
          // a realistic timeout to avoid flakes under load.
          getInitTimeout: () => 5_000,
          // This is the behavior we need for Gemini CLI ACP: don't send initialize immediately.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          // The delay needs headroom under load so it isn't "consumed" before the agent has
          // actually started reading ACP stdin.
          getInitDelayMs: () => 2_500,
          getToolPatterns: () => [] as ToolPattern[],
        } as unknown as TransportHandler,
      });
      backendForCleanup = backend;

      await expect(backend.startSession()).resolves.toMatchObject({ sessionId: 'test-session' });
    } finally {
      await backendForCleanup?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
