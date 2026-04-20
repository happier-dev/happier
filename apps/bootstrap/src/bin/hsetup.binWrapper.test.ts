import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const bootstrapPackageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('apps/bootstrap bin/hsetup.mjs', () => {
  it('fails with a packaged entrypoint error when dist/bin/hsetup.js is missing', () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'hsetup-bin-wrapper-'));
    const packageRoot = join(sandboxRoot, 'bootstrap');
    const wrapperPath = join(packageRoot, 'bin', 'hsetup.mjs');

    mkdirSync(dirname(wrapperPath), { recursive: true });
    copyFileSync(join(bootstrapPackageRoot, 'bin', 'hsetup.mjs'), wrapperPath);

    try {
      const result = spawnSync(process.execPath, [wrapperPath, '--help'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Bootstrap packaged entrypoint is missing:');
      expect(result.stderr).toContain('dist/bin/hsetup.js');
      expect(result.stderr).not.toContain('tsx');
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});
