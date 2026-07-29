import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../configuration', () => ({
  configuration: { happyHomeDir: join('/tmp', 'unused-default-home') },
}));

import { resolvePluginStorePaths } from './paths';

describe('plugin registry store paths', () => {
  it('owns the sole registry commit, immutable state revision, generation, and fenced lock paths', () => {
    const paths = resolvePluginStorePaths({ happyHomeDir: join('/tmp', 'happier-registry-paths') });

    expect(paths.registryCurrentFilePath).toBe(join(paths.stateDir, 'plugin-registry-current.v1.json'));
    expect(paths.registryCommitLockFilePath).toBe(join(paths.stateDir, 'plugin-registry-commit.v1.lock'));
    expect(paths.stateRevisionsDir).toBe(join(paths.rootDir, 'state-revisions'));
    expect(paths.generationsDir).toBe(join(paths.rootDir, 'generations'));
  });
});
