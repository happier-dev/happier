import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createUiProductionHooksVitestConfig } from '../../vitest.uiProductionHooks';
import { createEnvKeyScope } from '../../../../apps/cli/src/testkit/env/envScope';
import { removeTempDir } from '../../../../apps/cli/src/testkit/fs/tempDir';

it('shares one CLI configuration owner across relative and app-alias imports', async () => {
    const config = createUiProductionHooksVitestConfig();
    const owner = config.plugins?.flat().find(plugin => plugin !== null && typeof plugin === 'object'
        && Reflect.get(plugin, 'name') === 'happier-tests-app-source-aliases');
    if (!owner) throw new Error('App source alias owner is unavailable');
    const hook: unknown = Reflect.get(owner, 'resolveId');
    if (typeof hook !== 'function') throw new Error('App source alias resolver is unavailable');
    const importer = fileURLToPath(new URL('../../../../apps/cli/src/api/apiMachine.ts', import.meta.url));
    const canonicalFile = fileURLToPath(new URL('../../../../apps/cli/src/configuration.ts', import.meta.url));
    const resolved: unknown = await Reflect.apply(hook, undefined, ['@/configuration', importer, {}]);
    // configuration.ts has a sibling configuration/ directory. Returning the
    // directory gives aliases a second mutable module identity in the harness.
    expect(resolved).toBe(canonicalFile);
    if (typeof resolved !== 'string') throw new Error('Missing resolved configuration file');
    const alias = await import(resolved);
    const direct = await import('../../../../apps/cli/src/configuration');
    expect(alias.reloadConfiguration).toBe(direct.reloadConfiguration);
    expect(alias.configuration).toBe(direct.configuration);
    const directory = await mkdtemp(join(tmpdir(), 'happier-app-source-identity-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
    try {
        env.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_ACTIVE_SERVER_ID: 'app-source-profile' });
        direct.reloadConfiguration();
        expect(alias.configuration.activeServerId).toBe('app-source-profile');
        expect(alias.configuration).toBe(direct.configuration);
    } finally {
        env.restore();
        direct.reloadConfiguration();
        await removeTempDir(directory);
    }
});
