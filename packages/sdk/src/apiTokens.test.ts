import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';

import { connect } from './index.js';

const PARENT_ID = '123e4567-e89b-42d3-a456-426614174000';
const PARENT = `hap_v1_${PARENT_ID}_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
const CHILD_ID = '223e4567-e89b-42d3-a456-426614174001';
const GRANT = {
  v: 1 as const, actions: { families: [], ids: ['session.message.send'] },
  targets: { sessions: ['session-1'], machines: [] }, approve: false,
  origins: ['https://dashboard.example'], models: null, permissionModes: null, create: null,
};
const EXPIRES_AT = '2030-01-01T00:00:00.000Z';
const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
  sockets.clear();
});

async function endpoint(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test endpoint.');
  return `http://127.0.0.1:${address.port}`;
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

describe('API-token Home operations', () => {
  it('mints a strict child request, reads self and revokes the child without an Action or machine target', async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const home = await endpoint(async (request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${PARENT}`);
      const body = request.method === 'POST' ? await bodyOf(request) : undefined;
      requests.push({ path: request.url ?? '', method: request.method ?? '', ...(body ? { body } : {}) });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/auth/api-tokens/children/create') {
        const input = body as { tokenId: string };
        response.end(JSON.stringify({
          token: `hap_v1_${input.tokenId}_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
          apiToken: { tokenId: input.tokenId, label: { content: { t: 'plain', v: 'Browser' }, recipientEnvelope: null }, displayPrefix: `hap_v1_${input.tokenId.slice(0, 8)}`,
            createdAt: '2026-09-30T00:00:00.000Z', lastUsedAt: null, expiresAt: EXPIRES_AT,
            hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: GRANT,
            parentTokenId: PARENT_ID, activeChildCount: 0, embedConfig: null },
        }));
      } else if (request.url === '/v1/auth/api-tokens/self') {
        response.end(JSON.stringify({ accountId: 'account-1', accountEncryptionMode: 'plain', credentialId: PARENT_ID,
          parentTokenId: null, expiresAt: EXPIRES_AT,
          grant: GRANT, embedConfig: null }));
      } else response.end(JSON.stringify({ revoked: true }));
    });
    const client = connect({ endpoint: home, token: PARENT });
    try {
      const created = await client.apiTokens.createChild({ label: 'Browser', expiresAt: EXPIRES_AT,
        grant: GRANT, requireCreatedByChildTokenId: CHILD_ID });
      expect(created.apiToken.grant).toEqual(GRANT);
      // The plaintext label is sealed for the token it names, in the Account's current mode.
      expect(requests[0]).toEqual({ path: '/v1/auth/api-tokens/self', method: 'GET' });
      expect(requests[1]).toEqual({ path: '/v1/auth/api-tokens/children/create', method: 'POST',
        body: { tokenId: created.apiToken.tokenId, label: { content: { t: 'plain', v: 'Browser' }, recipients: [] },
          expiresAt: EXPIRES_AT, grant: GRANT, requireCreatedByChildTokenId: CHILD_ID } });
      await expect(client.machine('machine-1').apiTokens.self()).resolves.toMatchObject({ grant: GRANT, credentialId: PARENT_ID });
      await expect(client.apiTokens.revokeChild(created.apiToken.tokenId)).resolves.toEqual({ revoked: true });
      expect(requests[3]).toEqual({ path: '/v1/auth/api-tokens/children/revoke', method: 'POST',
        body: { tokenId: created.apiToken.tokenId } });
      await expect(Reflect.apply(client.apiTokens.createChild, client.apiTokens,
        [{ label: 'Missing expiry', grant: GRANT }])).rejects.toThrow();
      await expect(Reflect.apply(client.apiTokens.createChild, client.apiTokens,
        [{ label: 'Unexpected content access', expiresAt: EXPIRES_AT, grant: GRANT, encryption: {} }])).rejects.toThrow();
      expect(requests).toHaveLength(4);
    } finally { await client.close(); }
  });

  it('refuses to mint a child in an E2EE Account before sending an unsealed label', async () => {
    const paths: string[] = [];
    const home = await endpoint((request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ accountId: 'account-1', accountEncryptionMode: 'e2ee', credentialId: PARENT_ID,
        parentTokenId: null, expiresAt: EXPIRES_AT, grant: GRANT, embedConfig: null }));
    });
    const client = connect({ endpoint: home, token: PARENT });
    try {
      await expect(client.apiTokens.createChild({ label: 'Browser', expiresAt: EXPIRES_AT, grant: GRANT }))
        .rejects.toMatchObject({ code: 'private_label_unavailable' });
      expect(paths).toEqual(['/v1/auth/api-tokens/self']);
    } finally { await client.close(); }
  });

  it('reports unsupported_endpoint on daemon-local endpoints', async () => {
    const daemon = await endpoint((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not Found' }));
    });
    const client = connect({ endpoint: daemon, token: PARENT });
    try {
      await expect(client.apiTokens.createChild({ label: 'Browser', expiresAt: EXPIRES_AT, grant: GRANT }))
        .rejects.toMatchObject({ code: 'unsupported_endpoint', status: 404 });
      await expect(client.apiTokens.revokeChild(CHILD_ID)).rejects.toMatchObject({ code: 'unsupported_endpoint' });
      await expect(client.apiTokens.self()).rejects.toMatchObject({ code: 'unsupported_endpoint' });
    } finally { await client.close(); }
  });
});
