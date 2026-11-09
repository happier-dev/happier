import fastify from 'fastify';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1 } from '@happier-dev/transfers';
import { expect, it, onTestFinished } from 'vitest';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createCredentialedAccountArtifactStore } from './accountArtifactStore';

async function fixture(initialMode: 'plain' | 'e2ee' = 'plain') {
  const app = fastify();
  const channel = await createRequesterCurrentnessSocketHarness();
  const accountId = 'artifact-sealing-owner';
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  let mode = initialMode;
  let revoked = false;
  let modeReads = 0;
  let identityReads = 0;
  let writes = 0;
  let storedWrites = 0;
  app.addHook('onRequest', async request => { if (request.method === 'POST') writes++; });
  // The genuine HTTP boundary mirrors the server's terminal transaction refusal;
  // server owner suites separately prove the Account-mode storage decision.
  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST') return;
    if (revoked) return reply.code(401).send({ error: 'unauthorized' });
    if (mode !== initialMode) return reply.code(400).send({ error: 'artifact_account_mode_mismatch' });
  });
  app.addContentTypeParser(ARTIFACT_UPLOAD_CONTENT_TYPE_V1, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  let afterHistory = () => {};
  const credentials = { token, encryption: initialMode === 'plain' ? null
    : { type: 'legacy' as const, secret: new Uint8Array(32).fill(17) } };
  const resource = await createResourceDataKey({ credentials, mode: initialMode });
  const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : encodeBase64(encryptWithDataKey(value, resource.dataKey));
  const header = { kind: 'example.v1', title: 'Private document' };
  const stored = { id: 'document', ownerAccountId: accountId, access: 'owner', encryptionMode: initialMode,
    header: encode(header), body: encode({ body: 'original' }),
    dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey, headerVersion: 1, bodyVersion: 1,
    seq: 1, createdAt: 1, updatedAt: 1 };
  app.get('/v1/account/encryption/currentness', async () => {
    identityReads++;
    return createAccountEncryptionCurrentnessFixture({ mode });
  });
  app.get('/v1/account/encryption', async (_request, reply) => {
    modeReads++;
    return revoked ? reply.code(401).send({ error: 'unauthorized' }) : { mode, updatedAt: 1 };
  });
  app.get('/v1/artifacts/document', async () => stored);
  app.get('/v1/artifacts/document/revisions', async () => {
    afterHistory();
    return { revisions: [{ bodyVersion: 1, body: stored.body, createdAt: 1, sizeBytes: stored.body.length }], retentionCount: 10 };
  });
  app.post('/v1/artifacts', async request => {
    storedWrites++;
    const body = request.body as { id: string };
    return { id: body.id, headerVersion: 1, bodyVersion: 1 };
  });
  const acknowledge = async () => { storedWrites++; return { success: true, headerVersion: 2, bodyVersion: 2 }; };
  app.post('/v1/artifacts/document', acknowledge);
  app.post('/v1/artifacts/document/revisions/1/restore', acknowledge);
  app.post(ARTIFACT_UPLOAD_PATH_V1, acknowledge);
  const serverBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl });
  onTestFinished(async () => { await holder.dispose(); await channel.close(); await app.close(); });
  await holder.read();
  const store = createCredentialedAccountArtifactStore(credentials);
  return {
    store, stored, header, serverBaseUrl, channel,
    run: <T>(action: () => T) => runWithServerHttpBaseUrl(serverBaseUrl, action),
    change(change: 'mode' | 'epoch') { if (change === 'mode') mode = initialMode === 'plain' ? 'e2ee' : 'plain'; else revoked = true; },
    afterHistory(action: () => void) { afterHistory = action; },
    counts: () => ({ modeReads, identityReads, writes }),
    storedWrites: () => storedWrites,
  };
}

it('keeps ordinary Artifact opening on the connected observed identity', async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++) await expect(f.run(() => f.store.read('document'))).resolves.toMatchObject({ body: 'original' });
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 0, writes: 0 });
});

it.each(['plain', 'e2ee'] as const)('selects owner-only %s reads before opening foreign private bytes', async mode => {
  const f = await fixture(mode);
  const ownerRead = () => f.run(() => f.store.read('document', { ownerOnly: true, prepareRecipients: false }));
  await expect(ownerRead()).resolves.toMatchObject({ body: 'original', access: 'owner' });
  f.stored.ownerAccountId = 'foreign-account';
  f.stored.access = 'view';
  // Ordinary readers retain their granted access; creation lookup selects owners.
  await expect(f.run(() => f.store.read('document', { prepareRecipients: false })))
    .resolves.toMatchObject({ body: 'original', access: 'view' });
  f.stored.header = 'unreadable';
  f.stored.body = 'unreadable';
  await expect(ownerRead()).resolves.toBeNull();
  await expect(f.run(() => f.store.read('document', { prepareRecipients: false })))
    .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
  expect(f.counts().writes).toBe(0);
});

it('settles an encrypted binary Artifact refusal without resealing after a late plain-mode commit', async () => {
  const f = await fixture('e2ee');
  const result: unknown = await f.run(() => f.store.create({ artifactId: '00000000-0000-4000-8000-000000000012', header: f.header,
    binary: { bytes: new Uint8Array([1, 2, 3]), mime: 'application/octet-stream' },
    beforeWrite: async () => f.change('mode'),
  })).catch((error: unknown) => error);
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 0, writes: 1 });
  expect(f.storedWrites()).toBe(0);
  expect(result).toMatchObject({ code: 'artifact_account_mode_mismatch' });
});

it.each(['create', 'update', 'restore'] as const)('settles the server Artifact %s mode refusal without another mode read or write', async operation => {
  const f = await fixture();
  const beforeWrite = async () => f.change('mode');
  if (operation === 'restore') f.afterHistory(() => f.change('mode'));
  const action = () => operation === 'create'
    ? f.store.create({ artifactId: 'document', header: f.header, body: 'private replacement', beforeWrite })
    : operation === 'update'
      ? f.store.update({ artifactId: 'document', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: f.header, body: 'private replacement', beforeWrite })
      : f.store.revisions.restore({ artifactId: 'document', bodyVersion: 1, expectedRevision: { headerVersion: 1, bodyVersion: 1 } });
  if (operation === 'create') await expect(f.run(action)).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
  else await expect(f.run(action)).resolves.toMatchObject({ ok: false, errorCode: 'artifact_account_mode_mismatch' });
  expect(f.channel.clients.every(client => client.connected)).toBe(true);
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 0, writes: 1 });
  expect(f.storedWrites()).toBe(0);
});

it('settles server credential revocation on the next Artifact write without retrying', async () => {
  const f = await fixture();
  await expect(f.run(() => f.store.update({ artifactId: 'document',
    expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: f.header, body: 'private replacement',
    beforeWrite: async () => f.change('epoch'),
  }))).resolves.toMatchObject({ ok: false, errorCode: 'update_failed' });
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 0, writes: 1 });
  expect(f.storedWrites()).toBe(0);
});
