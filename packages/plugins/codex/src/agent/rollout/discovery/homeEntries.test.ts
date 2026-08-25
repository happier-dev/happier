import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  homeEntries,
  resolveConfiguredCodexHomePath,
} from './homeEntries';

describe('Codex external session home entries', () => {
  it('resolves CODEX_HOME relative to the caller environment home', () => {
    expect(resolveConfiguredCodexHomePath({
      CODEX_HOME: '~/custom-codex',
      HOME: '/tmp/codex-user',
    })).toBe(resolve('/tmp/codex-user', 'custom-codex'));
  });

  it('falls back to the caller environment home when CODEX_HOME is unset', () => {
    expect(resolveConfiguredCodexHomePath({
      HOME: '/tmp/codex-user',
    })).toBe(resolve('/tmp/codex-user', '.codex'));
  });

  it('uses the caller environment home for a user-source scan without CODEX_HOME', async () => {
    const entries = await homeEntries({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: '/tmp/happier-active-server',
      env: { HOME: '/tmp/codex-user-scan' },
    });

    expect(entries).toEqual([{
      codexHome: resolve('/tmp/codex-user-scan', '.codex'),
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: resolve('/tmp/codex-user-scan', '.codex'),
      },
    }]);
  });

  it('uses an exact connected-service group homePath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-group-home-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const groupCodexHome = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      '__groups',
      'team',
      'codex',
      'codex-home',
    );
    await mkdir(join(groupCodexHome, 'sessions'), { recursive: true });
    await writeFile(join(groupCodexHome, 'sessions', 'rollout-2026-01-01T00-00-00-11111111-1111-1111-1111-111111111111.jsonl'), '', 'utf8');
    const verifiedGroupCodexHome = await realpath(groupCodexHome);

    const entries = await homeEntries({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'team',
        homePath: groupCodexHome,
      },
      activeServerDir,
      env: {},
    });

    expect(entries).toEqual([
      {
        codexHome: verifiedGroupCodexHome,
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceGroupId: 'team',
          homePath: verifiedGroupCodexHome,
        },
      },
    ]);
  });
  it('rejects an exact connected-service profile home whose ancestor symlink escapes the connected-service root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-ancestor-escape-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes');
    const outsideServiceRoot = join(root, 'outside', 'openai-codex');
    const outsideCodexHome = join(outsideServiceRoot, 'profile-1', 'codex', 'codex-home');
    await mkdir(join(outsideCodexHome, 'sessions'), { recursive: true });
    await mkdir(homesRoot, { recursive: true });
    // The service directory INSIDE the namespace is an alias for bytes outside it.
    await symlink(outsideServiceRoot, join(homesRoot, 'openai-codex'), 'dir');

    const entries = await homeEntries({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
      },
      activeServerDir,
      env: {},
    });

    expect(entries).toEqual([]);
  });

  it('rejects an exact connected-service group home whose ancestor symlink escapes the connected-service root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-ancestor-escape-group-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes');
    const outsideGroupsRoot = join(root, 'outside', 'groups');
    const outsideCodexHome = join(outsideGroupsRoot, 'team', 'codex', 'codex-home');
    await mkdir(join(outsideCodexHome, 'sessions'), { recursive: true });
    await mkdir(join(homesRoot, 'openai-codex'), { recursive: true });
    await symlink(outsideGroupsRoot, join(homesRoot, 'openai-codex', '__groups'), 'dir');

    const entries = await homeEntries({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'team',
      },
      activeServerDir,
      env: {},
    });

    expect(entries).toEqual([]);
  });

  it('skips enumerated profile and group homes reached through an intermediate symlink out of the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-enumerated-escape-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const serviceRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex');
    const outsideAgentDir = join(root, 'outside', 'codex');
    await mkdir(join(outsideAgentDir, 'codex-home', 'sessions'), { recursive: true });
    // Real profile/group directories; the per-agent directory under each is the alias.
    await mkdir(join(serviceRoot, 'profile-escape'), { recursive: true });
    await symlink(outsideAgentDir, join(serviceRoot, 'profile-escape', 'codex'), 'dir');
    await mkdir(join(serviceRoot, '__groups', 'group-escape'), { recursive: true });
    await symlink(outsideAgentDir, join(serviceRoot, '__groups', 'group-escape', 'codex'), 'dir');

    const entries = await homeEntries({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
      },
      activeServerDir,
      env: {},
    });

    expect(entries).toEqual([]);
  });

  it('keeps enumerated in-root homes, a symlinked connected-services root, and shared-state entry symlinks working', async () => {
    const realRoot = await mkdtemp(join(tmpdir(), 'happier-codex-positive-real-'));
    const aliasRoot = join(await mkdtemp(join(tmpdir(), 'happier-codex-positive-alias-')), 'alias');
    await symlink(realRoot, aliasRoot, 'dir');
    const activeServerDir = join(aliasRoot, 'servers', 'cloud');
    const serviceRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex');
    const profileHome = join(serviceRoot, 'profile-1', 'codex', 'codex-home');
    const groupHome = join(serviceRoot, '__groups', 'team', 'codex', 'codex-home');
    await mkdir(profileHome, { recursive: true });
    await mkdir(groupHome, { recursive: true });
    // Shared-state mode links transcript entries INSIDE a materialized home at the
    // user's real Codex home; that capability must survive home admission.
    const userCodexSessions = join(realRoot, 'user-codex', 'sessions');
    await mkdir(userCodexSessions, { recursive: true });
    await symlink(userCodexSessions, join(profileHome, 'sessions'), 'dir');

    const entries = await homeEntries({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
      },
      activeServerDir,
      env: {},
    });

    expect(entries).toEqual([
      {
        codexHome: await realpath(profileHome),
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
          homePath: await realpath(profileHome),
        },
      },
      {
        codexHome: await realpath(groupHome),
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceGroupId: 'team',
          homePath: await realpath(groupHome),
        },
      },
    ]);
  });
});
