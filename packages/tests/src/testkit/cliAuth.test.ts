import { readStoredMachineRegistration, resolveMachineRegistrationPath } from '@happier-dev/cli-common/firstPartyRuntime/cliMachineRegistration';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';

import type { TestAuth } from './auth';
import { readCliAccessKey } from './cliAccessKey';
import { withEnvOverrides } from './env';
import {
  buildTestAccountCliAuthCredentials,
  seedCliAuthForServer,
  seedCliAuthForTestAccount,
  seedCliDataKeyAuthForServer,
  type TestAccountCliAuthMode,
} from './cliAuth';

function deriveExpectedServerId(url: string): string {
  const value = createServerUrlComparableKey(url) || url;
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

describe('seedCliAuthForServer', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => await rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('uses the same env-derived server id shape as the CLI configuration resolver', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-tests-cli-auth-'));
    tempDirs.push(cliHome);

    const serverUrl = 'http://127.0.0.1:34567';
    const expectedServerId = deriveExpectedServerId(serverUrl);

    const seeded = await seedCliAuthForServer({
      cliHome,
      serverUrl,
      token: 'token-1',
      secret: Uint8Array.from(randomBytes(32)),
    });

    expect(seeded.serverId).toBe(expectedServerId);
  });
});

describe('seedCliDataKeyAuthForServer', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => await rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('preserves the provided account content public key when reseeding credentials', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-tests-cli-datakey-auth-'));
    tempDirs.push(cliHome);
    const machineKey = Uint8Array.from(randomBytes(32));
    const publicKey = Uint8Array.from(randomBytes(32));

    const seeded = await seedCliDataKeyAuthForServer({
      cliHome,
      serverUrl: 'http://127.0.0.1:34567',
      token: 'token-1',
      machineKey,
      publicKey,
    });

    const accessKey = await readCliAccessKey(cliHome);
    expect(seeded.publicKey).toEqual(publicKey);
    expect(accessKey).toEqual({
      token: 'token-1',
      encryption: {
        publicKey: Buffer.from(publicKey).toString('base64'),
        machineKey: Buffer.from(machineKey).toString('base64'),
      },
    });
  });

  it('records an explicit replacement candidate for the token account when requested', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-tests-cli-datakey-auth-'));
    tempDirs.push(cliHome);
    const machineKey = Uint8Array.from(randomBytes(32));
    const accountId = 'account-for-replacement';
    const token = [
      'header',
      Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url'),
      'signature',
    ].join('.');
    const serverUrl = 'http://127.0.0.1:34567';
    const oldMachineId = 'machine-old';

    const seeded = await seedCliDataKeyAuthForServer({
      cliHome,
      serverUrl,
      token,
      machineKey,
      replacementCandidate: {
        machineId: oldMachineId,
        replacementReason: 'reauth',
      },
    });
    expect(seeded.publicKey).toEqual(Uint8Array.from(
      tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
    ));

    const registration = await readStoredMachineRegistration(
      resolveMachineRegistrationPath(join(cliHome, 'servers'), seeded.serverId),
    );
    expect(registration?.replacementCandidates?.[accountId]).toMatchObject({
      machineId: oldMachineId,
      replacementReason: 'reauth',
    });
  });
});

