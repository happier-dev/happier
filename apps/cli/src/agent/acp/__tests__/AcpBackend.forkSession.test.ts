import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import type { StatusMessage } from '@/agent/core/AgentMessage';

function writeForkAgentScript(params: { dir: string; supportsFork: boolean }): string {
  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: `fake-acp-fork-${params.supportsFork ? 'supported' : 'unsupported'}.mjs`,
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
            if (${JSON.stringify(params.supportsFork)}) {
              if (request.params?.sessionId === ' sess_parent ') {
                ok(request.id, { sessionId: ' sess_child ', _meta: { request: request.params } });
              } else if (request.params?.sessionId === 'sess_parent' || request.params?.sessionId === 'sess_child') {
                ok(request.id, { sessionId: 'sess_child', _meta: { request: request.params } });
              } else {
                send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'session id bytes changed' } });
              }
            } else {
              send({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32601, message: 'Method not found', data: { method: 'session/fork' } },
              });
            }
          } else {
            ok(request.id, {});
          }
        }
      });
    `,
  });
}

describe('AcpBackend forkSession', () => {
  it('calls the stable public session/fork peer and returns the new session id', async () => {
    await withTempDir('happier-acp-fork-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeForkAgentScript({ dir, supportsFork: true })],
      });
      const statuses: StatusMessage[] = [];
      backend.onMessage((message) => { if (message.type === 'status') statuses.push(message); });

      try {
        const result = await backend.forkSession({ sessionId: ' sess_parent ' });
        expect(result).toEqual({ sessionId: ' sess_child ' });
        const readiness = statuses.find((message) => message.status === 'idle');
        expect(readiness).toBeDefined();
        expect(readiness?.turnFinished).toBeUndefined();
      } finally {
        await backend.dispose();
      }
    });
  });

  it('preserves a clear unsupported-session/fork error for method-not-found agents', async () => {
    await withTempDir('happier-acp-fork-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeForkAgentScript({ dir, supportsFork: false })],
      });

      try {
        await expect(backend.forkSession({ sessionId: 'sess_parent' }))
          .rejects.toThrow(/does not support ACP session\/fork/i);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('clears parent-session tool lifecycle state before adopting a forked session', async () => {
    await withTempDir('happier-acp-fork-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeForkAgentScript({ dir, supportsFork: true })],
      });
      const internals = backend as unknown as {
        toolCalls: {
          observe(patch: { toolCallId: string; status: 'in_progress' }): boolean;
          activeSize: number;
        };
      };

      try {
        await backend.forkSession({ sessionId: 'sess_parent' });
        internals.toolCalls.observe({ toolCallId: 'parent-call', status: 'in_progress' });
        expect(internals.toolCalls.activeSize).toBe(1);

        await backend.forkSession({ sessionId: 'sess_child' });

        expect(internals.toolCalls.activeSize).toBe(0);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('throws when the session id is empty', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: '/test/cwd',
      command: 'noop',
    });

    await expect(backend.forkSession({ sessionId: '   ' })).rejects.toThrow(/Session ID is required/);
  });
});
