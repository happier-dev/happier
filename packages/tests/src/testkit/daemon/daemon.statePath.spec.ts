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
});

