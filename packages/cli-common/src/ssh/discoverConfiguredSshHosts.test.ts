import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { ConfiguredSshHostsV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';

import { discoverConfiguredSshHosts } from './discoverConfiguredSshHosts.js';
import { createSystemTasksRunner } from '../systemTasks/interactiveTaskKinds.js';
import { createDiscoverConfiguredSshHostsSystemTaskKind, DISCOVER_CONFIGURED_SSH_HOSTS_SYSTEM_TASK_KIND } from '../systemTasks/ssh/discoverConfiguredSshHosts.js';

function createHomeFixture(): string {
  const homeDir = join(tmpdir(), `happier-ssh-discovery-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(homeDir, '.ssh'), { recursive: true });
  return homeDir;
}

function writeHomeFile(homeDir: string, relativePath: string, text: string): string {
  const path = join(homeDir, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe('discoverConfiguredSshHosts', () => {
  it('returns a known-empty inventory when optional SSH files and include directories are absent', async () => {
    const homeDir = createHomeFixture();
    expect(await discoverConfiguredSshHosts({ homeDir })).toEqual([]);

    writeHomeFile(homeDir, '.ssh/config', 'Include missing.conf missing.d/*.conf\n');
    expect(await discoverConfiguredSshHosts({ homeDir })).toEqual([]);
  });

  it.each(['config', 'known_hosts', 'included.conf', 'conf.d'] as const)(
    'preserves a permission failure while reading %s instead of claiming an empty inventory',
    async (source) => {
      const homeDir = createHomeFixture();
      if (source === 'included.conf') writeHomeFile(homeDir, '.ssh/config', 'Include included.conf\n');
      if (source === 'conf.d') writeHomeFile(homeDir, '.ssh/config', 'Include conf.d/*.conf\n');
      const inaccessiblePath = join(homeDir, '.ssh', source);
      const permissionError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });

      // The filesystem adapter is the OS boundary; parsing and Include traversal stay real.
      await expect(discoverConfiguredSshHosts({ homeDir, fs: {
        readFile: async (path, encoding) => {
          if (path === inaccessiblePath) throw permissionError;
          return await readFile(path, encoding);
        },
        readdir: async (path, options) => {
          if (path === inaccessiblePath) throw permissionError;
          return await readdir(path, options);
        },
      } })).rejects.toBe(permissionError);
    },
  );

  it('publishes a task failure when an existing SSH config cannot be read as a file', async () => {
    const homeDir = createHomeFixture();
    mkdirSync(join(homeDir, '.ssh/config'));
    const runner = createSystemTasksRunner({ kinds: {
      [DISCOVER_CONFIGURED_SSH_HOSTS_SYSTEM_TASK_KIND]: createDiscoverConfiguredSshHostsSystemTaskKind({ homeDir }),
    } });
    await runner.start({ taskId: 'ssh-discovery', kind: DISCOVER_CONFIGURED_SSH_HOSTS_SYSTEM_TASK_KIND, params: {} });

    expect(await runner.wait({ taskId: 'ssh-discovery' })).toMatchObject({
      ok: false,
      error: { code: 'system_task_failed' },
    });
  });

  it('discovers concrete SSH config hosts with hostname, username, and port', async () => {
    const homeDir = createHomeFixture();
    const configPath = writeHomeFile(homeDir, '.ssh/config', `
Host prod
  HostName prod.example.test
  User deploy
  Port 2201

Host dev
  HostName=dev.example.test
  User=lee
  Port=2202

Host *
  User ignored

Host !blocked
  HostName blocked.example.test

Host web-*,db?
  HostName pattern.example.test
`);

    const hosts = await discoverConfiguredSshHosts({ homeDir });
    expect(ConfiguredSshHostsV1Schema.parse(hosts)).toEqual(hosts);

    expect(hosts.map(({ alias, hostname, username, port, source, sourcePath }) => ({
      alias,
      hostname,
      username,
      port,
      source,
      sourcePath,
    }))).toEqual([
      {
        alias: 'dev',
        hostname: 'dev.example.test',
        username: 'lee',
        port: 2202,
        source: 'ssh-config',
        sourcePath: configPath,
      },
      {
        alias: 'prod',
        hostname: 'prod.example.test',
        username: 'deploy',
        port: 2201,
        source: 'ssh-config',
        sourcePath: configPath,
      },
    ]);
  });

  it('expands include globs relative to the containing config and avoids include cycles', async () => {
    const homeDir = createHomeFixture();
    const configPath = writeHomeFile(homeDir, '.ssh/config', `
Include conf.d/*.conf
Host root-host
  HostName root.example.test
`);
    const includePath = writeHomeFile(homeDir, '.ssh/conf.d/work.conf', `
Include ../conf.d/work.conf
Host included
  HostName included.example.test
  User included-user
`);
    writeHomeFile(homeDir, '.ssh/conf.d/ignored.txt', `
Host ignored
  HostName ignored.example.test
`);

    const hosts = await discoverConfiguredSshHosts({ homeDir, maxIncludeDepth: 3 });

    expect(hosts.map(({ alias, hostname, username, sourcePath }) => ({
      alias,
      hostname,
      username,
      sourcePath,
    }))).toEqual([
      {
        alias: 'included',
        hostname: 'included.example.test',
        username: 'included-user',
        sourcePath: includePath,
      },
      {
        alias: 'root-host',
        hostname: 'root.example.test',
        username: null,
        sourcePath: configPath,
      },
    ]);
  });

  it('discovers displayable known_hosts names while skipping marker, hashed, wildcard, and negated entries', async () => {
    const homeDir = createHomeFixture();
    const knownHostsPath = writeHomeFile(homeDir, '.ssh/known_hosts', `
# comment
@cert-authority *.example.test ssh-ed25519 AAAA
|1|salt|hash ssh-ed25519 AAAA
*.wild.example.test ssh-ed25519 AAAA
!blocked.example.test ssh-ed25519 AAAA
[bracket.example.test]:2203,plain.example.test,colon.example.test:2204 ssh-ed25519 AAAA
2001:db8::1 ssh-ed25519 AAAA
`);

    const hosts = await discoverConfiguredSshHosts({ homeDir });

    expect(hosts.map(({ alias, hostname, port, source, sourcePath }) => ({
      alias,
      hostname,
      port,
      source,
      sourcePath,
    }))).toEqual([
      {
        alias: '2001:db8::1',
        hostname: '2001:db8::1',
        port: null,
        source: 'known-hosts',
        sourcePath: knownHostsPath,
      },
      {
        alias: 'bracket.example.test',
        hostname: 'bracket.example.test',
        port: 2203,
        source: 'known-hosts',
        sourcePath: knownHostsPath,
      },
      {
        alias: 'colon.example.test',
        hostname: 'colon.example.test',
        port: 2204,
        source: 'known-hosts',
        sourcePath: knownHostsPath,
      },
      {
        alias: 'plain.example.test',
        hostname: 'plain.example.test',
        port: null,
        source: 'known-hosts',
        sourcePath: knownHostsPath,
      },
    ]);
  });

  it('prefers config suggestions over duplicate known_hosts entries and returns stable ids', async () => {
    const homeDir = createHomeFixture();
    writeHomeFile(homeDir, '.ssh/config', `
Host beta
  HostName beta.example.test
  User deploy
  Port 2205
`);
    writeHomeFile(homeDir, '.ssh/known_hosts', `
[beta.example.test]:2205 ssh-ed25519 AAAA
alpha.example.test ssh-ed25519 AAAA
`);

    const first = await discoverConfiguredSshHosts({ homeDir });
    const second = await discoverConfiguredSshHosts({ homeDir });

    expect(first.map(({ alias, source, username }) => ({ alias, source, username }))).toEqual([
      { alias: 'beta', source: 'ssh-config', username: 'deploy' },
      { alias: 'alpha.example.test', source: 'known-hosts', username: null },
    ]);
    expect(first.map(({ id }) => id)).toEqual(second.map(({ id }) => id));
    expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
  });

  it('collapses aliases of one destination while retaining distinct ports and users', async () => {
    const homeDir = createHomeFixture();
    writeHomeFile(homeDir, '.ssh/config', `
Host local local-alias
  HostName 127.0.0.1
  User deploy
Host explicit-default
  HostName 127.0.0.1
  User deploy
  Port 22
Host local-admin
  HostName 127.0.0.1
  User admin
`);
    writeHomeFile(homeDir, '.ssh/known_hosts', `
127.0.0.1 ssh-ed25519 AAAA
[127.0.0.1]:22 ssh-ed25519 AAAA
[127.0.0.1]:53210 ssh-ed25519 AAAA
[127.0.0.1]:53210 ssh-rsa AAAA
[127.0.0.1]:53617 ssh-ed25519 AAAA
`);

    const hosts = await discoverConfiguredSshHosts({ homeDir });
    expect(hosts.map(({ alias, hostname, username, port }) => [alias, hostname, username, port])).toEqual([
      ['local', '127.0.0.1', 'deploy', null],
      ['local-admin', '127.0.0.1', 'admin', null],
      ['127.0.0.1', '127.0.0.1', null, 53210],
      ['127.0.0.1', '127.0.0.1', null, 53617],
    ]);
  });
});
