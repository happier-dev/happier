import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeForkAgentScript(params: { dir: string }): string {
  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-public-fork.mjs',
    source: `
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
            ok(request.id, { protocolVersion: 1, authMethods: [] });
          } else if (request.method === 'session/fork') {
            if (request.params?.sessionId !== ' parent\\nsession ') {
              send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'session id bytes changed' } });
              continue;
            }
            ok(request.id, { sessionId: ' child\\nsession ' });
          } else {
            ok(request.id, {});
          }
        }
      });
    `,
  });
}

describe('AcpBackend forkSession', () => {
  it('forks through the public SDK connection while preserving opaque session-id bytes', async () => {
    await withTempDir('happier-acp-public-fork-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeForkAgentScript({ dir })],
      });

      try {
        await expect(backend.forkSession({ sessionId: ' parent\nsession ' }))
          .resolves.toEqual({ sessionId: ' child\nsession ' });
      } finally {
        await backend.dispose();
      }
    });
  });

  it('uses the canonical public connection peer to fork and returns the new session id', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });

    const captured: any[] = [];
    const peer = {
      forkSession: async (req: unknown) => {
        captured.push(req);
        return { sessionId: 'sess_child' };
      },
    };
    const connection = { peer };
    (backend as any).connection = connection;

    const res = await (backend as any).forkSession({ sessionId: 'sess_parent' });
    expect(res).toEqual({ sessionId: 'sess_child' });
    expect((backend as any).acpSessionId).toBe('sess_child');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ sessionId: 'sess_parent', cwd: '/test/cwd' });
  });

  it('preserves exact nonblank opaque parent and child session ids', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });
    const parentSessionId = ' parent\nsession ';
    const childSessionId = ' child\nsession ';
    const captured: unknown[] = [];
    (backend as any).connection = {
      peer: {
        forkSession: async (request: unknown) => {
          captured.push(request);
          return { sessionId: childSessionId };
        },
      },
    };

    await expect(backend.forkSession({ sessionId: parentSessionId }))
      .resolves.toEqual({ sessionId: childSessionId });
    expect(captured).toEqual([
      expect.objectContaining({ sessionId: parentSessionId }),
    ]);
    expect((backend as any).acpSessionId).toBe(childSessionId);
  });

  it('closes the canonical public connection exactly once during disposal', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });

    let closeCalls = 0;
    (backend as any).connection = {
      peer: { cancel: async () => {} },
      close: () => { closeCalls += 1; },
      closed: Promise.resolve(),
    };

    await backend.dispose();

    expect(closeCalls).toBe(1);
  });

  it('throws when the agent does not support session/fork', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });

    (backend as any).connection = {};

    await expect((backend as any).forkSession({ sessionId: 'sess_parent' })).rejects.toThrow(/does not support ACP session\/fork/i);
  });

  it('throws when the session id is empty', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });

    await expect((backend as any).forkSession({ sessionId: '   ' })).rejects.toThrow(/Session ID is required/);
  });
});
