import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeCapabilityAgentScript(params: { dir: string; declareLoadSession: boolean }): string {
  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: params.declareLoadSession ? 'fake-acp-load-capable.mjs' : 'fake-acp-load-incapable.mjs',
    source: `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      rl.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          send({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: 1,
              authMethods: [],
              agentCapabilities: { loadSession: ${params.declareLoadSession} },
            },
          });
          return;
        }
        if (request.method === 'session/new') {
          send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fresh-session' } });
          return;
        }
        send({ jsonrpc: '2.0', id: request.id, result: {} });
      });
    `,
  });
}

describe('AcpBackend session load capability', () => {
  it('reports session load support when the agent advertises loadSession', async () => {
    await withTempDir('happier-acp-load-capable-', async (dir) => {
      const scriptPath = writeCapabilityAgentScript({ dir, declareLoadSession: true });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });
      try {
        await backend.startSession();
        expect(backend.supportsSessionLoad()).toBe(true);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('reports no session load support when the agent omits the capability', async () => {
    await withTempDir('happier-acp-load-incapable-', async (dir) => {
      const scriptPath = writeCapabilityAgentScript({ dir, declareLoadSession: false });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });
      try {
        await backend.startSession();
        expect(backend.supportsSessionLoad()).toBe(false);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('reports no session load support before initialize completes', () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/tmp',
      command: process.execPath,
      args: ['-e', ''],
    });
    expect(backend.supportsSessionLoad()).toBe(false);
  });
});
