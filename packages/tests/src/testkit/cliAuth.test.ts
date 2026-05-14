import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createServerUrlComparableKey } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { readCliAccessKey } from './cliAccessKey';
import { seedCliAuthForServer, seedCliDataKeyAuthForServer } from './cliAuth';

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

    const settings = JSON.parse(await readFile(join(cliHome, 'settings.json'), 'utf8')) as {
      machineReplacementCandidatesByServerIdByAccountId?: Record<string, Record<string, unknown>>;
    };
    expect(settings.machineReplacementCandidatesByServerIdByAccountId?.[seeded.serverId]?.[accountId]).toMatchObject({
      machineId: oldMachineId,
      replacementReason: 'reauth',
    });
  });
});
