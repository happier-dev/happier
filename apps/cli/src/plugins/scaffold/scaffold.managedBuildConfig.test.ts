import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { preparePluginAuthorDependencies } from '../authoring/toolchain';
import { scaffoldLocalPlugin } from './scaffold';

type PluginUiBuilder = typeof import('../../../../../packages/plugin-sdk/dist/ui/build/bin.js');

const pluginSdkRoot = fileURLToPath(new URL('../../../../../packages/plugin-sdk', import.meta.url));
// A TypeScript build config is loaded through the project's own `typescript`
// devDependency, which the scaffold declares and a real dependency preparation
// installs. This stub install must materialize it for the same reason it
// materializes the SDK.
const typescriptPackageRoot = fileURLToPath(new URL('../../../../../node_modules/typescript', import.meta.url));
const pluginUiBuilderPath = fileURLToPath(new URL(
  '../../../../../packages/plugin-sdk/dist/ui/build/bin.js',
  import.meta.url,
));

describe('scaffoldLocalPlugin managed UI build configuration', () => {
  it('builds a fresh hosted-web scaffold after dependency preparation without compiling its daemon module first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-fresh-ui-build-'));
    const projectRoot = join(root, 'hosted');

    try {
      const scaffolded = await scaffoldLocalPlugin({
        targetDir: projectRoot,
        pluginId: 'acme.fresh-hosted',
        displayName: 'Fresh hosted',
        ui: 'hostedWeb',
      });
      expect(scaffolded.ok).toBe(true);
      if (!scaffolded.ok) return;

      const dependencyPreparation = await preparePluginAuthorDependencies({ projectRoot }, {
        ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
        managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
        buildManagedPnpmEnvironment: (environment = {}) => environment,
        processEnv: {},
        spawn: async (input) => {
          expect(input).toMatchObject({
            command: '/happier/tools/pnpm/current/bin/pnpm',
            args: ['install', '--ignore-scripts', '--lockfile=false'],
            cwd: projectRoot,
          });
          const packageScope = join(projectRoot, 'node_modules', '@happier-dev');
          await mkdir(packageScope, { recursive: true });
          await symlink(pluginSdkRoot, join(packageScope, 'plugin-sdk'), 'dir');
          await symlink(typescriptPackageRoot, join(projectRoot, 'node_modules', 'typescript'), 'dir');
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        },
      });
      expect(dependencyPreparation).toEqual({ ok: true, projectRoot });

      const buildConfig = await readFile(join(projectRoot, 'pluginUiBuild.ts'), 'utf8');
      expect(buildConfig).toContain('buildUiSurfaceTargets(mainSurface)');
      // The config derives its target from the one surface declaration, and
      // never from the not-yet-built daemon bundle.
      expect(buildConfig).not.toContain("./dist/index.js");
      const surfaceModule = await readFile(join(projectRoot, 'src', 'ui', 'surfaces.ts'), 'utf8');
      expect(surfaceModule).toContain('entry: "src/ui/index.ts"');

      await expect(readFile(join(projectRoot, 'dist', 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(join(projectRoot, 'dist', 'ui', 'hosted-web', 'main-renderer'), { recursive: true });
      await writeFile(
        join(projectRoot, 'dist', 'ui', 'hosted-web', 'main-renderer', 'index.html'),
        '<!doctype html><html><body>fresh scaffold</body></html>',
        'utf8',
      );

      const { runPluginBuildUiCli } = await import(pathToFileURL(pluginUiBuilderPath).href) as PluginUiBuilder;
      const errors: string[] = [];
      const exitCode = await runPluginBuildUiCli({
        argv: ['--project-root', projectRoot],
        exec: {
          run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
        },
        resolveManagedBuildVersions: () => ({
          hostUiApiVersion: '1.0.0',
          viteVersion: '7.3.1',
          repackVersion: '5.2.5',
          reactVersion: '19.2.0',
          reactNativeVersion: '0.83.4',
        }),
        onError: (message) => { errors.push(message); },
      });

      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      await expect(readFile(join(projectRoot, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), 'utf8'))
        .resolves.toContain('main-renderer');
      await expect(readFile(join(projectRoot, 'dist', 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // This case runs the REAL `runPluginBuildUiCli` against a freshly scaffolded
    // project; importing the SDK builder alone costs tens of seconds, so the
    // 30s suite default cannot budget it.
  }, 180_000);

  it('declares standard UI targets without package-root bundler config or hosted HTML files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-managed-build-'));
    const hostedRoot = join(root, 'hosted');
    const nativeRoot = join(root, 'native');

    try {
      const hosted = await scaffoldLocalPlugin({
        targetDir: hostedRoot,
        pluginId: 'acme.managed-hosted',
        displayName: 'Managed hosted',
        ui: 'hostedWeb',
      });
      expect(hosted.ok).toBe(true);
      if (!hosted.ok) return;

      const hostedSource = await readFile(join(hostedRoot, 'src', 'ui', 'index.ts'), 'utf8');
      expect(hostedSource).toContain("document.createElement('main')");
      await expect(readFile(join(hostedRoot, 'index.html'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(hostedRoot, 'vite.config.mjs'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(hostedRoot, 'pluginUiBuild.ts'), 'utf8'))
        .resolves.not.toContain('bundlerConfig');

      const native = await scaffoldLocalPlugin({
        targetDir: nativeRoot,
        pluginId: 'acme.managed-native',
        displayName: 'Managed native',
        ui: 'reactNative',
      });
      expect(native.ok).toBe(true);
      if (!native.ok) return;

      for (const path of ['vite.config.mjs', 'rspack.config.mjs', 'react-native.config.cjs']) {
        await expect(readFile(join(nativeRoot, path), 'utf8'))
          .rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(readFile(join(nativeRoot, 'pluginUiBuild.ts'), 'utf8'))
        .resolves.not.toContain('bundlerConfig');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
