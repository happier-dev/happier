import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scmSourceDirectory = dirname(fileURLToPath(import.meta.url));
const protocolDirectory = resolve(scmSourceDirectory, '../..');

describe('SCM public entrypoint initialization', () => {
  it('loads the emitted SCM entrypoint without an internal barrel cycle', async () => {
    const sourceEntrypoint = await import('./index.js');
    expect(sourceEntrypoint.ScmOperationErrorCodeSchema).toBeDefined();

    const runtimeBarrelImporters = readdirSync(scmSourceDirectory)
      .filter((fileName) => fileName.endsWith('.ts') && !fileName.endsWith('.test.ts'))
      .filter((fileName) => {
        const source = readFileSync(join(scmSourceDirectory, fileName), 'utf8');
        return /import\s+(?!type\s)[^;]+from\s+['"]\.\/index\.js['"];?/m.test(source);
      });

    expect(runtimeBarrelImporters).toEqual([]);

    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const scm = await import('./dist/scm/index.js'); if (!scm.ScmOperationErrorCodeSchema) process.exit(1);",
      ],
      { cwd: protocolDirectory, stdio: 'pipe' },
    );
  });
});
