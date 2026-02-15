import fs from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { projectPath } from '@/projectPath';

function matchesDynamicSpawnHooksImport(text: string): boolean {
  // When daemon spawn hooks are lazily loaded via dynamic import/require, the built output
  // references a chunk like `spawnHooks-<hash>.mjs` at runtime. If the dist folder is
  // rebuilt/cleaned while a daemon is running (common during local dev), those runtime
  // imports can fail and break session spawning.
  //
  // We intentionally assert that `getDaemonSpawnHooks` is not implemented as a lazy
  // dynamic import in the built output.
  const patterns: RegExp[] = [
    /getDaemonSpawnHooks:\s*async\s*\(\)\s*=>\s*\(await\s+import\(\s*['"]\.\/spawnHooks-[^'"]+['"]\s*\)\)/,
    /getDaemonSpawnHooks:\s*async\s*\(\)\s*=>\s*\(await\s+Promise\.resolve\(\)\.then\([^)]*require\(\s*['"]\.\/spawnHooks-[^'"]+['"]\s*\)/,
  ];

  return patterns.some((p) => p.test(text));
}

async function listDistFiles(distDir: string): Promise<string[]> {
  // In some environments (especially when build/test are orchestrated across workspaces),
  // the build output directory can appear a moment after the test process starts.
  // Retry briefly to avoid flaky ENOENT/empty-dir failures.
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const entries = await fs.readdir(distDir);
      const files = entries.filter((e) => e.endsWith('.mjs') || e.endsWith('.cjs')).map((e) => join(distDir, e));
      if (files.length > 0) return files;
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const entries = await fs.readdir(distDir);
  return entries.filter((e) => e.endsWith('.mjs') || e.endsWith('.cjs')).map((e) => join(distDir, e));
}

describe('CLI build output', () => {
  it('does not lazy-load daemon spawn hooks via dynamic import (prevents runtime chunk-missing failures)', async () => {
    // Some tests may change `process.cwd()`; resolve relative to the CLI project root instead.
    const distDir = join(projectPath(), 'dist');
    const files = await listDistFiles(distDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicSpawnHooksImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 20_000);
});
