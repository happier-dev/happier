import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, onTestFinished, vi } from 'vitest';

import * as runtimeAuthority from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { managedPnpmBinPath } from '@/packagedRuntime/managedTools/pnpm/managedPnpm';
import { runPluginAuthorToolchain } from '@/plugins/authoring/toolchain';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { withPatchedProcessEnv } from '../../../../stack/scripts/testkit/core/env_scope.mjs';
import {
  holdNativeAdmissionFixtureMemory,
  installWorkspaceAdmissionProcessFixture,
} from '../../../../stack/scripts/testkit/core/native_admission_fixture.mjs';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

it.skipIf(process.platform !== 'linux').each(['author install', 'daemon registration'] as const)(
  '%s queues a cold source SDK and removes the request on cancellation',
  async (entrypoint) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-author-admission-'));
    const cleanup: Array<() => void | Promise<void>> = [];
    onTestFinished(async () => {
      try {
        for (const dispose of cleanup.reverse()) await dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const fixture = { after: (dispose: () => void | Promise<void>) => { cleanup.push(dispose); } };
    const native = await installWorkspaceAdmissionProcessFixture(fixture, root);
    const repoRoot = join(root, 'native-owner');
    const cliDir = join(repoRoot, 'apps/cli');
    const sdkDir = join(repoRoot, 'packages/plugin-sdk');
    const projectRoot = join(root, 'plugin');
    const happyHomeDir = join(root, 'home');
    const sdkName = '@happier-dev/plugin-sdk';
    await Promise.all([
      mkdir(join(cliDir, 'scripts'), { recursive: true }),
      mkdir(join(repoRoot, 'apps/ui'), { recursive: true }),
      mkdir(join(repoRoot, 'apps/server'), { recursive: true }),
      mkdir(join(sdkDir, 'src'), { recursive: true }),
      mkdir(join(projectRoot, '.happier-plugin'), { recursive: true }),
      mkdir(happyHomeDir, { recursive: true }),
    ]);
    const publisher = pathToFileURL(resolve(import.meta.dirname, '../../../scripts/buildSharedDeps.mjs')).href;
    await Promise.all([
      writeFile(join(repoRoot, 'package.json'), '{"private":true}'),
      writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n'),
      writeFile(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n'),
      writeFile(join(repoRoot, 'apps/ui/package.json'), '{"name":"@fixture/ui"}'),
      writeFile(join(repoRoot, 'apps/server/package.json'), '{"name":"@fixture/server"}'),
      writeFile(join(cliDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli', dependencies: { [sdkName]: 'workspace:*' }, bundledDependencies: [sdkName],
      })),
      writeFile(join(cliDir, 'scripts/buildSharedDeps.mjs'), `export { prepareSourceDevAuthorPackages } from ${JSON.stringify(publisher)};\n`),
      writeFile(join(sdkDir, 'package.json'), JSON.stringify({
        name: sdkName, version: '0.0.0', type: 'module', main: './dist/index.js',
        scripts: { build: 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json' },
        happier: { publicSdkRelease: { posture: 'developer_preview' } },
      })),
      writeFile(join(sdkDir, 'src/index.ts'), 'export const sdk = true;\n'),
      writeFile(join(sdkDir, 'tsconfig.json'), '{}\n'),
      writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'cold-author', type: 'module', dependencies: { [sdkName]: '0.0.0' },
      })),
      writeFile(join(projectRoot, '.happier-plugin/plugin.json'), JSON.stringify(
        createPluginManifestV2Fixture({ id: 'acme.cold-author', entrypoints: undefined }),
      )),
    ]);
    // Keep the isolated broker's disk observation independent of worker mounts.
    const df = join(native.binDir, 'df');
    await writeFile(df, "#!/bin/sh\nprintf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' 'fixture 200000000 1 199999999 1% /'\n", { mode: 0o755 });
    const env = {
      ...native.env,
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_MANAGED_TOOLS_ROOT: join(happyHomeDir, 'tools'),
      HAPPIER_PNPM_BIN: undefined,
    };
    const managedPnpm = managedPnpmBinPath(env);
    await mkdir(resolve(managedPnpm, '..'), { recursive: true });
    await writeFile(managedPnpm, '#!/bin/sh\nexit 97\n');
    await chmod(managedPnpm, 0o755);

    // Use a separate source runtime's manifests and the real workspace publisher.
    const authority = vi.spyOn(runtimeAuthority, 'resolveAuthoritativePackagedRuntimeProjectRoot')
      .mockReturnValue({ root: cliDir, provenance: 'source-module' });
    cleanup.push(() => { authority.mockRestore(); });
    const pressure = await holdNativeAdmissionFixtureMemory(fixture, native, { totalKiB: 70 * 1024 * 1024, availableKiB: 1 });
    // Keys stripped from the isolated child environment must also be unset
    // for the in-process callers, including the real worker's admission grant.
    const unset = Object.fromEntries(Object.keys(process.env).filter(key => !(key in env))
      .map(key => [key, undefined]));
    withPatchedProcessEnv(fixture, { ...unset, ...env });
    const controller = new AbortController();
    const daemon = entrypoint === 'daemon registration' ? createDaemonPluginRuntimeOwner({
      happyHomeDir,
      staleCandidateCleanup: 'disabled',
      reloadController: createPluginReloadController(),
      connectedAccounts: {
        getBinding: async () => null,
        requestSelection: async () => { throw new Error('Unexpected credential selection'); },
        materialize: async () => { throw new Error('Unexpected credential materialization'); },
        listAccounts: async () => { throw new Error('Unexpected Account listing'); },
        materializeListedAccount: async () => { throw new Error('Unexpected credential materialization'); },
        watch: () => ({ dispose() {} }),
      },
    }) : undefined;
    const result = daemon
      ? daemon.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: projectRoot }, controller.signal)
      : runPluginAuthorToolchain({ operation: 'install', projectRoot, signal: controller.signal });
    let settled: unknown;
    void result.then(value => { settled = value; }, error => { settled = error; });
    try {
      const queued = await Promise.race([
        vi.waitFor(async () => {
          const status = await native.brokerStatus();
          expect(status.waitingByClassAndFloor).toEqual([
            expect.objectContaining({ className: 'package-dist', count: 1 }),
          ]);
          return true;
        }, { timeout: 12_000 }),
        result.then(() => false, () => false),
      ]);
      expect(queued, JSON.stringify(settled)).toBe(true);
      controller.abort();
      await vi.waitFor(async () => {
        expect((await native.brokerStatus()).waitingCount).toBe(0);
      }, { timeout: 3_000 });
      await result;
    } finally {
      controller.abort();
      await pressure.release();
      await result.catch(() => undefined);
      await daemon?.changeService.shutdown();
    }
  }, 30_000,
);
