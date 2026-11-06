import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installStubDaemonSourceBuildInputs } from '../testkit/core/source_runtime_fixture.mjs';
import { prepareStubHappierCliDependencies } from '../testkit/core/stub_happier_cli_files.mjs';
import { resolveStackDaemonCommandContext } from './stack_daemon_command.mjs';
import { sanitizeStackTestRunnerEnv } from '../utils/test/test_env.mjs';

for (const action of ['start', 'restart']) {
test(`explicit source daemon ${action} prepares current source while status retains the incumbent launch`, async t => {
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
  const transportSource = join(repoDir, 'apps/cli/src/daemon/peer/iroh/daemonHomeIrohTransport.ts');
  await mkdir(join(transportSource, '..'), { recursive: true });
  await writeFile(transportSource, 'export const transportRevision = "first-route";');
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'),
    'export { transportRevision } from "./daemon/peer/iroh/daemonHomeIrohTransport"; export const sourceReload = "current-source";');
  await writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
  for (const name of ['prepareSourcePluginUiArtifacts.mjs', 'generateBundledPluginUiArtifacts.mjs']) {
    await writeFile(join(repoDir, 'apps/ui/scripts', name), '');
  }
  await mkdir(join(repoDir, 'packages'));
  await symlink(join(canonicalRepo, 'packages/plugin-sdk'), join(repoDir, 'packages/plugin-sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  await installStubDaemonSourceBuildInputs(repoDir);
  const dependencyEnv = await prepareStubHappierCliDependencies(repoDir, {
    env: sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
  });
  const require = createRequire(import.meta.url);
  for (const dependency of ['tsx', 'semver']) {
    await symlink(join(require.resolve(`${dependency}/package.json`), '..'),
      join(repoDir, 'node_modules', dependency), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const oldEntrypoint = fixture.path('retained/apps/cli/src/incumbent.mjs');
  await mkdir(join(oldEntrypoint, '..'), { recursive: true });
  await writeFile(oldEntrypoint, 'export const sourceReload = "incumbent";');
  const input = { rootDir: join(canonicalRepo, 'apps/stack'), stackName: 'fixture', identity: action === 'start' ? 'qa-f-e2ee-fixtures' : 'default',
    env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
      ...dependencyEnv, HAPPIER_STACK_CLI_HOME_DIR: fixture.path('cli') },
    activeRuntimeState: { sourceRuntimeLaunch: { entrypoint: oldEntrypoint, cliDir: join(repoDir, 'apps/cli') },
      sourceRuntimeIdentities: { daemon: { selected: 'incumbent', loaded: 'incumbent' } } } };
  const status = await resolveStackDaemonCommandContext({ ...input, argv: ['status', '--runtime=source'] });
  assert.equal(status.cliEntrypoint, oldEntrypoint);
  // A retained graph without a usable dependency publication cannot launch,
  // but an explicit reload must prepare its replacement before validating it.
  if (action === 'restart') await writeFile(fixture.path('retained/source-bundle.json'), JSON.stringify({ dependencyPublication: null }));
  const restart = await resolveStackDaemonCommandContext({ ...input, argv: [action, '--runtime=source'] });
  assert.notEqual(restart.cliEntrypoint, oldEntrypoint);
  const emitted = await import(pathToFileURL(restart.cliEntrypoint).href);
  assert.equal(emitted.sourceReload, 'current-source');
  assert.equal(emitted.transportRevision, 'first-route');
  await writeFile(transportSource, 'export const transportRevision = "current-route";');
  const refreshed = await resolveStackDaemonCommandContext({ ...input, argv: [action, '--runtime=source'],
    activeRuntimeState: { ...input.activeRuntimeState,
      sourceRuntimeLaunch: restart.sourceRuntimeLaunchUpdate?.launch ?? input.activeRuntimeState.sourceRuntimeLaunch } });
  assert.notEqual(refreshed.cliEntrypoint, restart.cliEntrypoint);
  assert.equal((await import(pathToFileURL(refreshed.cliEntrypoint).href)).transportRevision, 'current-route');
  const recovered = await resolveStackDaemonCommandContext({ ...input, argv: ['restart'],
    activeRuntimeState: { ...input.activeRuntimeState,
      sourceRuntimeLaunch: { ...input.activeRuntimeState.sourceRuntimeLaunch, entrypoint: fixture.path('missing.mjs') } } });
  assert.equal(recovered.cliEntrypoint, refreshed.cliEntrypoint);
  assert.equal(await readFile(oldEntrypoint, 'utf8'), 'export const sourceReload = "incumbent";');
});
}
