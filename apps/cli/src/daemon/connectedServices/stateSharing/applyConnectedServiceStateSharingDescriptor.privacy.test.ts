import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyConnectedServiceStateSharingDescriptor } from './applyConnectedServiceStateSharingDescriptor';

describe('materialized real native state privacy', () => {
  it.skipIf(process.platform === 'win32')('creates private roots and imports public source roots without changing their permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-private-state-'));
    const sourceRoot = join(root, 'native');
    const targetRoot = join(root, 'selected');
    try {
      await mkdir(join(sourceRoot, '.native/sessions'), { recursive: true });
      await chmod(join(sourceRoot, '.native/sessions'), 0o775);
      await writeFile(join(sourceRoot, '.native/sessions/journal'), 'retained');
      const input = {
        descriptor: {
          providerId: 'fixture', providerSupportStatus: 'supported' as const,
          config: { supported: true, modes: ['isolated'] as const, entries: [] },
          state: { supported: true, modes: ['shared'] as const, entries: ['sessions', 'session-files'].map(name => ({
            path: `.native/${name}`, mode: 'linked' as const, createIfMissing: 'directory' as const, requiresRealDirectory: true,
          })) },
          authIsolation: { mode: 'materialized_home' as const, secretEntries: [] },
        },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated' as const, requestedStateMode: 'shared' as const, effectiveStateMode: 'shared' as const, cwd: root,
      };
      const first = await applyConnectedServiceStateSharingDescriptor(input);
      for (const name of ['sessions', 'session-files']) {
        expect((await lstat(join(targetRoot, '.native', name))).mode & 0o777).toBe(0o700);
      }
      expect((await lstat(join(sourceRoot, '.native/session-files'))).mode & 0o777).toBe(0o700);
      expect((await lstat(join(sourceRoot, '.native/sessions'))).mode & 0o777).toBe(0o775);
      await chmod(join(targetRoot, '.native/session-files'), 0o775);
      await applyConnectedServiceStateSharingDescriptor({ ...input, existingManifest: first.manifest });
      expect((await lstat(join(targetRoot, '.native/session-files'))).mode & 0o777).toBe(0o700);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
