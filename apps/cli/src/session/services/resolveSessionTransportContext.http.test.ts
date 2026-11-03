import { createServer, type ServerResponse } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { V2SessionByIdResponseSchema, V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionListResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';

const sessionId = 'c123456789012345678901234';

describe('fresh Session transport HTTP resolution', () => {
  it.each([
    { failure: '503', code: 'server_unreachable' },
    { failure: 'reset', code: 'server_unreachable' },
    { failure: '401', code: 'not_authenticated' },
    { failure: 'invalid', code: 'account_encryption_currentness_unavailable' },
  ])('preserves signed-request authority and classifies currentness $failure before transport publication', async ({ failure, code }) => {
    const authorizations: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') {
        if (failure === 'reset') {
          request.socket.destroy();
          return;
        }
        response.writeHead(failure === 'invalid' ? 200 : Number(failure)).end('{}');
      } else if (request.url === `/v2/sessions/${sessionId}`) {
        response.end(JSON.stringify(V2SessionByIdResponseSchema.parse({ session: createSessionRecordFixture({
          id: sessionId, encryptionMode: 'plain', metadata: '{}',
        }) })));
      } else {
        response.writeHead(404).end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback HTTP address unavailable');
    try {
      await expect(runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => resolveSessionTransportContext({
        reason: 'session-control',
        credentials: { token: 'must-not-be-used', encryption: null }, idOrPrefix: sessionId,
        // The signature issuer is outside this adapter; inspect its supplied HTTP authority, never substitute the host token.
        resolveAuthorizationHeaders: () => ({ Authorization: 'signed-invocation-fixture' }),
        serverFeaturesSnapshot: { status: 'unsupported', reason: 'endpoint_missing' },
      }))).rejects.toMatchObject({ code });
      expect(authorizations.length).toBeGreaterThan(0);
      expect(authorizations.every(value => value === 'signed-invocation-fixture')).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(['current', 'unavailable'] as const)('overlaps exact detail with a held fresh Account witness and fails closed when %s', async witness => {
    const reason = witness === 'current' ? 'session-control' : 'session-query';
    const detailPurposes: Array<string | string[] | undefined> = [];
    let witnessResponse: ServerResponse | undefined;
    let detailResponded = false;
    let settled = false;
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') {
        witnessResponse = response;
        return;
      }
      if (request.url === `/v2/sessions/${sessionId}`) {
        detailPurposes.push(request.headers['x-happier-request-purpose']);
        const body = V2SessionByIdResponseSchema.parse({ session: createSessionRecordFixture({
          id: sessionId, encryptionMode: 'plain', metadata: '{}',
        }) });
        response.end(JSON.stringify(body));
        detailResponded = true;
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback HTTP address unavailable');
    const pending = runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => resolveSessionTransportContext({
      reason,
      credentials: { token: 'transport-fixture', encryption: null }, idOrPrefix: sessionId,
      serverFeaturesSnapshot: { status: 'unsupported', reason: 'endpoint_missing' },
    }));
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await expect.poll(() => witnessResponse !== undefined).toBe(true);
      await expect.poll(() => detailResponded).toBe(true);
      expect(detailPurposes).toEqual([`session-detail:${reason}`]);
      await setImmediate();
      expect(settled).toBe(false);
      if (witness === 'current') {
        witnessResponse!.end(JSON.stringify(AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
          updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null })));
        await expect(pending).resolves.toMatchObject({ ok: true, sessionId, mode: 'plain',
          accountEncryptionCurrentness: { version: 1 } });
      } else {
        witnessResponse!.writeHead(503).end(JSON.stringify({ error: 'unavailable' }));
        await expect(pending).rejects.toMatchObject({ code: 'server_unreachable' });
      }
    } finally {
      witnessResponse?.destroy();
      await pending.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('still opens legacy tag metadata under the same fresh Account mode', async () => {
    let witnessResponse: ServerResponse | undefined;
    let tagLookupRequested = false;
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
      metadata: JSON.stringify({ tag: 'legacy-tag' }) });
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') {
        witnessResponse = response;
      } else if (request.url === '/v2/sessions/lookup-by-tags') {
        tagLookupRequested = true;
        response.writeHead(404).end(JSON.stringify({ statusCode: 404, error: 'Not Found',
          message: 'Route POST:/v2/sessions/lookup-by-tags not found' }));
      } else if (request.url === `/v2/sessions/${sessionId}`) {
        response.end(JSON.stringify(V2SessionByIdResponseSchema.parse({ session })));
      } else if (request.url?.startsWith('/v2/sessions?')) {
        response.end(JSON.stringify(V2SessionListResponseSchema.parse(createSessionListResponseFixture([session]))));
      } else if (request.url?.startsWith('/v2/sessions/archived?')) {
        response.end(JSON.stringify(V2SessionListResponseSchema.parse(createSessionListResponseFixture([]))));
      } else {
        response.writeHead(404).end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback HTTP address unavailable');
    const pending = runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => resolveSessionTransportContext({
      reason: 'session-control',
      credentials: { token: 'transport-fixture', encryption: null }, idOrPrefix: 'legacy-tag',
      serverFeaturesSnapshot: { status: 'unsupported', reason: 'endpoint_missing' },
    }));
    void pending.catch(() => {});
    try {
      await expect.poll(() => witnessResponse !== undefined).toBe(true);
      await expect.poll(() => tagLookupRequested).toBe(true);
      witnessResponse!.end(JSON.stringify(AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
        updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null })));
      await expect(pending).resolves.toMatchObject({ ok: true, sessionId, mode: 'plain' });
    } finally {
      witnessResponse?.destroy();
      await pending.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
