import { createServer, type ServerResponse } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { V2SessionByIdResponseSchema, SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import { createDaemonSessionMutationCustody } from '@/daemon/connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

const sessionId = 'c123456789012345678901234';

describe('fresh Session transport HTTP resolution', () => {
  it('does not turn a missing exact daemon mutation target into tag or inventory scans', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify(AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
          updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null })));
      } else if (request.url === '/v2/sessions/lookup-by-tags') {
        response.end(JSON.stringify(SessionLookupByTagsResponseV2Schema.parse({ sessions: [] })));
      } else if (request.url === '/v2/sessions?limit=200' || request.url === '/v2/sessions/archived?limit=200') {
        response.end(JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }));
      } else {
        response.writeHead(404).end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback HTTP address unavailable');
    const custody = createDaemonSessionMutationCustody({ credentials: { token: 'transport-fixture', encryption: null } });
    try {
      await expect(runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => custody.stageTranscriptEvent({
        sessionId, eventId: 'retained-presentation', data: { type: 'goal-changed' },
      }))).rejects.toMatchObject({ code: 'session_unavailable' });
      expect(requests.sort()).toEqual(['/v1/account/encryption/currentness', `/v2/sessions/${sessionId}`].sort());
      requests.length = 0;
      await expect(runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => custody.bindRecoveredJournals([sessionId])))
        .resolves.toEqual({ boundSessionIds: [], retainedSessionIds: [sessionId] });
      expect(requests.sort()).toEqual(['/v1/account/encryption/currentness', `/v2/sessions/${sessionId}`].sort());
    } finally {
      await custody.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

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

  // OWNER-RULINGS 2026-11-16 "Remove overbuilt re-reads": a read-only caller borrows the held,
  // push-updated Account observation; only seals keep a fresh witness. The Session record stays fresh.
  it('borrows the held Account observation for read usage and keeps the fresh witness otherwise', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify(AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
          updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null })));
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
    const base = `http://127.0.0.1:${address.port}`;
    const channel = await createRequesterCurrentnessSocketHarness();
    const token = 'transport-held-fixture';
    const holder = acquireRequesterAccountEncryptionCurrentness({ accountId: 'account-held', token, serverBaseUrl: base });
    const count = (url: string) => requests.filter(value => value === url).length;
    try {
      await runWithServerHttpBaseUrl(base, async () => {
        await holder.read();
        const resolve = (usage?: 'read') => resolveSessionTransportContext({
          reason: 'follow-occurrence', credentials: { token, encryption: null }, idOrPrefix: sessionId,
          serverFeaturesSnapshot: { status: 'unsupported', reason: 'endpoint_missing' }, ...(usage ? { usage } : {}),
        });
        const witnessesBefore = count('/v1/account/encryption/currentness');
        for (let index = 0; index < 3; index += 1) {
          await expect(resolve('read')).resolves.toMatchObject({ ok: true, sessionId, mode: 'plain',
            accountEncryptionCurrentness: { mode: 'plain', version: 1 } });
        }
        expect(count('/v1/account/encryption/currentness') - witnessesBefore).toBe(0);
        expect(count(`/v2/sessions/${sessionId}`)).toBe(3);
        await expect(resolve()).resolves.toMatchObject({ ok: true, sessionId });
        expect(count('/v1/account/encryption/currentness') - witnessesBefore).toBe(1);
      });
    } finally {
      await holder.dispose();
      await channel.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('opens retained legacy tag metadata through the current index under the same fresh Account mode', async () => {
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
        response.end(JSON.stringify(SessionLookupByTagsResponseV2Schema.parse({ sessions: [session] })));
      } else if (request.url === `/v2/sessions/${sessionId}`) {
        response.end(JSON.stringify(V2SessionByIdResponseSchema.parse({ session })));
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
