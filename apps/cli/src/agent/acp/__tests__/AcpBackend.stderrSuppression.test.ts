import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '@/ui/logger';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';
import { AcpBackend } from '../AcpBackend';

function writeFakeStderrAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-stderr-agent.mjs');
  writeFileSync(
    scriptPath,
    `
      process.stderr.write('Error handling notification {"jsonrpc":"2.0","method":"_kiro.dev/metadata"} {"code":-32601,"message":"\\\\\\"Method not found\\\\\\": _kiro.dev/metadata"}\\n');
      const decoder = new TextDecoder();
      let buf = '';
      function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
      process.stdin.on('data', (chunk) => {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [] } });
            continue;
          }
          if (msg.method === 'session/new') {
            send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'test-session' } });
            continue;
          }
          if (msg.id !== undefined && msg.id !== null) {
            send({ jsonrpc: '2.0', id: msg.id, result: {} });
          }
        }
      });
    `,
    'utf8',
  );
  return scriptPath;
}

describe('AcpBackend stderr suppression', () => {
  beforeEach(() => {
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  it('does not debug-log stderr when the transport suppresses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-stderr-suppress-'));
    const scriptPath = writeFakeStderrAgentScript({ dir });
    let backendForCleanup: AcpBackend | undefined;

    try {
      const backend = new AcpBackend({
        agentName: 'kiro',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        transportHandler: {
          agentName: 'kiro',
          getInitTimeout: () => 1_000,
          getToolPatterns: () => [] as ToolPattern[],
          getIdleTimeout: () => 1,
          handleStderr: () => ({ message: null, suppress: true }),
        } satisfies TransportHandler,
      });
      backendForCleanup = backend;

      await backend.startSession();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stderrDebugCalls = vi.mocked(logger.debug).mock.calls.filter(([first]) =>
        typeof first === 'string' && first.includes('Error handling notification'),
      );
      expect(stderrDebugCalls).toHaveLength(0);
    } finally {
      await backendForCleanup?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
