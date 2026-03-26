import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { resolveRuntimeEntrypoint } from '../../bin/_resolveRuntimeEntrypoint.mjs';

describe('resolveRuntimeEntrypoint', () => {
  it('falls back to .dist.hstack-backup when dist and package-dist are missing', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const backupDir = join(root, '.dist.hstack-backup');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'index.mjs'), 'export {};\n', 'utf8');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(backupDir, 'index.mjs'));
  });
});
