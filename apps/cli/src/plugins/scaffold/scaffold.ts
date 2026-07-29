import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  createPluginManifestJsonSchemaV2,
  isReservedHappierPluginId,
  PluginIdSchema,
} from '@happier-dev/protocol';
import { valid as isValidSemver } from 'semver';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export type PluginScaffoldDiagnostic = Readonly<{
  code: 'plugin_scaffold_invalid_input' | 'plugin_scaffold_target_exists' | 'plugin_scaffold_failed';
  message: string;
}>;

// React Native is the flagship/recommended plugin-UI scaffold mode and also
// targets web through React Native Web.
export type PluginScaffoldUiMode = 'hostedWeb' | 'reactNative';

export type ScaffoldLocalPluginResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      title: string;
      version: string;
      targetDir: string;
      manifestPath: string;
      manifestSchemaPath: string;
      packageJsonPath: string;
      sourceEntryPath: string;
      uiEntryPath?: string;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginScaffoldDiagnostic[];
    }>;

const DEFAULT_PLUGIN_VERSION = '0.1.0';
const DEFAULT_HAPPIER_ENGINE_RANGE = '^0.2.0';
const DEFAULT_PLUGIN_SDK_VERSION = '0.1.0';
const NATIVE_TYPESCRIPT_DEPENDENCY_SPEC = 'npm:typescript@7.0.2';
const DEFAULT_NODE_TYPES_VERSION = '^22.15.3';

// React Native (web-federation) UI scaffold version matrix. These are the
// versions the SDK's `defineReactNativeWebViteBuildPreset` + host runtime are
// validated against (mirrors `packages/plugins/inspector`'s own build target).
// Pinning `@vitejs/plugin-react@^5` + `vite@^7` avoids the ERESOLVE trap where
// `@vitejs/plugin-react@6` peer-requires `vite@8` while the SDK preset targets
// `vite@7`. Keep this table in sync with the docs version matrix
// (apps/docs/content/docs/plugins/ui/react-native.mdx).
const DEFAULT_REACT_VERSION = '19.2.0';
const DEFAULT_REACT_TYPES_VERSION = '19.2.0';
const DEFAULT_REACT_NATIVE_VERSION = '0.83.4';
const DEFAULT_REACT_NATIVE_WEB_RANGE = '^0.21.2';
const DEFAULT_VITE_RANGE = '^7.0.0';
const DEFAULT_VITE_REACT_PLUGIN_RANGE = '^5.0.0';
const DEFAULT_VITE_RECORDED_VERSION = '7.0.0';
const DEFAULT_HOST_UI_API_VERSION = '1.0.0';
const REACT_NATIVE_WEB_CONTRIBUTION_ID = 'main-native';
const REACT_NATIVE_WEB_SOURCE_ENTRY = 'ui/renderSurface.tsx';
const REACT_NATIVE_WEB_BUILD_WORK_ROOT =
  `dist/ui/react-native-web/${REACT_NATIVE_WEB_CONTRIBUTION_ID}`;

function createDiagnostic(
  code: PluginScaffoldDiagnostic['code'],
  message: string,
): PluginScaffoldDiagnostic {
  return { code, message };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isPathInsideRoot(rootDir: string, targetDir: string): boolean {
  const relativePath = relative(rootDir, targetDir);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function sanitizePackageName(pluginId: string): string {
  const suffix = pluginId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
  return `happier-plugin-${suffix || 'plugin'}`;
}

function resolvePluginSdkDependencySpec(value: string | undefined): string {
  const version = value?.trim() || DEFAULT_PLUGIN_SDK_VERSION;
  if (isValidSemver(version) !== version) {
    throw new Error('The plugin SDK dependency must be an exact semver version');
  }
  return version;
}

function createManifest(params: Readonly<{
  pluginId: string;
  displayName: string;
  ui?: PluginScaffoldUiMode;
}>): unknown {
  const contributes: Record<string, unknown> = {
    actions: [{
      id: 'save-note',
      title: 'Save note',
      description: 'Returns the supplied note from one minimal plugin action.',
      scopes: ['global'],
      surfaces: ['agent', 'cli', 'mcp'],
      placement: 'commandPalette',
      dangerLevel: 'safe',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { note: { type: 'string' } }, required: ['note'],
      },
      resultSchema: {
        type: 'object', additionalProperties: false,
        properties: { note: { type: 'string' } }, required: ['note'],
      },
    }],
  };

  if (params.ui === 'hostedWeb') {
    contributes.ui = {
      views: [{ id: 'main', placement: 'app.sidePanel', renderer: 'main-web', title: params.displayName }],
      renderers: [{ id: 'main-web', kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'main-web' }, requiredHostMethods: ['context'] }],
      translations: [],
    };
  }

  if (params.ui === 'reactNative') {
    contributes.ui = {
      views: [{ id: 'main', placement: 'app.sidePanel', renderer: 'main-native', title: params.displayName }],
      renderers: [{ id: 'main-native', kind: 'reactNative', artifact: REACT_NATIVE_WEB_CONTRIBUTION_ID, requiredHostMethods: ['context'] }],
      translations: [],
    };
  }

  return {
    schemaVersion: 2,
    id: params.pluginId,
    version: DEFAULT_PLUGIN_VERSION,
    displayName: params.displayName,
    description: `Local Happier plugin scaffold for ${params.displayName}.`,
    engines: {
      happier: DEFAULT_HAPPIER_ENGINE_RANGE,
    },
    runtime: {
      apiVersion: 1,
    },
    entrypoints: {
      daemon: './dist/index.js',
      development: './src/index.ts',
    },
    contributes,
  };
}

