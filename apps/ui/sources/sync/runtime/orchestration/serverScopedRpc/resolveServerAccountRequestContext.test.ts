import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataKeyOpeningCancelledError } from '@/sync/encryption/dataKeyOpenings';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage, withAccountE2eeCustody } from '@/auth/storage/tokenStorage';
import { ACCOUNT_MODE_DOWNGRADE_UNVERIFIED } from '@happier-dev/sync-client';
import { getActiveServerSnapshot, setActiveServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resolveServerAccountRequestContext, type ResolvedServerAccountRequestContext } from './resolveServerAccountRequestContext';
import { resolveServerScopedContext } from './resolveServerScopedContext';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { createSocketAccountEncryptionObservation, fetchAccountEncryptionMode, invalidateAccountEncryptionModeCache, invalidateAccountEncryptionModeCacheForChanges } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

// The resolver statically reaches the real transport. Install its genuine SDK
// boundary before that import and compile Sync outside a case-local IO budget.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

let homes: Awaited<ReturnType<typeof serveAccountHomes>>;
let encryptedAccountMode: 'plain' | 'e2ee';
let encryptedAccountSecret: Uint8Array;
const acquired: ResolvedServerAccountRequestContext[] = [];
const encryptedCredentials = { token: createAccountTokenForTests('encrypted-account'),
  secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') };

beforeEach(async () => {
  encryptedAccountMode = 'e2ee';
  encryptedAccountSecret = new Uint8Array(32).fill(7);
  homes = await serveAccountHomes({ homes: [
    { key: 'encrypted', serverUrl: 'https://context-encrypted.test', accountId: 'encrypted-account',
      get accountMode() { return encryptedAccountMode; }, credentials: encryptedCredentials,
      encryptionCurrentness: () => encryptedAccountMode === 'plain' ? createPlainAccountEncryptionCurrentnessFixture()
        : createLegacyAccountEncryptionCurrentnessFixture({ secret: encryptedAccountSecret }) },
    { key: 'plain', serverUrl: 'https://context-plain.test', accountId: 'plain-account' },
    { key: 'focused', serverUrl: 'https://context-focused.test', accountId: 'focused-account',
      serverIdentityId: 'srv_context_focused' },
  ], route: () => undefined });
});

afterEach(async () => {
  for (const context of acquired.splice(0)) if (context.scope === 'scoped') await context.release?.();
  await homes?.dispose();
});

async function resolve(params: Parameters<typeof resolveServerAccountRequestContext>[0]) {
  const context = await resolveServerAccountRequestContext(params);
  acquired.push(context);
  return context;
}

describe('resolveServerAccountRequestContext', () => {
  it('admits genuine E2EE material before the live Home observation is connected', async () => {
    await homes.dispose();
    homes = await serveAccountHomes({ homes: [{ key: 'encrypted', serverUrl: 'https://context-encrypted.test',
      accountId: 'encrypted-account', accountMode: 'e2ee', credentials: encryptedCredentials,
      encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(7) }),
    }], route: () => undefined });
    const home = homes.homes.encrypted!;
    const { sync } = await import('@/sync/sync');
    const binding = sync.getAccountEncryptionObservationBinding(encryptedCredentials, home.id);
    // The real socket owner exposes no borrowable binding before connection;
    // the scoped material reader must still admit this Home over authenticated HTTP.
    expect(binding === null).toBe(true);
    invalidateAccountEncryptionModeCache({ serverId: home.id, reason: 'scope-reset' });
    const encryption = await resolveScopedAccountEncryption({ serverId: home.id, serverUrl: home.serverUrl, credentials: encryptedCredentials });
    expect(encryption !== null).toBe(true);
  });

  it('admits genuine E2EE material through the authenticated production Account-currentness read', async () => {
    const home = homes.homes.encrypted!;
    const encryption = await resolveScopedAccountEncryption({ serverId: home.id, serverUrl: home.serverUrl, credentials: encryptedCredentials });
    expect(encryption !== null).toBe(true);
    const reads = homes.httpRequests.filter(request => request.home === 'encrypted' && request.path === '/v1/account/encryption/currentness');
    expect(reads.length).toBe(1);
    expect(reads[0]?.accountId === 'encrypted-account').toBe(true);
    expect(reads[0]?.headers.has('authorization')).toBe(true);
  });

  it('keeps a working E2EE owner through transport withdrawal and a failed observed mode read', async () => {
    const home = homes.homes.encrypted!;
    const input = { serverId: home.id, serverUrl: home.serverUrl, credentials: encryptedCredentials };
    const encryption = await resolveScopedAccountEncryption(input);
    if (!encryption) throw new Error('Expected genuine E2EE material');
    const key = new Uint8Array(32).fill(87);
    const envelope = encodeBase64(await encryption.encryptEncryptionKey(key));
    expect((await encryption.decryptEncryptionKey(envelope))?.every((byte, index) => byte === key[index])).toBe(true);
    setRuntimeFetch(async (url, init) => new URL(String(url)).pathname === '/v1/account/encryption/currentness'
      ? Response.json({ error: 'unavailable' }, { status: 503 }) : homes.fetch(url, init));
    const request = createServerFetchAtEndpoint({ endpointUrl: home.serverUrl, serverId: home.id, credentials: encryptedCredentials });
    const observation = createSocketAccountEncryptionObservation({ credentials: encryptedCredentials, serverId: home.id,
      endpointUrl: home.serverUrl, runtimeOrigin: home.serverUrl, homeCarrierEndpointId: null, request, isCurrent: () => true });
    try {
      observation.connected();
      const observedRequest = createServerFetchAtEndpoint({ endpointUrl: home.serverUrl, serverId: home.id,
        credentials: encryptedCredentials, accountEncryptionObservation: observation.binding });
      await expect(fetchAccountEncryptionMode(encryptedCredentials, { request: observedRequest, usage: 'identity' }))
        .rejects.toMatchObject({ code: 'account-encryption-currentness-unavailable' });
      expect((await encryption.decryptEncryptionKey(envelope))?.every((byte, index) => byte === key[index])).toBe(true);
      expect(await resolveScopedAccountEncryption(input) === encryption).toBe(true);
    } finally { observation.dispose('scope-reset'); }
  });

  it('rejects an unavailable initial E2EE currentness read with a typed result and no retry loop', async () => {
    const home = homes.homes.encrypted!;
    const origin = new URL(home.serverUrl).origin;
    let reads = 0;
    setRuntimeFetch(async (url, init) => {
      const target = new URL(String(url));
      if (target.origin !== origin || target.pathname !== '/v1/account/encryption/currentness') return homes.fetch(url, init);
      reads += 1;
      return Response.json({ error: 'unavailable' }, { status: 503 });
    });
    await expect(resolveScopedAccountEncryption({ serverId: home.id, serverUrl: home.serverUrl, credentials: encryptedCredentials }))
      .rejects.toMatchObject({ code: 'account-encryption-currentness-unavailable', canTryAgain: true });
    expect(reads).toBe(1);
  });

  it('keeps current material and its openings when one invalidated currentness resolve fails with HTTP 503', async () => {
    const home = homes.homes.encrypted!;
    const input = { serverId: home.id, serverUrl: home.serverUrl, credentials: encryptedCredentials };
    const encryption = await resolveScopedAccountEncryption(input);
    if (!encryption) throw new Error('Expected genuine E2EE material');
    const worker = createFakeCryptoWorker();
    let openings = 0;
    encryption.configureNativeCryptoWorker({ worker: { ...worker, decryptDataKeyEnvelopeV1: async request => {
      openings += request.items.length;
      return worker.decryptDataKeyEnvelopeV1(request);
    } }, routing: { mode: 'require', minPayloadBytes: 0 } });
    const key = new Uint8Array(32).fill(89);
    const envelope = encodeBase64(await encryption.encryptEncryptionKey(key));
    const opens = async () => (await encryption.decryptEncryptionKey(envelope))?.every((byte, index) => byte === key[index]) === true;
    const captured = encryption.getCurrentEncryptionGenerationScope();
    expect(await opens()).toBe(true);
    invalidateAccountEncryptionModeCache({ serverId: home.id });
    const origin = new URL(home.serverUrl).origin;
    let failedReads = 0;
    setRuntimeFetch(async (url, init) => {
      const target = new URL(String(url));
      if (target.origin !== origin || target.pathname !== '/v1/account/encryption/currentness') return homes.fetch(url, init);
      failedReads += 1;
      return Response.json({ error: 'unavailable' }, { status: 503 });
    });
    await expect(resolveScopedAccountEncryption(input))
      .rejects.toMatchObject({ code: 'account-encryption-currentness-unavailable', canTryAgain: true });
    expect(failedReads).toBe(1);
    expect(encryption.isCurrentEncryptionGenerationScope(captured)).toBe(true);
    expect(await opens()).toBe(true);
    setRuntimeFetch(homes.fetch);
    expect(await resolveScopedAccountEncryption(input) === encryption).toBe(true);
    expect(openings).toBe(1);
  });

  it('refuses a plain report for active keys, then retires material across a confirmed conversion and reopens only in E2EE', async () => {
    const home = homes.homes.encrypted!;
    const original = await resolve({ serverId: home.id, preferScoped: true });
    if (original.scope !== 'scoped' || !original.encryption) throw new Error('Expected scoped material');
    const worker = createFakeCryptoWorker();
    let openings = 0;
    const countedWorker = { ...worker, decryptDataKeyEnvelopeV1: async (request: Parameters<typeof worker.decryptDataKeyEnvelopeV1>[0]) => {
      openings += request.items.length;
      return worker.decryptDataKeyEnvelopeV1(request);
    } };
    original.encryption.configureNativeCryptoWorker({ worker: countedWorker, routing: { mode: 'require', minPayloadBytes: 0 } });
    const key = new Uint8Array(32).fill(86);
    const envelope = encodeBase64(await original.encryption.encryptEncryptionKey(key));
    expect((await original.encryption.decryptEncryptionKey(envelope))?.every((byte, index) => byte === key[index])).toBe(true);
    // The same admitted Account feed invalidation Sync uses after a conversion.
    encryptedAccountMode = 'plain';
    invalidateAccountEncryptionModeCacheForChanges([
      { kind: 'account', entityId: 'self', hint: { encryptionMode: 'plain' } },
    ], { serverId: home.id });
    // Active keys never accept the Home's word for plain (downgrade pin).
    await expect(resolve({ serverId: home.id, preferScoped: true }))
      .rejects.toMatchObject({ code: ACCOUNT_MODE_DOWNGRADE_UNVERIFIED });
    // A confirmed conversion keeps the same key bytes as historical custody.
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id },
      withAccountE2eeCustody(encryptedCredentials, 'historical'));
    const plain = await resolve({ serverId: home.id, preferScoped: true });
    await expect(original.encryption.decryptEncryptionKey(envelope)).rejects.toBeInstanceOf(DataKeyOpeningCancelledError);
    expect(plain.scope === 'scoped' && plain.encryption === null).toBe(true);
    expect(openings).toBe(1);
    encryptedAccountMode = 'e2ee';
    invalidateAccountEncryptionModeCacheForChanges([
      { kind: 'account', entityId: 'self', hint: { encryptionMode: 'e2ee' } },
    ], { serverId: home.id });
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, encryptedCredentials);
    const next = await resolve({ serverId: home.id, preferScoped: true });
    if (next.scope !== 'scoped' || !next.encryption) throw new Error('Expected fresh E2EE material');
    expect(next.encryption === original.encryption).toBe(false);
    next.encryption.configureNativeCryptoWorker({ worker: countedWorker, routing: { mode: 'require', minPayloadBytes: 0 } });
    expect((await next.encryption.decryptEncryptionKey(envelope))?.every((byte, index) => byte === key[index])).toBe(true);
    expect(openings).toBe(2);
  });
  it('opens the same envelope afresh after keyless credential adoption and return to E2EE material', async () => {
    const home = homes.homes.encrypted!;
    const first = await resolve({ serverId: home.id, preferScoped: true });
    if (first.scope !== 'scoped' || !first.encryption) throw new Error('Expected scoped material');
    const worker = createFakeCryptoWorker();
    let openings = 0;
    const countedWorker = { ...worker, decryptDataKeyEnvelopeV1: async (request: Parameters<typeof worker.decryptDataKeyEnvelopeV1>[0]) => {
      openings += request.items.length;
      return worker.decryptDataKeyEnvelopeV1(request);
    } };
    first.encryption.configureNativeCryptoWorker({ worker: countedWorker, routing: { mode: 'require', minPayloadBytes: 0 } });
    const key = new Uint8Array(32).fill(85);
    const envelope = encodeBase64(await first.encryption.encryptEncryptionKey(key));
    expect((await first.encryption.decryptEncryptionKey(envelope))?.every((byte, index) => byte === key[index])).toBe(true);
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: encryptedCredentials.token });
    const plain = await resolve({ serverId: home.id, preferScoped: true });
    expect(plain.scope === 'scoped' && plain.encryption).toBeNull();
    await expect(first.encryption.decryptEncryptionKey(envelope)).rejects.toBeInstanceOf(DataKeyOpeningCancelledError);
    expect(openings).toBe(1);
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, encryptedCredentials);
    const next = await resolve({ serverId: home.id, preferScoped: true });
    if (next.scope !== 'scoped' || !next.encryption) throw new Error('Expected newly adopted material');
    next.encryption.configureNativeCryptoWorker({ worker: countedWorker, routing: { mode: 'require', minPayloadBytes: 0 } });
    expect((await next.encryption.decryptEncryptionKey(envelope))?.every((byte, index) => byte === key[index])).toBe(true);
    expect(openings).toBe(2);
  });
  it('reuses opened material across both scoped readers with recaptured equal credentials', async () => {
    const home = homes.homes.encrypted!;
    const context = await resolve({ serverId: home.id, preferScoped: true });
    if (context.scope !== 'scoped' || !context.encryption) throw new Error('Expected scoped material');
    const worker = createFakeCryptoWorker();
    let openings = 0;
    context.encryption.configureNativeCryptoWorker({ worker: { ...worker,
      decryptDataKeyEnvelopeV1: async request => {
        openings += request.items.length;
        return worker.decryptDataKeyEnvelopeV1(request);
      },
    }, routing: { mode: 'auto', minPayloadBytes: 0 } });
    const key = new Uint8Array(32).fill(47);
    const envelope = encodeBase64(await context.encryption.encryptEncryptionKey(key));
    expect(await context.encryption.decryptEncryptionKey(envelope)).toEqual(key);
    for (let index = 0; index < 8; index += 1) {
      const next = index % 2 === 0
        ? await resolve({ serverId: home.id, preferScoped: true })
        : await resolveServerScopedContext({ serverId: home.id, machineId: 'warm-machine', forceScoped: true });
      try {
        if (next.scope !== 'scoped' || !next.encryption) throw new Error('Expected recaptured scoped material');
        expect(next.credentials).not.toBe(context.credentials);
        // Worker/SDK is the real boundary. Each fresh factory owner would otherwise
        // take the unobserved reference path, so count every actual opening here.
        if (!(next.encryption instanceof Encryption)) throw new Error('Expected canonical Account encryption owner');
        next.encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
              openings += request.items.length;
              return worker.decryptDataKeyEnvelopeV1(request);
            },
          }, routing: { mode: 'auto', minPayloadBytes: 0 } });
        expect(await next.encryption.decryptEncryptionKey(envelope)).toEqual(key);
      } finally { if (next.scope === 'scoped') await next.release?.(); }
    }
    expect(openings).toBe(1);
  });

  it.each(['replacement', 'original mutation', 'original-only mutation', 'sign out', 'plain replacement'] as const)(
    'retires captured scoped material after %s without trusting an equal old recapture', async change => {
      const home = homes.homes.encrypted!;
      const original = await resolve({ serverId: home.id, preferScoped: true });
      if (original.scope !== 'scoped' || !original.encryption || !original.credentials || !('secret' in original.credentials)) {
        throw new Error('Expected exact legacy material');
      }
      const key = new Uint8Array(32).fill(49);
      const envelope = encodeBase64(await original.encryption.encryptEncryptionKey(key));
      expect(await original.encryption.decryptEncryptionKey(envelope)).toEqual(key);
      const captured = original.encryption.getCurrentEncryptionGenerationScope();
      if (change === 'replacement') {
        encryptedAccountSecret = new Uint8Array(32).fill(51);
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
          token: encryptedCredentials.token, secret: Buffer.from(new Uint8Array(32).fill(51)).toString('base64url'),
        });
      } else if (change === 'plain replacement') {
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
          token: encryptedCredentials.token,
        });
      } else if (change === 'sign out') {
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
      } else {
        // Storage still returns the old bytes. Mutation of the original custody
        // object must nevertheless prevent reviving the retired owner's proof.
        Object.assign(original.credentials, { secret: Buffer.from(new Uint8Array(32).fill(52)).toString('base64url') });
      }
      if (change === 'plain replacement') {
        const next = await resolve({ serverId: home.id, preferScoped: true });
        expect(next.scope === 'scoped' && next.encryption).toBeNull();
      } else if (change !== 'sign out' && change !== 'original-only mutation') {
        const next = await resolve({ serverId: home.id, preferScoped: true });
        if (next.scope !== 'scoped' || !next.encryption) throw new Error('Expected replacement owner');
        expect(await next.encryption.decryptEncryptionKey(envelope)).toEqual(change === 'replacement' ? null : key);
      }
      expect(original.encryption.isCurrentEncryptionGenerationScope(captured)).toBe(false);
      await expect(original.encryption.decryptEncryptionKey(envelope)).rejects.toBeInstanceOf(DataKeyOpeningCancelledError);
    },
  );

  it('returns the applied active scope when the target is omitted or uses its saved-profile alias', async () => {
    await expect(resolve({})).resolves.toEqual({ scope: 'active', timeoutMs: 30_000 });
    await expect(resolve({ serverId: homes.homes.focused!.profileId })).resolves.toEqual({ scope: 'active', timeoutMs: 30_000 });
  });

  it('retains exact applied and staged Home credentials while the direct runtime is unavailable', async () => {
    const applied = getActiveServerSnapshot();
    publishAppliedActiveServerRuntimeAvailability(false);
    await setActiveServer({ serverId: homes.homes.plain!.id });
    publishAppliedActiveServerSnapshot(applied, false);
    const contexts = await Promise.all([resolve({ serverId: homes.homes.focused!.id }), resolve({ serverId: homes.homes.plain!.id })]);
    expect(contexts.map(context => context.scope === 'scoped' && [context.targetServerId, context.targetAccountId]))
      .toEqual([[homes.homes.focused!.id, 'focused-account'], [homes.homes.plain!.id, 'plain-account']]);
  });

  it('resolves usable encryption from the exact stored credential of another Home', async () => {
    const context = await resolve({ serverId: homes.homes.encrypted!.id, timeoutMs: 5_000 });
    expect(context).toMatchObject({ scope: 'scoped', targetServerId: homes.homes.encrypted!.id,
      targetServerUrl: homes.homes.encrypted!.serverUrl, targetAccountId: 'encrypted-account',
      credentials: encryptedCredentials, timeoutMs: 5_000 });
    if (context.scope !== 'scoped' || !context.encryption) throw new Error('Missing captured Account cipher');
    const value = { private: 'exact Home', bytes: [0, 255] };
    expect(await context.encryption.decryptRaw(await context.encryption.encryptRaw(value))).toEqual(value);
    expect(context.readTransport).toBeDefined();
  });

  it('keeps token-only Plain Accounts keyless without borrowing the focused credential', async () => {
    const context = await resolve({ serverId: homes.homes.plain!.id, timeoutMs: 5_000 });
    expect(context).toMatchObject({ scope: 'scoped', targetServerId: homes.homes.plain!.id,
      targetAccountId: 'plain-account', encryption: null, timeoutMs: 5_000 });
    if (context.scope !== 'scoped') throw new Error('Expected captured Home');
    expect(context.credentials).toEqual({ token: context.token });
    expect(context.runtimeOrigin).toBe(homes.homes.plain!.serverUrl);
  });

  it('refuses a signed-out exact Home instead of substituting focused credentials', async () => {
    expect(await TokenStorage.removeCredentialsForServerUrl(homes.homes.plain!.serverUrl,
      { serverId: homes.homes.plain!.id })).toBe(true);
    await expect(resolve({ serverId: homes.homes.plain!.id })).rejects.toThrow('No authentication credentials');
    expect(await TokenStorage.getCredentialsForServerUrl(homes.homes.focused!.serverUrl,
      { serverId: homes.homes.focused!.id })).not.toBeNull();
  });

  it('can capture the active Home explicitly for a finite caller', async () => {
    const context = await resolve({ preferScoped: true, timeoutMs: 7_000 });
    expect(context).toMatchObject({ scope: 'scoped', timeoutMs: 7_000,
      targetServerId: homes.homes.focused!.id, targetAccountId: 'focused-account' });
  });
});
