import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { supportsSessionMcpLocalTransport } from './sessionMcpLocalTransport';
import { connectSessionMcpClient } from './sessionMcpLocalClient';

describe.skipIf(!supportsSessionMcpLocalTransport())('Session MCP socket credential transport', () => {
  it.each([
    { status: 302, sameOrigin: false }, { status: 307, sameOrigin: false },
    { status: 308, sameOrigin: false }, { status: 307, sameOrigin: true },
    { status: 200, sameOrigin: true },
  ])('scopes HTTP $status (same-origin=$sameOrigin) through the real SDK and Undici dispatcher', async ({ status, sameOrigin }) => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-redirect-'));
    const socketPath = join(directory, 'mcp.sock');
    let redirectedRequests = 0;
    let initializeRequests = 0;
    let redirectedAuthorization = false;
    let redirectedBodyBytes = 0;
    let initialMessage: { id?: number; method: string; params?: { protocolVersion?: string } } | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const redirected = request.url?.startsWith('/redirected');
      if (redirected) {
        redirectedRequests += 1;
        redirectedAuthorization ||= Boolean(request.headers.authorization);
        redirectedBodyBytes += Buffer.concat(chunks).byteLength;
      }
      if (request.method !== 'POST' && !redirected) { response.writeHead(405); response.end(); return; }
      const message = request.method === 'POST'
        ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as NonNullable<typeof initialMessage> : initialMessage;
      if (!message) throw new Error('Expected an initialized MCP request');
      if (!redirected && message.method === 'initialize') {
        initializeRequests += 1;
        initialMessage = message;
      }
      if (!redirected && message.method === 'initialize' && status !== 200) {
        response.writeHead(status, { location: `http://${sameOrigin ? 'localhost' : '127.0.0.1'}/redirected?private=hidden` });
        response.end();
      } else if (message.id === undefined) {
        response.writeHead(202); response.end();
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: message.params?.protocolVersion, capabilities: {}, serverInfo: { name: 'local', version: '1' },
        } }));
      }
    });
    server.listen(socketPath);
    await once(server, 'listening');
    try {
      const connection = connectSessionMcpClient({ v: 1, socketPath, bearerToken: 'local-test-capability' });
      const refused = !sameOrigin && (status === 307 || status === 308);
      if (!refused) {
        const connected = await connection;
        await connected.close();
      } else {
        await expect(connection).rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status });
      }
      expect(initializeRequests).toBe(1);
      expect(redirectedRequests).toBe(refused || status === 200 ? 0 : 1);
      expect(redirectedAuthorization).toBe(status !== 200 && sameOrigin);
      if (!sameOrigin) expect(redirectedBodyBytes).toBe(0);
      else if (status !== 200) expect(redirectedBodyBytes).toBeGreaterThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
