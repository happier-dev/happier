import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { resolvePtyProviderModuleIds } from './provider';

afterEach(() => vi.unstubAllEnvs());

describe('PTY managed runtime modules', () => {
  it('resolves native bindings from the launched shim payload instead of its bin directory', async () => {
    await withTempDir('happier-pty-shim-home-', async (home) => {
      const installRoot = join(home, 'cli-preview');
      const versionRoot = join(installRoot, 'versions', 'version-a');
      const packageRoot = join(versionRoot, 'node_modules', 'node-pty');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ main: 'native/entry.cjs' }));
      writeFileSync(join(home, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel: 'preview' }));
      writeFileSync(join(installRoot, 'current.version'), 'version-a\n');
      vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', join(home, 'another-install'));
      const shim = join(home, 'bin', 'happier.exe');

      expect(resolvePtyProviderModuleIds('node-pty', { currentExecPath: shim, argv: [shim] })).toContain(
        join(packageRoot, 'native', 'entry.cjs'),
      );
    });
  });
});
