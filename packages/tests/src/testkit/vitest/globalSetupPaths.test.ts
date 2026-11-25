import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveVitestGlobalSetupPaths } from './globalSetupPaths';

describe('resolveVitestGlobalSetupPaths', () => {
  it('keeps core e2e artifacts under the logs dir while retaining the repository build lock', () => {
    const paths = resolveVitestGlobalSetupPaths({
      rootDir: '/repo',
      lane: 'core-slow',
      env: {
        HAPPIER_E2E_LOGS_DIR: '/tmp/happier-e2e',
      },
    });

    expect(paths.setupDir).toBe(resolve('/tmp/happier-e2e', 'vitest-global-setup', 'core-slow'));
    expect(paths.snapshotDir).toBe(resolve('/tmp/happier-e2e', 'vitest-global-setup', 'core-slow', 'cli-dist-snapshot'));
    expect(paths.lockPath).toBe(resolve('/repo', '.project', 'tmp', 'cli-dist-build.lock'));
  });

  it.each([
    {},
    { HAPPIER_E2E_OWNED_RUN_LOGS_DIR: resolve('/repo', '.project', 'logs', 'e2e', 'default-run') },
  ])('uses shared snapshots for the default logs namespace (%j)', env => {
    const paths = resolveVitestGlobalSetupPaths({
      rootDir: '/repo',
      lane: 'core-fast',
      env,
    });

    expect(paths.setupDir).toBe(resolve('/repo', '.project', 'tmp', 'vitest-global-setup', 'core-fast'));
    expect(paths.snapshotDir).toBe(resolve('/repo', '.project', 'tmp', 'cli-dist-snapshot'));
    expect(paths.lockPath).toBe(resolve('/repo', '.project', 'tmp', 'cli-dist-build.lock'));
  });
});
