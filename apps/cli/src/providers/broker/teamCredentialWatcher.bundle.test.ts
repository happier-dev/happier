import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkspaceSourceResolver,
  readCliSourceEntries,
  readWorkspacePackages,
  SOURCE_CONDITION,
  SOURCE_RUNTIME_OUTPUT_OPTIONS,
} from '@happier-dev/cli-common/sourceRuntimeEntries';
import { expect, it } from 'vitest';

import { projectPath } from '@/projectPath';

it('keeps the GitHub watcher brokers inside the guest CLI dist closure', async () => {
  const cliRoot = projectPath();
  const repoDir = join(cliRoot, '../..');
  const requireFromProject = createRequire(join(cliRoot, 'package.json'));
  const esbuild = requireFromProject('esbuild') as typeof import('esbuild');
  const cliDistBuildManifest: typeof import('@happier-dev/cli-common/cliDistBuildManifest') =
    requireFromProject('@happier-dev/cli-common/cliDistBuildManifest');
  const manifest = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
  const { entries } = await readCliSourceEntries({
    repoDir, manifest, transform: esbuild.transform,
    mainOutput: 'package-dist/index', publicPrefix: 'package-dist',
    pluginPrefix: (name) => `node_modules/${name}`,
  });
  const daemonOutput = 'node_modules/@happier-dev/plugins-scm-github/.happier-plugin-build/daemon';
  const daemonEntry = entries[daemonOutput];
  expect(daemonEntry).toBeDefined();
  const payload = await mkdtemp(join(tmpdir(), 'happier-github-watcher-bundle-'));
  try {
    // The native guest builder emits the plugin as a separate entry outside
    // package-dist. A broker import of that entry compiles to an escaping edge.
    const { metafile } = await esbuild.build({
      absWorkingDir: repoDir,
      entryPoints: {
        [daemonOutput]: daemonEntry!,
        'package-dist/watcher': join(cliRoot, 'src/providers/broker/teamCredentialWatcherClient.ts'),
        'package-dist/custodian': join(cliRoot, 'src/providers/broker/teamCredentialBrokerWatcherRead.ts'),
      },
      outdir: payload,
      chunkNames: 'package-dist/chunks/[name]-[hash]',
      bundle: true, splitting: true, metafile: true, format: 'esm', platform: 'node', target: 'node20',
      ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
      conditions: [SOURCE_CONDITION],
      logLevel: 'silent',
      plugins: [createWorkspaceSourceResolver({ workspacePackages: await readWorkspacePackages(repoDir), requireFromProject })],
    });
    const daemonImports = Object.entries(metafile.outputs)
      .flatMap(([from, output]) => output.imports
        .filter(({ path }) => path.endsWith(`/${daemonOutput}.js`))
        .map(({ path, kind }) => ({ from, path, kind })));
    expect(daemonImports).toEqual([]);
    const entrypoint = join(payload, 'package-dist/watcher.js');
    cliDistBuildManifest.writeCliDistBuildManifest(entrypoint);
    expect(cliDistBuildManifest.readCliDistBuildManifest(entrypoint).ok).toBe(true);
  } finally {
    await rm(payload, { recursive: true, force: true });
  }
}, 120_000);
