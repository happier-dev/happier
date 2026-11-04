import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

const CALL_LOG_FILE_NAME = 'acp-fork-calls.log';

/**
 * `negotiateForkSession` mirrors the only fact the host's fork policy reads from
 * a real Agent: what `initialize` advertised on this exact connection. A case
 * that exercises the fork round trip must advertise it, or it stops at the
 * negotiation refusal and never reaches the behavior it exists to cover.
 */
function writeForkAgentScript(params: {
  dir: string;
  negotiateForkSession?: boolean;
  implementsForkSession?: boolean;
}): string {
  const negotiateForkSession = params.negotiateForkSession !== false;
  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-public-fork.mjs',
    source: `
      import { appendFileSync } from 'node:fs';
      import { join } from 'node:path';
      const decoder = new TextDecoder();
      let buffer = '';
      const callLogPath = join(${JSON.stringify(params.dir)}, ${JSON.stringify(CALL_LOG_FILE_NAME)});
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      const ok = (id, result) => send({ jsonrpc: '2.0', id, result });

      process.stdin.on('data', (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (typeof request?.method === 'string') appendFileSync(callLogPath, request.method + '\\n');
          if (request.method === 'initialize') {
            ok(request.id, {
              protocolVersion: 1,
              authMethods: [],
              agentCapabilities: ${negotiateForkSession
                ? '{ sessionCapabilities: { fork: {} } }'
                : '{ sessionCapabilities: {} }'},
            });
          } else if (request.method === 'session/fork') {
            if (${params.implementsForkSession === false}) {
              send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
              continue;
            }
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

function readCalledMethods(dir: string): readonly string[] {
  try {
    return readFileSync(join(dir, CALL_LOG_FILE_NAME), 'utf8')
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The private negotiated-capability record an `initialize` round trip would have
 * produced. Cases that inject a connection directly skip that round trip, so
 * they must state the handshake fact they are standing in for.
 */
function seedNegotiatedForkSupport(backend: AcpBackend): void {
  (backend as any).negotiatedSessionCapabilities = Object.freeze({
    loadSession: false,
    listSessions: false,
    forkSession: true,
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
    seedNegotiatedForkSupport(backend);

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
    seedNegotiatedForkSupport(backend);

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

  it('preserves the unsupported fork error when a negotiated agent rejects the method', async () => {
    await withTempDir('happier-acp-fork-unsupported-', async dir => {
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [writeForkAgentScript({ dir, implementsForkSession: false })],
      });
      try {
        await expect(backend.forkSession({ sessionId: ' parent\nsession ' }))
          .rejects.toThrow(/does not support ACP session\/fork/i);
        expect(readCalledMethods(dir)).toContain('session/fork');
      } finally { await backend.dispose(); }
    });
  });

  it('throws when the session id is empty', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });

    await expect((backend as any).forkSession({ sessionId: '   ' })).rejects.toThrow(/Session ID is required/);
  });

  it('fails before session/fork when the connection never negotiated it', async () => {
    // `session/fork` is UNSTABLE and not every Agent that answers the method
    // advertises it. Discovering non-support from the reply means the request
    // already reached the Agent; the handshake has to decide first, exactly as
    // it does for `session/load`.
    await withTempDir('happier-acp-fork-negotiation-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeForkAgentScript({ dir, negotiateForkSession: false })],
      });

      try {
        await expect(backend.forkSession({ sessionId: ' parent\nsession ' }))
          .rejects.toThrow(/did not negotiate ACP session\/fork support during initialize/);

        const methods = readCalledMethods(dir);
        expect(methods).toContain('initialize');
        expect(methods).not.toContain('session/fork');
        // A refused fork must surface, never silently become a fresh session.
        expect(methods).not.toContain('session/new');
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);
});
