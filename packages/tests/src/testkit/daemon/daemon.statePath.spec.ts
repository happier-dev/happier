import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readDaemonState } from './daemon';

describe('readDaemonState', () => {
  it('reads daemon.state.json from the active server dir (settings.json schema v5)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-daemon-state-'));
    const serverId = 'env_deadbeef';
    const serverDir = join(dir, 'servers', serverId);
    await mkdir(serverDir, { recursive: true });
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: serverId,
          servers: { [serverId]: { id: serverId, serverUrl: 'http://127.0.0.1:1', webappUrl: 'http://127.0.0.1:1' } },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    await writeFile(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify({ pid: 123, httpPort: 456 }, null, 2) + '\n',
      'utf8',
    );

    await expect(readDaemonState(dir)).resolves.toEqual(
      expect.objectContaining({
        pid: 123,
        httpPort: 456,
      }),
    );
  });

  it('keeps legacy support for daemon.state.json in the home dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-daemon-state-legacy-'));
    await writeFile(
      join(dir, 'daemon.state.json'),
      JSON.stringify({ pid: 321, httpPort: 654 }, null, 2) + '\n',
      'utf8',
    );

    await expect(readDaemonState(dir)).resolves.toEqual(
      expect.objectContaining({
        pid: 321,
        httpPort: 654,
      }),
    );
  });

  it('falls back to scanning servers/*/daemon.state.json when settings.json points elsewhere', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-daemon-state-fallback-'));

    // Persisted selection points to "cloud" but the daemon wrote its state under env_deadbeef.
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: 'cloud',
          servers: {
            cloud: { id: 'cloud', serverUrl: 'https://api.happier.dev', webappUrl: 'https://app.happier.dev' },
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const serverId = 'env_deadbeef';
    const serverDir = join(dir, 'servers', serverId);
    await mkdir(serverDir, { recursive: true });
    await writeFile(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify({ pid: 111, httpPort: 222 }, null, 2) + '\n',
      'utf8',
    );

    await expect(readDaemonState(dir)).resolves.toEqual(
      expect.objectContaining({
        pid: 111,
        httpPort: 222,
      }),
    );
  });
});
