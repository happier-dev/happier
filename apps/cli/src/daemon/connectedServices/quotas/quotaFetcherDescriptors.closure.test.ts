import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

async function listTypeScriptFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(path));
    } else if (entry.isFile() && path.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('daemon plugin import closure', () => {
  it('does not statically import first-party plugin packages from daemon code', async () => {
    const daemonRoot = fileURLToPath(new URL('../../', import.meta.url));
    const offenders: string[] = [];

    for (const file of await listTypeScriptFiles(daemonRoot)) {
      if (file.endsWith('.test.ts')) continue;
      const source = await readFile(file, 'utf8');
      if (source.includes('@happier-dev/plugins-')) {
        offenders.push(relative(daemonRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