function createPackageJson(params: Readonly<{
  packageName: string;
  displayName: string;
  pluginSdkVersion: string;
  ui?: PluginScaffoldUiMode;
}>): unknown {
  const scripts: Record<string, string> = {
    build: 'happier plugins author build .',
    typecheck: 'happier plugins author typecheck .',
    test: 'happier plugins test .',
    'pack:plugin': 'happier plugins pack .',
  };
  const dependencies: Record<string, string> = {
    '@happier-dev/plugin-sdk': params.pluginSdkVersion,
  };
  const devDependencies: Record<string, string> = {
    '@types/node': DEFAULT_NODE_TYPES_VERSION,
    '@typescript/native': NATIVE_TYPESCRIPT_DEPENDENCY_SPEC,
  };

  if (params.ui === 'reactNative') {
    // The React Native surface renders on web through the SDK's
    // react-native-web Vite federation build; `build:ui` drives the
    // `happier-plugin-build-ui` bin (shipped by @happier-dev/plugin-sdk) that
    // reads `pluginUiBuild.mjs` + `vite.config.mjs` and emits the digested
    // `dist/happier-plugin-ui` artifact tree.
    scripts['build:ui'] = 'happier-plugin-build-ui --project-root .';
    dependencies.react = DEFAULT_REACT_VERSION;
    dependencies['react-dom'] = DEFAULT_REACT_VERSION;
    dependencies['react-native'] = DEFAULT_REACT_NATIVE_VERSION;
    dependencies['react-native-web'] = DEFAULT_REACT_NATIVE_WEB_RANGE;
    devDependencies.vite = DEFAULT_VITE_RANGE;
    devDependencies['@vitejs/plugin-react'] = DEFAULT_VITE_REACT_PLUGIN_RANGE;
    devDependencies['@types/react'] = DEFAULT_REACT_TYPES_VERSION;
  }

  return {
    name: params.packageName,
    version: DEFAULT_PLUGIN_VERSION,
    type: 'module',
    description: `${params.displayName} Happier plugin.`,
    happier: { manifest: '.happier-plugin/plugin.json' },
    keywords: ['happier-plugin'],
    files: ['.happier-plugin', 'dist'],
    scripts,
    dependencies,
    devDependencies,
  };
}

function createTypeScriptConfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM'],
      types: ['node'],
      rootDir: 'src',
      outDir: 'dist',
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      strict: true,
      skipLibCheck: true,
      jsx: 'react',
    },
    include: ['src/**/*.ts', 'src/**/*.tsx'],
    exclude: ['node_modules', 'dist', 'src/**/*.test.ts'],
  }, null, 2)}\n`;
}

function createPluginSource(params: Readonly<{
  pluginId: string;
}>): string {
  void params;
  return [
    "import type { PluginApi } from '@happier-dev/plugin-sdk';",
    "import type { ActionHandler } from '@happier-dev/plugin-sdk/runtime';",
    '',
    'export const saveNote: ActionHandler = async (input) => {',
    "  const note = typeof input === 'object' && input !== null && 'note' in input",
    "    && typeof input.note === 'string' ? input.note : '';",
    '  return { note };',
    '};',
    '',
    'export function activate(api: PluginApi): void {',
    "  api.actions.register('save-note', saveNote);",
    '}',
    '',
  ].join('\n');
}

function createPluginTestSource(): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { readFile } from 'node:fs/promises';",
    "import test from 'node:test';",
    '',
    "import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';",
    '',
    "const manifest = JSON.parse(await readFile(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'));",
    "const module = await import('../dist/index.js');",
    '',
    "test('save-note returns the supplied note', async (t) => {",
    '  const plugin = await createPluginTestkit({ manifest, module });',
    '  t.after(async () => plugin.dispose());',
    '',
    "  const result = await plugin.invokeAction('save-note', { note: 'hello' });",
    "  assert.deepEqual({ ...result }, { note: 'hello' });",
    '});',
    '',
  ].join('\n');
}

function createHostedWebSource(): string {
  return [
    'export const ui = Object.freeze({',
    "  title: 'Hosted web stub',",
    '});',
    '',
  ].join('\n');
}

function createReactNativeSurfaceSource(params: Readonly<{ displayName: string }>): string {
  return [
    '// React Native plugin UI surface. The host calls `renderSurface(context)`',
    "// and mounts the returned element inside the plugin's React Native surface",
    '// boundary. The SAME source compiles to native (Re.Pack) and to web',
    '// (Vite + react-native-web); `renderSurface` is the one bundle-contract',
    '// export both targets ship. Use the classic JSX runtime (`import * as',
    "// React`) so `react`/`react-native-web` resolve to the host's shared",
    '// singletons through the SDK host-runtime-externals Vite plugin.',
    "import * as React from 'react';",
    "import { Text, View } from 'react-native';",
    '',
    'export function renderSurface() {',
    '  return (',
    '    <View>',
    `      <Text>Hello from ${params.displayName}</Text>`,
    '    </View>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function createReactNativeViteConfigSource(): string {
  // Mirrors the canonical build target shape in
  // `packages/plugins/inspector/vite.config.ts`: the SDK preset owns the
  // react-native -> react-native-web alias, while this scaffold writes Vite's
  // intermediate bytes to the same default work root consumed by
  // `happier-plugin-build-ui`. The builder alone stages the verified final
  // graph under `dist/happier-plugin-ui`.
  // `createReactNativeWebVitePlugins()` intercepts the host-runtime
  // externals (react / react-native-web / hostApiClient) so the built bundle
  // never inlines them. `@vitejs/plugin-react` runs in CLASSIC mode so the JSX
  // transform routes through the externalized `react` specifier (the automatic
  // runtime's `react/jsx-runtime` import is NOT externalized and would inline
  // React, breaking host singleton sharing).
  return [
    "import react from '@vitejs/plugin-react';",
    "import { defineConfig } from 'vite';",
    'import {',
    '  createReactNativeWebVitePlugins,',
    '  defineReactNativeWebViteBuildPreset,',
    "} from '@happier-dev/plugin-sdk/ui/build';",
    '',
    'export default defineConfig(() => {',
    '  const preset = defineReactNativeWebViteBuildPreset({',
    `    contributionId: ${JSON.stringify(REACT_NATIVE_WEB_CONTRIBUTION_ID)},`,
    `    sourceEntry: ${JSON.stringify(REACT_NATIVE_WEB_SOURCE_ENTRY)},`,
    `    viteVersion: ${JSON.stringify(DEFAULT_VITE_RECORDED_VERSION)},`,
    `    hostUiApiVersion: ${JSON.stringify(DEFAULT_HOST_UI_API_VERSION)},`,
    `    compatibility: { reactVersion: ${JSON.stringify(DEFAULT_REACT_VERSION)}, reactNativeVersion: ${JSON.stringify(DEFAULT_REACT_NATIVE_VERSION)} },`,
    '  });',
    '',
    '  return {',
    "    plugins: [react({ jsxRuntime: 'classic' }), ...createReactNativeWebVitePlugins()],",
    '    resolve: {',
    '      alias: preset.vite.resolve.alias.map((entry) => ({ find: entry.find, replacement: entry.replacement })),',
    '    },',
    '    build: {',
    `      outDir: ${JSON.stringify(REACT_NATIVE_WEB_BUILD_WORK_ROOT)},`,
    '      minify: false,',
    '      sourcemap: false,',
    '      lib: {',
    "        entry: 'src/' + preset.sourceEntry,",
    "        formats: ['es'],",
    "        fileName: () => 'entry.mjs',",
    '      },',
    '    },',
    '  };',
    '});',
    '',
  ].join('\n');
}

function createReactNativeUiBuildConfigSource(): string {
  // Consumed by `happier-plugin-build-ui` (the SDK bin). Authors declare only
  // build targets; the bin owns managed-runtime bundler selection/execution.
  return [
    "import { definePluginUiBuildConfig } from '@happier-dev/plugin-sdk/ui/build';",
    '',
    'export const pluginUiBuildConfig = definePluginUiBuildConfig({',
    '  targets: [{',
    `    rendererId: ${JSON.stringify(REACT_NATIVE_WEB_CONTRIBUTION_ID)},`,
    `    entry: ${JSON.stringify(REACT_NATIVE_WEB_SOURCE_ENTRY)},`,
    "    kind: 'reactNative',",
    "    platforms: ['web'],",
    '  }],',
    '});',
    '',
    'export default pluginUiBuildConfig;',
    '',
  ].join('\n');
}

