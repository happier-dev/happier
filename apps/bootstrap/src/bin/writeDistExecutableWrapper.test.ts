import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeDistExecutableWrapper } from './writeDistExecutableWrapper.js';

describe('writeDistExecutableWrapper', () => {
  it('writes an executable dist wrapper that targets the compiled hsetup entrypoint', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-wrapper-'));
    const targetPath = join(rootDir, 'dist', 'bin', 'hsetup');

    try {
      await writeDistExecutableWrapper({
        targetPath,
      });

      expect(readFileSync(targetPath, 'utf8')).toContain("new URL('./hsetup.js', import.meta.url)");
      expect(statSync(targetPath).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
