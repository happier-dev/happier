import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';

/**
 * Agent that records every `session/close` it receives. `advertiseClose` controls whether the
 * handshake advertises `agentCapabilities.sessionCapabilities.close`.
 */
function writeCloseAgentScript(params: { dir: string; advertiseClose: boolean }): string {
  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: `fake-acp-close-${params.advertiseClose ? 'advertised' : 'silent'}.mjs`,
    source: `
      import { appendFileSync } from 'node:fs';
      import { join } from 'node:path';

      const evidenceDir = ${JSON.stringify(params.dir)};
      const decoder = new TextDecoder();
      let buffer = '';
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      const ok = (id, result) => send({ jsonrpc: '2.0', id, result });

      process.stdin.on('data', (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (request.method === 'initialize') {
            ok(request.id, {
              protocolVersion: 1,
              authMethods: [],
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: ${params.advertiseClose ? '{ close: {} }' : '{}'},
              },
            });
          } else if (request.method === 'session/cancel') {
            appendFileSync(join(evidenceDir, 'cancel-requests.log'), String(request.params?.sessionId) + '\\n');
          } else if (request.method === 'session/close') {
            appendFileSync(join(evidenceDir, 'close-requests.log'), String(request.params?.sessionId) + '\\n');
            ok(request.id, {});
          } else if (request.id !== undefined) {
            ok(request.id, {});
          }
        }
      });
    `,
  });
}

describe('AcpBackend replay attachment', () => {
  it('disposes a replay attachment without cancelling or closing the provider child', async () => {
    await withTempDir('happier-acp-replay-detach-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeCloseAgentScript({ dir, advertiseClose: true })],
      });

      await backend.loadSession('child-session');
      await backend.dispose({ preserveProviderSession: true });

      expect(existsSync(join(dir, 'cancel-requests.log'))).toBe(false);
      expect(existsSync(join(dir, 'close-requests.log'))).toBe(false);
    });
  }, 30_000);

});
