import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readConnectedServiceStateSharingManifest,
  removeConnectedServiceStateSharingManifestEntries,
  writeConnectedServiceStateSharingManifest,
} from './connectedServiceStateSharingManifest';

describe('connectedServiceStateSharingManifest', () => {
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
