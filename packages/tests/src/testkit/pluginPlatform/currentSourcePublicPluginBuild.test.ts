import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { repoRootDir } from '../paths';
import { buildCurrentSourcePublicPluginFixture } from './currentManagedStackPluginUiQa';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const spawn = vi.fn(actual.spawn);
  // The OS boundary refuses a workspace distribution build. The public plugin
  // build still executes a real child CLI and its ordinary author toolchain.
  spawn.mockImplementation((...args) => {
    if (args[1]?.includes('build:shared')) {
      throw new Error('source_public_plugin_build_requested_workspace_distribution');
    }
    return actual.spawn(...args);
  });
  return { ...actual, spawn };
});

let testDir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (testDir) await rm(testDir, { recursive: true, force: true });
  testDir = undefined;
});

it('builds the public example from workspace source without distribution preparation or a CLI snapshot', async () => {
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
  vi.stubEnv('NODE_OPTIONS', '');
  testDir = await mkdtemp(join(tmpdir(), 'current-source-public-plugin-build-'));
  const pluginRoot = join(testDir, 'code-defined');
  await mkdir(pluginRoot);
  for (const name of ['package.json', 'index.ts', 'tsconfig.json']) {
    await cp(join(repoRootDir(), 'packages/plugin-sdk/examples/code-defined', name), join(pluginRoot, name));
  }

  await buildCurrentSourcePublicPluginFixture(pluginRoot);

  expect(JSON.parse(await readFile(join(pluginRoot, '.happier-plugin/plugin.json'), 'utf8'))).toMatchObject({
    id: 'com.example.echo',
  });
  expect((await stat(join(pluginRoot, 'dist/index.js'))).size).toBeGreaterThan(0);
  expect(await readdir(testDir)).toEqual(['code-defined']);
}, 0);
