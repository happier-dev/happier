import { mkdtempSync } from 'node:fs';
import { mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { uninstallManagedFirstPartyComponent } from './uninstallManagedFirstPartyComponent.js';

describe('uninstallManagedFirstPartyComponent', () => {
  it('removes the install root and shim paths for a managed CLI install', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-first-party-uninstall-'));
    try {
      const installRoot = join(happyHomeDir, 'cli');
      const currentPath = join(installRoot, 'current');
      const shimDir = join(happyHomeDir, 'bin');
      const shimPath = join(shimDir, 'happier');

      await mkdir(join(currentPath, 'bin'), { recursive: true });
      await writeFile(join(currentPath, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(currentPath, 'bin', 'happier'), '#!/bin/sh\n', 'utf8');
      await mkdir(shimDir, { recursive: true });
      await symlink('../cli/current/bin/happier', shimPath);

      const result = await uninstallManagedFirstPartyComponent({
        componentId: 'happier-cli',
        channel: 'stable',
        processEnv: {
          ...process.env,
          HAPPIER_HOME_DIR: happyHomeDir,
        },
      });

      expect(result.removedPaths).toContain(installRoot);
      expect(result.removedPaths).toContain(shimPath);
      await expect(stat(installRoot)).rejects.toThrow();
      await expect(stat(shimPath)).rejects.toThrow();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
