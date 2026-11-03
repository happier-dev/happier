import fastify from 'fastify';
import axios from 'axios';
import { expect, it, onTestFinished } from 'vitest';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { acquireRequesterAccountEncryptionCurrentness } from './client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { encodeBase64, encrypt } from './encryption';
import { ApiClient } from './api';
import { readHttpStatus } from './client/httpStatusError';

async function fixture(initialMode: 'plain' | 'e2ee' = 'e2ee') {
  const app = fastify();
  const channel = await createRequesterCurrentnessSocketHarness();
  const accountId = 'machine-sealing-owner';
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const secret = new Uint8Array(32).fill(17);
  let mode = initialMode;
  let revoked = false;
  let modeReads = 0;
  let identityReads = 0;
  let writes = 0;
  let machineReplacement: unknown;
  let registrationBody: unknown;
  let registrationRefusal: string | undefined;
  let afterMachine = () => {};
  const metadata = { host: 'private-host', homeDir: '/home/owner', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/home/owner/.happier' };
  const row = { id: 'machine', storageMode: initialMode,
    metadata: initialMode === 'plain' ? encodePlainMachineStoredContent(metadata) : encodeBase64(encrypt(secret, 'legacy', metadata)),
    metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
    dataEncryptionKey: initialMode === 'plain' ? MACHINE_PLAIN_DATA_KEY_MARKER : null };
  app.get('/v1/account/encryption/currentness', async () => {
    identityReads++;
    return createAccountEncryptionCurrentnessFixture({ mode });
  });
  app.get('/v1/account/encryption', async (_request, reply) => {
    modeReads++;
    return revoked ? reply.code(401).send({ error: 'unauthorized' }) : { mode, updatedAt: 1 };
  });
  app.get('/v1/machines/machine', async () => { afterMachine(); return { machine: row }; });
  app.post('/v1/machines', async (request, reply) => {
    registrationBody = request.body; writes++;
    if (registrationRefusal) return reply.code(400).send({ error: 'invalid-params', reason: registrationRefusal });
    return { machine: row, ...(machineReplacement === undefined ? {} : { machineReplacement }) };
  });
  app.post('/v1/machines/machine/content-key/transition', async () => {
    writes++;
    return { kind: 'refused', code: 'machine_unavailable' };
  });
  const serverBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl });
  onTestFinished(async () => { await holder.dispose(); await channel.close(); await app.close(); });
  await holder.read();
  const api = await ApiClient.create({ token, encryption: initialMode === 'plain' ? null : { type: 'legacy', secret } });
  return {
    api, metadata, channel, serverBaseUrl,
    run: <T>(action: () => T) => runWithServerHttpBaseUrl(serverBaseUrl, action),
    afterMachine(action: () => void) { afterMachine = action; },
    replacement(value: unknown) { machineReplacement = value; },
    registration: () => registrationBody,
    refuseRegistration(reason: string) { registrationRefusal = reason; },
    change(change: 'mode' | 'epoch') { if (change === 'mode') mode = initialMode === 'plain' ? 'e2ee' : 'plain'; else revoked = true; },
    counts: () => ({ modeReads, identityReads, writes }),
  };
}

it.each(['content_public_key_mismatch', 'content_public_key_fingerprint_mismatch'])(
  'preserves a reachable registration content refusal as its typed reason (%s)', async reason => {
    const f = await fixture('plain');
    f.refuseRegistration(reason);
    await expect(f.run(() => f.api.getOrCreateMachine({ machineId: 'machine', metadata: f.metadata })))
      .rejects.toMatchObject({ name: 'MachineContentPublicKeyMismatchError', machineId: 'machine', reason });
  },
);

it('keeps ordinary Machine opening on the connected observed identity', async () => {
  const f = await fixture('plain');
  for (let i = 0; i < 2; i++) await expect(f.run(() => f.api.getMachine('machine'))).resolves.toMatchObject({ metadata: f.metadata });
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 0, writes: 0 });
});

it('keeps final Machine transition authority on the captured request transport', async () => {
  const f = await fixture();
  f.afterMachine(() => f.change('mode'));
  const paths: string[] = [];
  const result: unknown = await runWithServerHttpBaseUrl('http://unrelated-home.invalid', () => f.api.prepareMachineContentKey('machine', {
    serverHttpBaseUrl: f.serverBaseUrl,
    request: async request => {
      paths.push(`${request.method} ${request.path}`);
      return axios.request({ method: request.method, url: `${f.serverBaseUrl}${request.path}`, data: request.body,
        headers: { 'X-Captured-Authority': 'signed' }, signal: request.signal });
    },
  })).catch((error: unknown) => error);
  expect(result).toMatchObject({ code: 'machine_content_key_unavailable' });
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 1, writes: 0 });
  expect(paths).toEqual(['GET /v1/machines/machine', 'GET /v1/account/encryption']);
});

it.each([
  ['registration', 'plain', 'mode'], ['registration', 'e2ee', 'mode'], ['registration', 'e2ee', 'epoch'],
  ['transition', 'e2ee', 'mode'], ['transition', 'e2ee', 'epoch'],
] as const)('freshly refuses Machine %s from %s after committed %s before socket delivery', async (operation, mode, change) => {
  const f = await fixture(mode);
  f.afterMachine(() => f.change(change));
  const result: unknown = await f.run(() => operation === 'registration'
    ? f.api.getOrCreateMachine({ machineId: 'machine', metadata: f.metadata })
    : f.api.prepareMachineContentKey('machine')).catch((error: unknown) => error);
  expect(f.channel.clients.every(client => client.connected)).toBe(true);
  expect(f.counts().writes).toBe(0);
  if (operation === 'registration' && change === 'epoch') expect(readHttpStatus(result)).toBe(401);
  else expect(result).toMatchObject({ code: 'machine_content_key_unavailable' });
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 1, writes: 0 });
});
