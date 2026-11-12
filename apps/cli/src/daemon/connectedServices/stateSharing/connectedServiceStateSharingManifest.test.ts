import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import * as filesystem from 'node:fs/promises';

// Observe atomic publication at the filesystem boundary.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import {
  readConnectedServiceStateSharingManifest,
  hasLocalConnectedServiceResumeState,
  removeConnectedServiceStateSharingManifestEntries,
  writeConnectedServiceStateSharingManifest,
} from './connectedServiceStateSharingManifest';

describe('connectedServiceStateSharingManifest', () => {
  it('retains exact delivered credential ownership beside native state across a reload', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'happier-team-native-manifest-'));
    try {
      const deliveries = [{ teamId: 'team-1', resourceId: 'share-1', credentialPaths: ['muse/auth.json'] }];
      await writeConnectedServiceStateSharingManifest(destination, {
        v: 1, requestedStateMode: 'isolated', effectiveStateMode: 'isolated', lastSyncAtMs: 0,
        configEntries: ['muse/settings.json'], stateEntries: [], sessionFileMappings: [], diagnostics: [],
        teamCredentialDeliveries: deliveries,
      });
      expect((await readConnectedServiceStateSharingManifest(destination)).teamCredentialDeliveries).toEqual(deliveries);
    } finally { await rm(destination, { recursive: true, force: true }); }
  });

  it('publishes only changed sharing facts and repairs a missing canonical manifest', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'happier-unchanged-state-manifest-'));
    try {
      const manifest = { v: 1 as const, requestedStateMode: 'isolated' as const,
        effectiveStateMode: 'isolated' as const, lastSyncAtMs: 1, configEntries: [], stateEntries: [],
        sessionFileMappings: [], diagnostics: [] };
      await writeConnectedServiceStateSharingManifest(destination, manifest);
      vi.mocked(filesystem.rename).mockClear();
      await writeConnectedServiceStateSharingManifest(destination, { ...manifest, lastSyncAtMs: 2 });
      expect(filesystem.rename).toHaveBeenCalledTimes(0);
      await writeConnectedServiceStateSharingManifest(destination, { ...manifest, configEntries: ['settings.json'] });
      expect(filesystem.rename).toHaveBeenCalledTimes(1);
      expect((await readConnectedServiceStateSharingManifest(destination)).configEntries).toEqual(['settings.json']);
      await rm(join(destination, '.happier-state-sharing.json'));
      await writeConnectedServiceStateSharingManifest(destination, manifest);
      expect(filesystem.rename).toHaveBeenCalledTimes(2);
    } finally { await rm(destination, { recursive: true, force: true }); }
  });

  it('refuses a retention decision when the state manifest cannot be read or parsed', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'happier-state-sharing-unreadable-'));
    try {
      const manifest = join(destination, '.happier-state-sharing.json');
      await writeFile(manifest, '{');
      await expect(hasLocalConnectedServiceResumeState(destination)).rejects.toThrow();
      await writeFile(manifest, '{"v":2}');
      await expect(hasLocalConnectedServiceResumeState(destination)).rejects.toThrow();
      await writeFile(manifest, '{"v":1,"stateEntries":"invalid"}');
      await expect(hasLocalConnectedServiceResumeState(destination)).rejects.toThrow();
      await rm(manifest);
      await mkdir(manifest);
      await expect(hasLocalConnectedServiceResumeState(destination)).rejects.toThrow();
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('retains archived native state in predecessor homes without a resume inventory', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'happier-state-sharing-predecessor-'));
    try {
      await writeFile(join(destination, '.happier-state-sharing.json'), JSON.stringify({
        v: 1, stateEntries: [],
      }));
      await mkdir(join(destination, 'archived_sessions'));
      await writeFile(join(destination, 'archived_sessions', 'rollout.jsonl'), 'native resume state');
      await expect(hasLocalConnectedServiceResumeState(destination)).resolves.toBe(true);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('backfills manifest defaults for backward-compatible shape reads', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'happier-state-sharing-manifest-'));
    try {
      await writeFile(
        join(destination, '.happier-state-sharing.json'),
        JSON.stringify({
          v: 1,
          configEntries: ['config.toml'],
          stateEntries: ['sessions'],
        }),
        'utf8',
      );

      await expect(readConnectedServiceStateSharingManifest(destination)).resolves.toEqual({
        v: 1,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        lastSyncAtMs: 0,
        configEntries: ['config.toml'],
        stateEntries: ['sessions'],
        sessionFileMappings: [],
        diagnostics: [],
      });
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('falls back to the legacy Codex manifest filename when canonical file is absent', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'happier-state-sharing-manifest-'));
    try {
      await writeFile(
        join(destination, '.happier-codex-home-sharing.json'),
        JSON.stringify({
          v: 1,
          configEntries: ['config.toml'],
          stateEntries: ['sessions'],
        }),
        'utf8',
      );

      await expect(readConnectedServiceStateSharingManifest(destination)).resolves.toMatchObject({
        v: 1,
        configEntries: ['config.toml'],
        stateEntries: ['sessions'],
      });
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('writes canonical manifest and removes legacy Codex manifest after migration write', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'happier-state-sharing-manifest-'));
    try {
      await writeFile(join(destination, '.happier-codex-home-sharing.json'), '{"v":1}', 'utf8');

      await writeConnectedServiceStateSharingManifest(destination, {
        v: 1,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        lastSyncAtMs: 123,
        configEntries: ['config.toml'],
        stateEntries: ['sessions'],
        sessionFileMappings: [],
        diagnostics: [],
      });

      const rawCanonical = await readFile(join(destination, '.happier-state-sharing.json'), 'utf8');
      expect(JSON.parse(rawCanonical)).toMatchObject({
        v: 1,
        configEntries: ['config.toml'],
        stateEntries: ['sessions'],
      });
      await expect(readFile(join(destination, '.happier-codex-home-sharing.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('removes only safe manifest-owned entries', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'happier-state-sharing-manifest-'));
    try {
      await writeFile(join(destination, 'managed-config.toml'), 'managed');
      await writeFile(join(destination, 'local-config.toml'), 'local');
      await writeConnectedServiceStateSharingManifest(destination, {
        v: 1,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        lastSyncAtMs: 0,
        configEntries: ['managed-config.toml', '../outside.toml', '/absolute.toml'],
        stateEntries: [],
        sessionFileMappings: [],
        diagnostics: [],
      });

      const manifest = await readConnectedServiceStateSharingManifest(destination);
      await removeConnectedServiceStateSharingManifestEntries(destination, manifest.configEntries);

      await expect(readFile(join(destination, 'managed-config.toml'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(destination, 'local-config.toml'), 'utf8')).resolves.toBe('local');
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('ignores root-relative manifest entries that would resolve to the destination home', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'happier-state-sharing-manifest-'));
    try {
      await writeFile(join(destination, 'local-config.toml'), 'local');
      await writeConnectedServiceStateSharingManifest(destination, {
        v: 1,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        lastSyncAtMs: 0,
        configEntries: ['.', './', 'nested/..', 'local-config.toml'],
        stateEntries: [],
        sessionFileMappings: [],
        diagnostics: [],
      });

      const manifest = await readConnectedServiceStateSharingManifest(destination);
      expect(manifest.configEntries).toEqual(['local-config.toml']);

      await removeConnectedServiceStateSharingManifestEntries(destination, ['.', './', 'nested/..']);

      await expect(readFile(join(destination, 'local-config.toml'), 'utf8')).resolves.toBe('local');
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});
