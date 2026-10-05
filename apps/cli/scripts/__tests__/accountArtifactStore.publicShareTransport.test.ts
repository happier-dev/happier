import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';

import { createAuthenticatedTestApp } from '../../../server/sources/app/api/testkit/sqliteFastify';
import { registerStoredContentPublicShareRoutes } from '../../../server/sources/app/api/routes/share/registerStoredContentPublicShareRoutes';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountArtifactStore } from '../../src/api/artifacts/accountArtifactStore';

const persistence = vi.hoisted(() => {
  const state = { removed: false };
  const artifactId = '00000000-0000-4000-8000-000000000011';
  const share = {
    id: '00000000-0000-4000-8000-000000000022', artifactId, sessionId: null,
    createdByUserId: 'owner', tokenHash: Buffer.alloc(32), encryptedDataKey: null,
    keyDerivation: 'fragment_v1', expiresAt: null, maxUses: null, useCount: 0,
    isConsentRequired: false, createdAt: new Date(1), updatedAt: new Date(1),
  };
  const tx = {
    artifact: { findFirst: async () => ({ id: artifactId }) },
    publicSessionShare: {
      findUnique: async () => state.removed ? null : share,
      findMany: async () => state.removed ? [] : [share],
      deleteMany: async () => { state.removed = true; return { count: 1 }; },
    },
    $queryRawUnsafe: async () => [{ cursor: 1 }],
  };
  return { state, share, tx, db: { ...tx, $transaction: async <T>(fn: (transaction: typeof tx) => Promise<T>) => fn(tx) } };
});

// Only persistence and outbound socket delivery are substituted. The HTTP
// parser, Action/public-link owner, authorization, transaction and route run real.
vi.mock('../../../server/sources/storage/db', () => ({ db: persistence.db }));
vi.mock('../../../server/sources/app/events/connectionEventRouter', () => ({
  eventRouter: { emitUpdate: vi.fn() },
}));

describe('Account Artifact public-link HTTP transport', () => {
  it('revokes through the real server route and denies subsequent public reads', async () => {
    persistence.state.removed = false;
    persistence.share.tokenHash = createHash('sha256').update('lookup').digest();
    const app = createAuthenticatedTestApp();
    let deleteResponse: { status: number; body: unknown } | undefined;
    app.addHook('onSend', async (request: { method: string }, reply: { statusCode: number }, payload: string) => {
      if (request.method === 'DELETE') deleteResponse = { status: reply.statusCode, body: JSON.parse(payload) };
      return payload;
    });
    app.addHook('onRequest', async (request: { headers: Record<string, unknown> }) => {
      if (request.headers.authorization === 'Bearer token') request.headers['x-test-user-id'] = 'owner';
    });
    app.get(`/v1/artifacts/${persistence.share.artifactId}`, async () => ({
      id: persistence.share.artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent({ kind: 'text', title: 'Note' }),
      body: encodePlainArtifactStoredContent({ body: 'Private note' }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    }));
    registerStoredContentPublicShareRoutes(app);
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
      const result = await runWithServerHttpBaseUrl(baseUrl, () => store.publicLinks({
        actionId: 'artifact.public_link.revoke',
        input: { artifactId: persistence.share.artifactId, shareId: persistence.share.id },
      })).catch((error: unknown) => error);
      expect(deleteResponse).toEqual({ status: 200, body: { success: true } });
      expect(result).toMatchObject({ revoked: true });
      expect(persistence.state.removed).toBe(true);
      const after = await app.inject({ method: 'GET', url: '/v1/public-shares/lookup/content' });
      expect(after.statusCode).toBe(404);
      expect(after.json()).toMatchObject({ error: 'public_share_unavailable' });
    } finally {
      await app.close();
    }
  });

  it('preserves JSON serialization for the neighboring body-bearing grant DELETE', async () => {
    const app = createAuthenticatedTestApp();
    const input = { artifactId: persistence.share.artifactId, principal: { kind: 'account' as const, accountId: 'recipient' } };
    let received: unknown;
    app.delete(`/v1/artifacts/${input.artifactId}/access/grants`, async (request: { body: unknown; headers: Record<string, unknown> }) => {
      received = { body: request.body, contentType: request.headers['content-type'], authorization: request.headers.authorization };
      return { artifactId: input.artifactId, ownerAccountId: 'owner', access: null, grants: [], changed: true };
    });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
      await runWithServerHttpBaseUrl(baseUrl, () => store.accessGrants.remove(input));
      expect(received).toEqual({ body: input, contentType: 'application/json', authorization: 'Bearer token' });
    } finally {
      await app.close();
    }
  });

  it('also sends the ordinary Artifact DELETE without a JSON body claim', async () => {
    const app = createAuthenticatedTestApp();
    let received: unknown;
    app.delete(`/v1/artifacts/${persistence.share.artifactId}`, async (request: { body: unknown; headers: Record<string, unknown> }) => {
      received = { body: request.body, contentType: request.headers['content-type'] };
      return { success: true };
    });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
      await expect(runWithServerHttpBaseUrl(baseUrl, () => store.delete(persistence.share.artifactId))).resolves.toEqual({ ok: true });
      expect(received).toEqual({ body: undefined, contentType: undefined });
    } finally {
      await app.close();
    }
  });
});
