import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../configuration', () => ({
  configuration: { happyHomeDir: join('/tmp', 'unused-default-home') },
}));

import { resolvePluginStorePaths } from './paths';
import { resolvePluginStorePathLayout, resolveLegacyPluginGenerationRoot } from './pathLayout';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';

describe('plugin registry store paths', () => {
  it('owns the sole registry commit, immutable state revision, generation, and fenced lock paths', () => {
    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '');
    const paths = resolvePluginStorePaths({ happyHomeDir: join('/tmp', 'happier-registry-paths') });

    expect(paths.registryCurrentFilePath).toBe(join(paths.stateDir, 'plugin-registry-current.v1.json'));
    expect(paths.registryCommitLockFilePath).toBe(join(paths.stateDir, 'plugin-registry-commit.v1.lock'));
    expect(paths.stateRevisionsDir).toBe(join(paths.rootDir, 'state-revisions'));
    expect(paths.generationsDir).toBe(resolveLegacyPluginGenerationRoot(paths.happyHomeDir));
    vi.unstubAllEnvs();
  });

  it('keeps executable generations outside private homes and separate for each registry sharing an installation', () => {
    const installHome = join('/tmp', 'happier-managed-code');
    const env = { HOME: join('/tmp', 'custodian'), HAPPIER_FIRST_PARTY_INSTALL_HOME: installHome };
    const home = join(env.HOME, '.happier');
    const paths = resolvePluginStorePathLayout(home, env);
    const second = resolvePluginStorePathLayout(join(env.HOME, '.happier-other'), env);
    expect(dirname(paths.generationsDir)).toBe(join(resolveManagedToolsRoot(env), 'plugins'));
    expect(second.generationsDir).not.toBe(paths.generationsDir);
    expect(paths.stateDir).toBe(join(home, 'plugins', 'plugins', 'state'));
    expect(paths.secretsDir).toBe(join(home, 'plugins', 'plugins', 'secrets'));
  });

  it('keeps a personal or in-home installation private instead of treating it as member-readable code', () => {
    const home = join('/tmp', 'custodian', '.happier');
    for (const installHome of [undefined, join('/tmp', 'custodian', 'payload')]) {
      expect(resolvePluginStorePathLayout(home, { HOME: join('/tmp', 'custodian'),
        HAPPIER_FIRST_PARTY_INSTALL_HOME: installHome }).generationsDir).toBe(resolveLegacyPluginGenerationRoot(home));
    }
  });

});