describe('seedCliAuthForTestAccount', () => {
  const tempDirs: string[] = [];
  const accountSigningSeed = new Uint8Array(32).fill(0x31);
  const auth: TestAuth = {
    token: 'token-account-coherent',
    publicKeyBase64: 'unused-by-cli-auth-seeding',
    accountSigningSeed,
    accountMachineKey: deriveAccountMachineKeyFromRecoverySecret(accountSigningSeed),
  };

  const serverUrl = 'https://home.example.test';
  const iroh = { kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] } as const;
  const publicDescriptor = {
    v: 1,
    homeServerIdentityId: 'srv_fixture_home',
    canonicalServerUrl: serverUrl,
    revision: 28,
    endpoints: [{ ...iroh, relayUrls: [...iroh.relayUrls] }],
  } satisfies HomeConnectionDescriptorV1;
  const authenticated = {
    ...publicDescriptor,
    endpoints: [{ ...publicDescriptor.endpoints[0], directAddresses: ['192.0.2.1:4242'] }],
  } satisfies HomeConnectionDescriptorV1;

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => await rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function seedAndRead(mode: TestAccountCliAuthMode): Promise<Record<string, unknown>> {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-tests-cli-account-auth-'));
    tempDirs.push(cliHome);
    await seedCliAuthForTestAccount({
      cliHome,
      serverUrl: 'http://127.0.0.1:34567',
      auth,
      mode,
    });
    return JSON.parse(await readFile(join(cliHome, 'access.key'), 'utf8')) as Record<string, unknown>;
  }

  it('writes the exact legacy credential shape with the Account signing seed', async () => {
    await expect(seedAndRead('legacy')).resolves.toEqual({
      token: auth.token,
      secret: Buffer.from(auth.accountSigningSeed).toString('base64'),
    });
  });

  it('writes the exact data-key credential shape with the Account content-binding key', async () => {
    const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(
      auth.accountMachineKey,
    ).publicKey;
    await expect(seedAndRead('dataKey')).resolves.toEqual({
      token: auth.token,
      encryption: {
        publicKey: Buffer.from(contentPublicKey).toString('base64'),
        machineKey: Buffer.from(auth.accountMachineKey).toString('base64'),
      },
    });
  });

  it('lets authenticated refresh adopt the same revision after a legacy public Home bootstrap', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-tests-cli-account-auth-'));
    tempDirs.push(cliHome);
    // Old JavaScript fixtures supplied the public projection under this key.
    const legacyOptions = { cliHome, serverUrl, auth, mode: 'tokenOnly' as const, homeConnectionDescriptor: publicDescriptor };
    const enrolled = await seedCliAuthForTestAccount(legacyOptions);
    await withEnvOverrides({ HAPPIER_HOME_DIR: cliHome, HAPPIER_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined }, async () => {
      vi.resetModules();
      const { adoptServerProfileHomeConnectionDescriptor } = await import('../../../../apps/cli/src/server/serverProfiles');
      await expect(adoptServerProfileHomeConnectionDescriptor({ descriptor: authenticated,
        expectedProfileId: enrolled.serverId, observation: 'exact' })).resolves.toMatchObject({
        outcome: 'updated',
        profile: { homeConnectionDescriptor: authenticated, homeConnectionDescriptorAuthority: 'exact' },
      });
    });
  });

  it.each(['authenticated', 'public fallback'] as const)('seeds a bound Home only from the authenticated projection (%s)', async projection => {
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-tests-cli-account-auth-'));
    tempDirs.push(cliHome);
    const fetchHome = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === `${serverUrl}/v1/features/authenticated` &&
        new Headers(init?.headers).get('authorization') === `Bearer ${auth.token}`) {
        if (projection === 'public fallback') return new Response(null, { status: 404 });
        return Response.json({ features: {}, capabilities: {}, homeConnectionDescriptor: authenticated });
      }
      return Response.json({ features: {}, capabilities: {}, homeConnectionDescriptor: publicDescriptor });
    });
    vi.stubGlobal('fetch', fetchHome);
    try {
      const enrolled = seedCliAuthForTestAccount({ cliHome, serverUrl, auth, mode: 'tokenOnly',
        expectedHomeServerIdentityId: authenticated.homeServerIdentityId });
      if (projection === 'public fallback') {
        await expect(enrolled).rejects.toThrow('did not resolve its authenticated Home descriptor');
        await expect(readFile(join(cliHome, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        return;
      }
      const { serverId } = await enrolled;
      const settings = JSON.parse(await readFile(join(cliHome, 'settings.json'), 'utf8'));
      expect(settings.servers[serverId]).toMatchObject({
        homeConnectionDescriptor: authenticated, homeConnectionDescriptorAuthority: 'exact',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('writes a genuinely keyless token-only credential shape', async () => {
    await expect(seedAndRead('tokenOnly')).resolves.toEqual({
      token: auth.token,
    });
  });
});

describe('buildTestAccountCliAuthCredentials', () => {
  const accountSigningSeed = new Uint8Array(32).fill(0x41);
  const auth: TestAuth = {
    token: 'token-owned-by-test-auth',
    publicKeyBase64: 'unused-by-credential-builder',
    accountSigningSeed,
    accountMachineKey: deriveAccountMachineKeyFromRecoverySecret(accountSigningSeed),
  };

  it('builds every supported persisted credential shape from one TestAuth account', () => {
    const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(
      auth.accountMachineKey,
    ).publicKey;
    expect(buildTestAccountCliAuthCredentials({ auth, mode: 'legacy' })).toEqual({
      token: auth.token,
      secret: Buffer.from(auth.accountSigningSeed).toString('base64'),
    });
    expect(buildTestAccountCliAuthCredentials({ auth, mode: 'dataKey' })).toEqual({
      token: auth.token,
      encryption: {
        publicKey: Buffer.from(contentPublicKey).toString('base64'),
        machineKey: Buffer.from(auth.accountMachineKey).toString('base64'),
      },
    });
    expect(buildTestAccountCliAuthCredentials({ auth, mode: 'tokenOnly' })).toEqual({
      token: auth.token,
    });
  });
});
