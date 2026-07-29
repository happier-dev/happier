import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ingestPluginManifestV2, PluginManifestV2Schema } from '@happier-dev/protocol';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as ts from 'typescript';
import { describe,
  expect,
  it } from 'vitest';

import { scaffoldLocalPlugin } from './scaffold';

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path,
  'utf8')) as T;
}

async function linkPublicSdk(targetDir: string): Promise<void> {
  const packageScope = join(targetDir,
  'node_modules',
  '@happier-dev');
  await mkdir(packageScope,
  { recursive: true });
  await symlink(
    fileURLToPath(new URL('../../../../../packages/plugin-sdk',
  import.meta.url)),
  join(packageScope,
  'plugin-sdk'),
  'dir',
  );
}

async function linkInstalledDependency(
  targetDir: string,
  packageName: string,
  source = fileURLToPath(new URL(`../../../../../node_modules/${packageName}`,
  import.meta.url)),
  ): Promise<void> {
  const destination = join(targetDir,
  'node_modules',
  ...packageName.split('/'));
  await mkdir(join(destination,
  '..'),
  { recursive: true });
  await symlink(
    source,
  destination,
  'dir',
  );
}

async function compileGeneratedPlugin(targetDir: string): Promise<readonly ts.Diagnostic[]> {
  await linkPublicSdk(targetDir);
  const config = ts.readConfigFile(join(targetDir,
  'tsconfig.json'),
  ts.sys.readFile);
  if (config.error) return [config.error];
  const parsed = ts.parseJsonConfigFileContent(config.config,
  ts.sys,
  targetDir);
  const program = ts.createProgram({ rootNames: parsed.fileNames,
  options: parsed.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) {
    program.emit();
  }
  return diagnostics;
}

describe('scaffoldLocalPlugin',
  () => {
  it('pins an ordinary candidate SDK semver and repository-owned TypeScript 7 author commands',
  async () => {
    const root = await mkdtemp(join(tmpdir(),
  'happier-plugin-scaffold-packed-author-'));
    const targetDir = join(root,
  'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
  pluginId: 'acme.packed-author',
  displayName: 'Acme Packed Author',
  pluginSdkVersion: '0.1.0-vertical-a.test-run',
  });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const packageJson = await readJsonFile<{
      scripts?: Record<string,
  string>;
      dependencies?: Record<string,
  string>;
      devDependencies?: Record<string,
  string>;
    }>(result.packageJsonPath);
    expect(packageJson.dependencies?.['@happier-dev/plugin-sdk']).toBe('0.1.0-vertical-a.test-run');
    expect(packageJson.dependencies?.['@happier-dev/plugin-sdk']).not.toMatch(/^(?:file:|workspace:|link:|portal:)/u);
    expect(packageJson.devDependencies).toMatchObject({
      '@types/node': '^22.15.3',
  '@typescript/native': 'npm:typescript@7.0.2',
  });
    expect(packageJson.devDependencies).not.toHaveProperty('typescript');
    expect(packageJson.scripts).toMatchObject({
      build: 'happier plugins author build .',
  typecheck: 'happier plugins author typecheck .',
  test: 'happier plugins test .',
  'pack:plugin': 'happier plugins pack .',
  });
    expect(Object.values(packageJson.scripts ?? {})).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/(^|\s)(?:tsc|npx|npm|pnpm|yarn|bunx)(?:\s|$)/u)]),
  );
  });

  it('writes the final TypeScript dev-loop plugin template',
  async () => {
    const root = await mkdtemp(join(tmpdir(),
  'happier-plugin-scaffold-'));
    const targetDir = join(root,
  'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
  pluginId: 'acme.template',
  displayName: 'Acme Template',
  pluginSdkVersion: '0.1.0-vertical-a.unit-template',
  });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = await readJsonFile<Record<string,
  unknown>>(result.manifestPath);
    const manifestSchema = await readJsonFile<Record<string,
  unknown>>(result.manifestSchemaPath);
    expect(result.manifestSchemaPath).toBe(join(targetDir,
  '.happier-plugin',
  'plugin.schema.json'));
    expect(manifestSchema).toMatchObject({
      $id: 'https://happier.dev/schemas/plugin-manifest-v2.json',
  title: 'Happier Plugin Manifest v2',
  additionalProperties: false,
  });
    expect(() => PluginManifestV2Schema.parse(manifest)).not.toThrow();
    expect(manifest).toEqual(expect.objectContaining({
      id: 'acme.template',
  displayName: 'Acme Template',
  entrypoints: { daemon: './dist/index.js',
  development: './src/index.ts' },
  contributes: {
        actions: [expect.objectContaining({ id: 'save-note' })],
  },
  }));
    expect(manifest).not.toHaveProperty('activation');
    const ingestion = ingestPluginManifestV2(manifest);
    expect(ingestion).toMatchObject({ ok: true });

    const source = await readFile(result.sourceEntryPath,
  'utf8');
    expect(result.sourceEntryPath).toBe(join(targetDir,
  'src',
  'index.ts'));
    expect(source).toContain("import type { PluginApi } from '@happier-dev/plugin-sdk';");
    expect(source).toContain("import type { ActionHandler } from '@happier-dev/plugin-sdk/runtime';");
    expect(source).toContain('export function activate(api: PluginApi): void');
    expect(source).not.toContain('PluginActivationApi');
    expect(source).toContain("api.actions.register('save-note'");
    expect(source).toContain('return { note };');
    const testSource = await readFile(join(targetDir, 'test', 'index.test.mjs'), 'utf8');
    expect(testSource).toContain("from '@happier-dev/plugin-sdk/testing'");
    expect(testSource).toContain("test('save-note returns the supplied note'");
    expect(testSource).toContain("invokeAction('save-note', { note: 'hello' })");
    const packageJson = await readJsonFile<Record<string, unknown>>(result.packageJsonPath);
    expect(packageJson).not.toHaveProperty('private');
    expect(packageJson).toMatchObject({
      happier: { manifest: '.happier-plugin/plugin.json' },
      keywords: ['happier-plugin'],
      files: ['.happier-plugin', 'dist'],
      dependencies: {
        '@happier-dev/plugin-sdk': '0.1.0-vertical-a.unit-template',
      },
    });
  });

  it('emits only the contribution-derived nested activation ABI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-activate-'));
    const targetDir = join(root, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const source = await readFile(result.sourceEntryPath, 'utf8');
    expect(source).not.toMatch(/\b(?:PluginActivationApi|PluginContext|registerTool|registerCommand|registerAction|registerHook|registerAgentRuntime|onDispose)\b/u);
    expect(source.match(/api\.actions\.register\(/gu)).toHaveLength(1);
    expect(source.match(/api\.hooks\.register\(/gu) ?? []).toHaveLength(0);
    expect(source.match(/api\.lifecycle\.onWillDeactivate\(/gu) ?? []).toHaveLength(0);

    await expect(readFile(join(targetDir, 'dist', 'index.js'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await compileGeneratedPlugin(targetDir)).toEqual([]);
    const generatedSuite = spawnSync(
      process.execPath,
      ['--test', 'test/index.test.mjs'],
      { cwd: targetDir, encoding: 'utf8' },
    );
    expect(
      generatedSuite.status,
      `${generatedSuite.stdout}\n${generatedSuite.stderr}`,
    ).toBe(0);

    const compiledModule = await import(pathToFileURL(join(targetDir, 'dist', 'index.js')).href) as {
      activate(api: PluginApi): void;
    };
    const testkit = await createPluginTestkit({
      manifest: PluginManifestV2Schema.parse(await readJsonFile(result.manifestPath)),
      module: compiledModule,
    });
    expect(testkit.registrations()).toEqual([
      { family: 'actions', localId: 'save-note' },
    ]);
    await expect(testkit.invokeAction('save-note', { note: 'hello' })).resolves.toEqual({ note: 'hello' });
    await expect(testkit.dispose()).resolves.toBeUndefined();
    await expect(testkit.dispose()).resolves.toBeUndefined();
  });

  it('typechecks the generated daemon outside the monorepo through public package exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-compile-'));
    const targetDir = join(root, 'template-plugin');
    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await writeFile(join(targetDir, 'src', 'index.ts'), [
      "import { randomUUID } from 'node:crypto';",
      "import type { PluginApi } from '@happier-dev/plugin-sdk';",
      'export const marker = process.env.HAPPIER_TEST_MARKER ?? randomUUID();',
      'export function activate(_api: PluginApi): void {}',
      '',
    ].join('\n'), 'utf8');
    await linkPublicSdk(targetDir);
    await linkInstalledDependency(targetDir, '@types/node');
    const config = ts.readConfigFile(join(targetDir, 'tsconfig.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    expect(config.config.compilerOptions?.types).toContain('node');
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, targetDir);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('can include a hostedWeb authoring stub', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-ui-'));
    const targetDir = join(root, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
      ui: 'hostedWeb',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = await readJsonFile<Record<string, unknown>>(result.manifestPath);
    expect(() => PluginManifestV2Schema.parse(manifest)).not.toThrow();
    expect(manifest).toMatchObject({
      contributes: {
        ui: {
          views: [expect.objectContaining({ id: 'main', renderer: 'main-web' })],
          renderers: [expect.objectContaining({
            id: 'main-web',
            kind: 'hostedWeb',
            source: { kind: 'artifact', artifact: 'main-web' },
          })],
        },
      },
    });

    const uiSource = await readFile(join(targetDir, 'src', 'ui', 'index.ts'), 'utf8');
    expect(uiSource).toContain('export const ui');
  });

  it('can include a reactNative authoring stub (F-UI G3)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-rn-'));
    const targetDir = join(root, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
      ui: 'reactNative',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = await readJsonFile<Record<string, unknown>>(result.manifestPath);
    expect(() => PluginManifestV2Schema.parse(manifest)).not.toThrow();
    expect(manifest).toMatchObject({
      contributes: {
        ui: {
          views: [expect.objectContaining({ id: 'main', renderer: 'main-native' })],
          renderers: [expect.objectContaining({
            id: 'main-native',
            kind: 'reactNative',
            artifact: 'main-native',
          })],
        },
      },
    });

    expect(result.uiEntryPath).toBe(join(targetDir, 'src', 'ui', 'renderSurface.tsx'));
    const uiSource = await readFile(result.uiEntryPath as string, 'utf8');
    expect(uiSource).toContain('export function renderSurface');
    await linkInstalledDependency(
      targetDir,
      'react',
      fileURLToPath(new URL('../../../../../packages/plugins/inspector/node_modules/react', import.meta.url)),
    );
    await linkInstalledDependency(
      targetDir,
      'react-native',
      fileURLToPath(new URL('../../../../../packages/plugins/inspector/node_modules/react-native', import.meta.url)),
    );
    await linkInstalledDependency(
      targetDir,
      '@types/react',
      fileURLToPath(new URL('../../../../../packages/plugins/inspector/node_modules/@types/react', import.meta.url)),
    );
    await linkInstalledDependency(targetDir, 'vite');
    await linkInstalledDependency(targetDir, '@vitejs/plugin-react');
    expect(await compileGeneratedPlugin(targetDir)).toEqual([]);

    const packageJson = await readJsonFile<Record<string, unknown>>(join(targetDir, 'package.json'));
    expect(packageJson).toMatchObject({
      scripts: {
        'build:ui': 'happier-plugin-build-ui --project-root .',
      },
      dependencies: {
        react: '19.2.0',
        'react-dom': '19.2.0',
        'react-native': '0.83.4',
        'react-native-web': '^0.21.2',
      },
      devDependencies: {
        vite: '^7.0.0',
        '@vitejs/plugin-react': '^5.0.0',
        '@types/react': '19.2.0',
      },
    });
    const viteConfig = await readFile(join(targetDir, 'vite.config.mjs'), 'utf8');
    expect(viteConfig).toContain('@happier-dev/plugin-sdk/ui/build');
    expect(viteConfig).toContain('createReactNativeWebVitePlugins');
    const viteConfigModule = await import(pathToFileURL(join(targetDir, 'vite.config.mjs')).href);
    const resolvedViteConfig = await viteConfigModule.default({
      command: 'build',
      mode: 'production',
      isSsrBuild: false,
      isPreview: false,
    });
    expect(resolvedViteConfig.build?.outDir).toBe('dist/ui/react-native-web/main-native');
    const uiBuildConfig = await readFile(join(targetDir, 'pluginUiBuild.mjs'), 'utf8');
    expect(uiBuildConfig).toContain('definePluginUiBuildConfig');
    expect(uiBuildConfig).not.toContain('createManagedRuntimeBundlerRunner');
    const tsconfig = await readJsonFile<{ compilerOptions?: { jsx?: string }; include?: string[] }>(join(targetDir, 'tsconfig.json'));
    expect(tsconfig.compilerOptions?.jsx).toBe('react');
    expect(tsconfig.include).toContain('src/**/*.tsx');
  });

  it('loads the generated React Native build config through public SDK exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-rn-config-'));
    const targetDir = join(root, 'template-plugin');
    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
      ui: 'reactNative',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await linkPublicSdk(targetDir);
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', "import('./pluginUiBuild.mjs').then((mod) => { if (!mod.default || !Array.isArray(mod.default.targets)) process.exit(2); })"],
      { cwd: targetDir, encoding: 'utf8' },
    );
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
  });

  it('keeps every shipped UI mode on the same strict daemon declaration', async () => {
    for (const ui of ['hostedWeb', 'reactNative'] as const) {
      const root = await mkdtemp(join(tmpdir(), `happier-plugin-scaffold-activate-${ui}-`));
      const targetDir = join(root, 'template-plugin');

      const result = await scaffoldLocalPlugin({
        targetDir,
        pluginId: 'acme.template',
        displayName: 'Acme Template',
        ui,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const manifest = await readJsonFile<Record<string, unknown>>(result.manifestPath);
      expect(ingestPluginManifestV2(manifest)).toMatchObject({ ok: true });
      expect(manifest).toMatchObject({
        entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
      });
      expect(manifest).not.toHaveProperty('activation');
    }
  });

  it('rejects scaffold targets outside the provided base directory', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-workspace-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-outside-'));
    const targetDir = join(outsideRoot, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
      baseDir: workspaceRoot,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'plugin_scaffold_invalid_input',
          message: expect.stringMatching(/inside the workspace/i),
        },
      ],
    });
    await expect(readFile(join(targetDir, 'package.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
