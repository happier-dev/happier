import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const manifest: { exports: Record<string, { 'happier-source'?: string }> } = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
);

describe('shared client runtime boundaries', () => {
  const uiEntries = [
    'components/settings/server/localControl/useLocalRelayRuntimeControl.ts',
    'components/systemTasks/remoteSshBootstrap/nativeTask.ts',
    'components/personalHome/bootstrap/runPersonalHomeBootstrapFromSystemTasks.ts',
    'sync/domains/accessEndpoints/sources/relayAccessSource.ts',
    'components/plugins/surfaces/pluginSurfaceAccountActionServices.ts',
    'sync/api/machines/managedMachineEnrollment.ts',
    'sync/api/machines/managedMachineOrigination.ts',
    'sync/api/machines/managedMachineAccountAcquire.ts',
    'sync/api/machines/managedMachineAccountNative.ts',
    'sync/api/machines/managedMachineAccountGuest.ts',
    'utils/system/runtimeFetch.ts',
  ];
  it.each([
    ...uiEntries.map((entry) => `apps/ui/sources/${entry}`),
    'packages/cli-common/src/machines/managed/index.ts',
    'packages/cli-common/src/systemTasks/nativeRemoteSshBootstrap.ts',
    'packages/plugins/machine-vercel/src/machine/nativeClient.ts',
    'packages/plugins/machine-vercel/src/manifest.ts',
    'packages/plugins/machine-vercel/src/account.ts',
    'packages/plugins/machine-fly/src/machine/nativeClient.ts',
    'packages/plugins/machine-fly/src/manifest.ts',
    'packages/plugins/machine-fly/src/account.ts',
    'packages/plugins/machine-digitalocean/src/machine/nativeClient.ts',
    'packages/plugins/machine-digitalocean/src/manifest.ts',
    'packages/plugins/machine-digitalocean/src/account.ts',
    'packages/plugins/machine-digitalocean/src/accountRuntime.ts',
  ])('%s does not bundle host filesystem, process or module-loader code', async (entry) => {
    const result = await build({
      absWorkingDir: repoRoot,
      entryPoints: [resolve(repoRoot, entry)],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'neutral',
      format: 'esm',
      packages: 'external',
      // Metro transforms re-exported modules even when the client uses only one export.
      treeShaking: false,
      logLevel: 'silent',
      plugins: [{
        name: 'cli-common-public-source-exports',
        setup(builder) {
          // This gate owns cli-common's client graph; Metro validates the full app.
          builder.onResolve({ filter: /^@\// }, ({ path }) => ({ path, external: true }));
          builder.onResolve({ filter: /^@happier-dev\/cli-common(?:\/|$)/ }, ({ path }) => {
            const subpath = path.slice('@happier-dev/cli-common'.length);
            const source = manifest.exports[`.${subpath}`]?.['happier-source'];
            if (!source) throw new Error(`Missing cli-common source export: ${path}`);
            return { path: resolve(packageRoot, source) };
          });
        },
      }],
    });
    const nodeImports = Object.values(result.metafile.inputs)
      .flatMap((input) => input.imports.map((dependency) => dependency.path))
      .filter((path) => path.startsWith('node:'));
    expect([...new Set(nodeImports)].sort()).toEqual([]);
  });
});
