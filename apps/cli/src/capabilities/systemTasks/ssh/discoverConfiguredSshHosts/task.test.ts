import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDiscoverConfiguredSshHostsSystemTaskKind } from './task';

function createHomeFixture(): string {
  const homeDir = join(tmpdir(), `happier-ssh-discovery-task-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(homeDir, '.ssh'), { recursive: true });
  return homeDir;
}

describe('createDiscoverConfiguredSshHostsSystemTaskKind', () => {
  it('returns discovered SSH host suggestions through the CLI-owned system task bridge', async () => {
    const homeDir = createHomeFixture();
    writeFileSync(join(homeDir, '.ssh', 'config'), `
Host task-host
  HostName task.example.test
  User task-user
  Port 2222
`);

    const kind = createDiscoverConfiguredSshHostsSystemTaskKind({ homeDir });
    const hosts = await kind.run({
      params: {},
      emit: () => {},
      prompt: async () => null,
    });

    expect(hosts).toEqual([
      expect.objectContaining({
        alias: 'task-host',
        hostname: 'task.example.test',
        username: 'task-user',
        port: 2222,
        source: 'ssh-config',
      }),
    ]);
  });
});
