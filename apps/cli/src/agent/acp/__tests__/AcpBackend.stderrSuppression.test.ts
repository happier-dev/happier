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
import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeStderrAgentScript(params: { dir: string }): string {
  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-stderr-agent.mjs',
    source: `
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
  });
}

describe('AcpBackend stderr suppression', () => {
  beforeEach(() => {
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  it('does not debug-log stderr when the transport suppresses it', async () => {
    await withTempDir('happier-acp-stderr-suppress-', async (dir) => {
      const scriptPath = writeFakeStderrAgentScript({ dir });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'kiro',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            agentName: 'kiro',
            initTimeoutMs: 1_000,
            idleTimeoutMs: 1,
            handleStderr: () => ({ message: null, suppress: true }),
          }),
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
      }
    });
  });
});
