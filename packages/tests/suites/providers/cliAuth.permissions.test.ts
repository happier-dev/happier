import { mkdtemp, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

describe('providers: cli auth seeding', () => {
  it.skipIf(process.platform === 'win32')('writes access.key with restrictive permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-cli-auth-'));
    const cliHome = join(root, 'cli-home');
    await mkdir(cliHome, { recursive: true });

    await seedCliAuthForServer({
      cliHome,
      serverUrl: 'http://127.0.0.1:12345',
      token: 'test-token',
      secret: new Uint8Array(32).fill(1),
    });

    const access = await stat(join(cliHome, 'access.key'));
    expect(access.isFile()).toBe(true);
    expect(access.mode & 0o777).toBe(0o600);

    const serverIdDir = await stat(join(cliHome, 'servers'));
    expect(serverIdDir.isDirectory()).toBe(true);
    expect(serverIdDir.mode & 0o777).toBe(0o700);
  });
});

