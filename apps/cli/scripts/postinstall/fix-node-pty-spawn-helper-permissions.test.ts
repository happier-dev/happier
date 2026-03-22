import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';

const require = createRequire(import.meta.url);
const { fixNodePtySpawnHelperPermissions } = require('./fix-node-pty-spawn-helper-permissions.cjs') as {
  fixNodePtySpawnHelperPermissions: (options?: { cwd?: string }) => { fixed: number; paths: string[] };
};

describe('fixNodePtySpawnHelperPermissions', () => {
  it('restores executable permissions for bundled node-pty spawn helpers', () => {
    if (process.platform === 'win32') return;

    const root = createTempDirSync('happier-node-pty-permissions-');
    try {
      const helperPaths = [
        join(root, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
        join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'build', 'Release', 'spawn-helper'),
      ];

      for (const helperPath of helperPaths) {
        mkdirSync(join(helperPath, '..'), { recursive: true });
        writeFileSync(helperPath, '#!/usr/bin/env node\n', 'utf8');
        chmodSync(helperPath, 0o644);
      }

      const result = fixNodePtySpawnHelperPermissions({ cwd: root });
      expect(result.fixed).toBe(2);

      for (const helperPath of helperPaths) {
        const mode = statSync(helperPath).mode & 0o777;
        expect(mode & 0o111).not.toBe(0);
      }
    } finally {
      removeTempDirSync(root);
    }
  });
});
