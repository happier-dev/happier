import { describe, expect, it } from 'vitest';

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';

function writeFakeAcpAgentScript(params: { dir: string; stderrAfterPromptText: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent-stderr-artifacts.mjs');
  const stderrAfterPromptText = JSON.stringify(params.stderrAfterPromptText);
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
          process.stderr.write(String(${stderrAfterPromptText}) + '\\n');
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'ok' },
              },
            },
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

async function waitForArtifactsFile(dir: string, opts: { timeoutMs: number }): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    const entries = readdirSync(dir, { withFileTypes: true });
    const file = entries.find((e) => e.isFile() && e.name.includes('stderr') && e.name.endsWith('.log'));
    if (file) return join(dir, file.name);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for artifacts file in ${dir}`);
}

async function waitForFileToContain(filePath: string, needle: string, opts: { timeoutMs: number }): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    const content = readFileSync(filePath, 'utf8');
    if (content.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const content = readFileSync(filePath, 'utf8');
  throw new Error(`Timed out waiting for ${filePath} to contain "${needle}". Current content length: ${content.length}`);
}

describe('AcpBackend subprocess stderr artifacts', () => {
  it('writes stderr to a bounded artifacts file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-stderr-artifacts-'));
    const artifactsRoot = mkdtempSync(join(tmpdir(), 'happier-debug-artifacts-'));
    const prevRoot = process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;

    try {
      process.env.HAPPIER_DEBUG_ARTIFACTS_DIR = artifactsRoot;
      process.env.HAPPIER_SUBPROCESS_STDERR_MAX_BYTES = '10000';

      const scriptPath = writeFakeAcpAgentScript({ dir, stderrAfterPromptText: 'boom on stderr' });

      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        transportHandler: {
          agentName: 'test',
          getInitTimeout: () => 5_000,
          getToolPatterns: () => [] as ToolPattern[],
          getIdleTimeout: () => 1,
        } satisfies TransportHandler,
      });

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');

        const expectedDir = join(artifactsRoot, 'subprocess', 'test');
        const filePath = await waitForArtifactsFile(expectedDir, { timeoutMs: 2_000 });
        await waitForFileToContain(filePath, 'boom on stderr', { timeoutMs: 2_000 });
      } finally {
        await backend.dispose().catch(() => {});
      }
    } finally {
      if (prevRoot === undefined) delete process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
      else process.env.HAPPIER_DEBUG_ARTIFACTS_DIR = prevRoot;
      rmSync(dir, { recursive: true, force: true });
      rmSync(artifactsRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
