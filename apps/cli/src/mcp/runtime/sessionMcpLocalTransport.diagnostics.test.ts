import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { connectSessionMcpClient, readSessionMcpContextFromEnvironment, SESSION_MCP_CONTEXT_FILE_ENV,
  supportsSessionMcpLocalTransport } from './sessionMcpLocalTransport';

describe.skipIf(!supportsSessionMcpLocalTransport())('Session MCP failure diagnostics', () => {
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
