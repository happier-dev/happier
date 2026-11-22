import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { handleActionsCommand } from '@/cli/commands/actions';
import { handleToolsCommand } from '@/cli/commands/tools';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { SESSION_MCP_CONTEXT_FILE_ENV, supportsSessionMcpLocalTransport } from './sessionMcpLocalTransport';
import { connectSessionMcpClient, readSessionMcpContextFromEnvironment } from './sessionMcpLocalClient';

describe.skipIf(!supportsSessionMcpLocalTransport())('Session MCP failure diagnostics', () => {
  it.each([
    { errno: 'EPERM', reason: 'socket_denied', args: ['list'] },
    { errno: 'ENOENT', reason: 'socket_absent', args: ['call', '--source', 'happier', '--tool', 'action_execute', '--args-json', '{}'] },
  ])('reports a sanitized $errno cause in the shell CLI', async ({ errno, reason, args }) => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-connect-'));
    const socketPath = join(directory, 'private.sock');
    const contextPath = join(directory, 'private-context.json');
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    const originalConnect = net.connect;
    const connect = vi.spyOn(net, 'connect').mockImplementation((...connectArgs: unknown[]) => {
      const options = connectArgs[0];
      if (!options || typeof options !== 'object' || !('path' in options) || options.path !== socketPath || errno !== 'EPERM') {
        return Reflect.apply(originalConnect, net, connectArgs);
      }
      const socket = new net.Socket();
      process.nextTick(() => socket.destroy(Object.assign(new Error(`connect EPERM ${socketPath}`), { code: errno })));
      return socket;
    });
    try {
      await writeFile(contextPath, JSON.stringify({ v: 1, socketPath }));
      vi.stubEnv(SESSION_MCP_CONTEXT_FILE_ENV, contextPath);
      await handleToolsCommand([...args, '--session-agent-bridge', '--json']);
      const expectedFailure = { ok: false, error: {
        code: 'mcp_socket_access_unavailable',
        failureCause: { phase: 'session_mcp.connect', errorCode: errno, nativeErrorReason: reason },
      } };
      expect(output.json()).toMatchObject(expectedFailure);
      expect(output.chunks.join('')).not.toContain(directory);
      if (errno === 'EPERM') {
        output.chunks.length = 0;
        await handleActionsCommand(['invoke', 'machines.list', '--input-json', '{}', '--json']);
        expect(output.json()).toMatchObject(expectedFailure);
        expect(output.chunks.join('')).not.toContain(directory);
        await expect(handleToolsCommand([...args, '--session-agent-bridge']))
          .rejects.toThrow(/sandbox blocked.*native Happier tool.*shell without the sandbox/u);
      }
    } finally {
      connect.mockRestore();
      output.restore();
      process.exitCode = previousExitCode;
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('identifies context-file failures without exposing the selected path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-context-'));
    try {
      const failure = await readSessionMcpContextFromEnvironment({
        [SESSION_MCP_CONTEXT_FILE_ENV]: join(directory, 'private-context.json'),
      }).catch(error => error);
      expect(failure).toMatchObject({ code: 'mcp_socket_access_unavailable', phase: 'context_read' });
      expect(failure.message).toContain('context_read');
      expect(failure.message).not.toContain(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([401, 503])('retains HTTP %i as a content-free upstream rejection', async status => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-http-failure-'));
    const socketPath = join(directory, 'mcp.sock');
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end('private upstream detail');
    });
    server.listen(socketPath);
    await once(server, 'listening');
    try {
      const failure = await connectSessionMcpClient({ v: 1, socketPath, bearerToken: 'private-capability' }).catch(error => error);
      expect(failure).toMatchObject({ code: status === 401 ? 'not_authenticated' : 'mcp_socket_access_unavailable',
        phase: 'client_connect', httpStatus: status });
      expect(failure.message).toContain(`httpStatus=${status}`);
      expect(failure.message).not.toMatch(/private|mcp-http-failure/u);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

});
