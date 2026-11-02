import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { resolveStackDaemonCommandContext } from './stack_daemon_command.mjs';
import { sanitizeStackTestRunnerEnv } from '../utils/test/test_env.mjs';

test('explicit source daemon restart prepares current source while status retains the incumbent launch', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-daemon-refresh-', registerCleanup: false });
  t.after(async () => {
    const makeWritable = async directory => {
      await chmod(directory, 0o755);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
      }
    };
    await makeWritable(fixture.root);
    await fixture.cleanup();
  });
  const repoDir = fixture.path('repo');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const directory of ['apps/cli/src', 'apps/ui/scripts', 'apps/stack/scripts/build', 'scripts/workspaces']) {
    await mkdir(join(repoDir, directory), { recursive: true });
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(repoDir, 'apps/cli/tsconfig.json'), '{}');
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const sourceReload = "current-source";');
  await writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
  for (const name of ['prepareSourcePluginUiArtifacts.mjs', 'generateBundledPluginUiArtifacts.mjs']) {
    await writeFile(join(repoDir, 'apps/ui/scripts', name), '');
  }
  for (const directory of ['packages', 'node_modules']) {
    await symlink(join(canonicalRepo, directory), join(repoDir, directory), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const oldEntrypoint = fixture.path('retained/apps/cli/src/incumbent.mjs');
  await mkdir(join(oldEntrypoint, '..'), { recursive: true });
  await writeFile(oldEntrypoint, 'export const sourceReload = "incumbent";');
  const input = { rootDir: join(canonicalRepo, 'apps/stack'), stackName: 'fixture', identity: 'default',
    env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
      HAPPIER_STACK_CLI_HOME_DIR: fixture.path('cli') },
    activeRuntimeState: { sourceRuntimeLaunch: { entrypoint: oldEntrypoint, cliDir: join(repoDir, 'apps/cli') },
      sourceRuntimeIdentities: { daemon: { selected: 'incumbent', loaded: 'incumbent' } } } };
  const status = await resolveStackDaemonCommandContext({ ...input, argv: ['status', '--runtime=source'] });
  assert.equal(status.cliEntrypoint, oldEntrypoint);
  // A retained graph without a usable dependency publication cannot launch,
  // but an explicit reload must prepare its replacement before validating it.
  await writeFile(fixture.path('retained/source-bundle.json'), JSON.stringify({ dependencyPublication: null }));
  const restart = await resolveStackDaemonCommandContext({ ...input, argv: ['restart', '--runtime=source'] });
  assert.notEqual(restart.cliEntrypoint, oldEntrypoint);
  const emitted = await import(pathToFileURL(restart.cliEntrypoint).href);
  assert.equal(emitted.sourceReload, 'current-source');
  const recovered = await resolveStackDaemonCommandContext({ ...input, argv: ['restart'],
    activeRuntimeState: { ...input.activeRuntimeState,
      sourceRuntimeLaunch: { ...input.activeRuntimeState.sourceRuntimeLaunch, entrypoint: fixture.path('missing.mjs') } } });
  assert.equal(recovered.cliEntrypoint, restart.cliEntrypoint);
  assert.equal(await readFile(oldEntrypoint, 'utf8'), 'export const sourceReload = "incumbent";');
});
