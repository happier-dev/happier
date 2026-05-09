import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createServerUrlComparableKey } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { seedCliAuthForServer } from './cliAuth';

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
