import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { projectPathFromModuleUrl } from './projectPath';

describe('projectPathFromModuleUrl', () => {
  it('treats an external pinned runner snapshot as the runtime project root', () => {
    const snapshotRoot = join(process.cwd(), '.runner-snapshots', 'abc123def4567890');

    expect(projectPathFromModuleUrl(pathToFileURL(join(snapshotRoot, 'api-test.mjs')).href)).toBe(snapshotRoot);
  });

  it('uses the nearest runtime tree marker instead of an ancestor directory name', () => {
    const packageRoot = join(
      process.cwd(),
      'src',
      'npm',
      'node_modules',
      '@happier-dev',
      'cli',
    );

    expect(projectPathFromModuleUrl(
      pathToFileURL(join(packageRoot, 'package-dist', 'packagedRuntime', 'runtimeOwner.mjs')).href,
    )).toBe(packageRoot);
  });
});