export async function scaffoldLocalPlugin(params: Readonly<{
  targetDir: string;
  baseDir?: string;
  pluginId: string;
  displayName: string;
  pluginSdkVersion?: string;
  ui?: PluginScaffoldUiMode;
}>): Promise<ScaffoldLocalPluginResult> {
  const rawTargetDir = params.targetDir.trim();
  const pluginId = params.pluginId.trim();
  const displayName = params.displayName.trim();
  const ui = params.ui;
  let pluginSdkVersion: string;
  try {
    pluginSdkVersion = resolvePluginSdkDependencySpec(params.pluginSdkVersion);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [createDiagnostic(
        'plugin_scaffold_invalid_input',
        error instanceof Error ? error.message : 'The plugin SDK dependency is invalid',
      )],
    };
  }

  if (!rawTargetDir) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'Plugin scaffold target directory is required')],
    };
  }
  if (!PluginIdSchema.safeParse(pluginId).success || isReservedHappierPluginId(pluginId)) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'Plugin id must use a lower-case dot-delimited owner namespace outside the reserved happier.* namespace')],
    };
  }
  if (!displayName) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'Plugin display name is required')],
    };
  }
  if (ui !== undefined && ui !== 'hostedWeb' && ui !== 'reactNative') {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'Only --ui hostedWeb or --ui reactNative is supported for plugin scaffolds')],
    };
  }

  const targetDir = resolve(expandHomeDirPath(rawTargetDir));
  const baseDir = typeof params.baseDir === 'string' && params.baseDir.trim().length > 0
    ? resolve(expandHomeDirPath(params.baseDir.trim()))
    : null;
  if (baseDir && !isPathInsideRoot(baseDir, targetDir)) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'Plugin scaffold target directory must be inside the workspace root')],
    };
  }
  if (await pathExists(targetDir)) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_target_exists', `Plugin scaffold target already exists: ${targetDir}`)],
    };
  }

  const manifestPath = join(targetDir, '.happier-plugin', 'plugin.json');
  const manifestSchemaPath = join(targetDir, '.happier-plugin', 'plugin.schema.json');
  const packageJsonPath = join(targetDir, 'package.json');
  const sourceEntryPath = join(targetDir, 'src', 'index.ts');
  const testEntryPath = join(targetDir, 'test', 'index.test.mjs');
  const tsconfigPath = join(targetDir, 'tsconfig.json');
  const uiEntryPath = ui === 'hostedWeb'
    ? join(targetDir, 'src', 'ui', 'index.ts')
    : ui === 'reactNative'
      ? join(targetDir, 'src', 'ui', 'renderSurface.tsx')
      : undefined;
  const viteConfigPath = join(targetDir, 'vite.config.mjs');
  const uiBuildConfigPath = join(targetDir, 'pluginUiBuild.mjs');

  try {
    await mkdir(join(targetDir, '.happier-plugin'), { recursive: true });
    await mkdir(join(targetDir, 'src'), { recursive: true });
    await mkdir(join(targetDir, 'test'), { recursive: true });
    if (uiEntryPath) {
      await mkdir(join(targetDir, 'src', 'ui'), { recursive: true });
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify(createManifest({ pluginId, displayName, ui }), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      manifestSchemaPath,
      `${JSON.stringify(createPluginManifestJsonSchemaV2(), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(createPackageJson({
        packageName: sanitizePackageName(pluginId),
        displayName,
        pluginSdkVersion,
        ui,
      }), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      sourceEntryPath,
      createPluginSource({ pluginId }),
      'utf8',
    );
    await writeFile(testEntryPath, createPluginTestSource(), 'utf8');
    await writeFile(tsconfigPath, createTypeScriptConfig(), 'utf8');
    if (uiEntryPath && ui === 'hostedWeb') {
      await writeFile(uiEntryPath, createHostedWebSource(), 'utf8');
    } else if (uiEntryPath && ui === 'reactNative') {
      await writeFile(uiEntryPath, createReactNativeSurfaceSource({ displayName }), 'utf8');
      await writeFile(viteConfigPath, createReactNativeViteConfigSource(), 'utf8');
      await writeFile(uiBuildConfigPath, createReactNativeUiBuildConfigSource(), 'utf8');
    }
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      diagnostics: [
        createDiagnostic(
          'plugin_scaffold_failed',
          error instanceof Error ? error.message : 'Plugin scaffold failed',
        ),
      ],
    };
  }

  return {
    ok: true,
    pluginId,
    title: displayName,
    version: DEFAULT_PLUGIN_VERSION,
    targetDir,
    manifestPath,
    manifestSchemaPath,
    packageJsonPath,
    sourceEntryPath,
    ...(uiEntryPath ? { uiEntryPath } : {}),
  };
}
