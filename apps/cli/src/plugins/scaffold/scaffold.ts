import { readFileSync } from 'node:fs';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isReservedHappierPluginId, PluginIdSchema } from '@happier-dev/protocol';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export type PluginScaffoldDiagnostic = Readonly<{
  code: 'plugin_scaffold_invalid_input' | 'plugin_scaffold_target_exists' | 'plugin_scaffold_failed';
  message: string;
}>;

// DEC-6: reactNative is the flagship/recommended plugin-UI scaffold mode (also
// targets web via RN-web federation eventually — a separate spike lane owns that
// design). embeddedWeb is intentionally NOT scaffoldable: its disposition is
// undecided (likely retired — redundant with RN-on-web + hostedWeb-on-native),
// pending another lane's analysis. Do not add an embeddedWeb branch here until
// that disposition lands.
export type PluginScaffoldUiMode = 'hostedWeb' | 'reactNative';

export type ScaffoldLocalPluginResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      title: string;
      version: string;
      targetDir: string;
      manifestPath: string;
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
const DEFAULT_PLUGIN_SDK_RANGE = '^0.2.0';
const LOCAL_PLUGIN_SDK_PACKAGE_DIR = fileURLToPath(new URL('../../../../../packages/plugin-sdk/', import.meta.url));

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

function resolveDefaultPluginSdkDependencySpec(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(LOCAL_PLUGIN_SDK_PACKAGE_DIR, 'package.json'), 'utf8'),
    ) as { name?: unknown };
    if (packageJson.name === '@happier-dev/plugin-sdk') {
      return `file:${LOCAL_PLUGIN_SDK_PACKAGE_DIR}`;
    }
  } catch {
    // Packaged public releases may not run from a monorepo checkout; those can
    // use the semver package once publication is approved.
  }
  return DEFAULT_PLUGIN_SDK_RANGE;
}

function createManifest(params: Readonly<{
  pluginId: string;
  displayName: string;
  ui?: PluginScaffoldUiMode;
}>): unknown {
  const actionId = `${params.pluginId}.hello`;
  const toolId = `${params.pluginId}.notes.add`;
  const settingFieldId = `${params.pluginId}.enabled`;
  const contributes: Record<string, unknown> = {
    actions: [
      {
        id: actionId,
        title: 'Say hello',
        description: 'Returns a small structured response from this plugin.',
        scopes: ['global'],
        surfaces: ['agent', 'cli', 'mcp'],
        placement: 'commandPalette',
        dangerLevel: 'safe',
        handler: { target: 'plugin', registrationId: actionId },
      },
    ],
    tools: [
      {
        id: toolId,
        name: `${params.pluginId.replaceAll('.', '_').replaceAll('-', '_')}_notes_add`,
        title: 'Add note',
        description: 'Stores a note in plugin-local storage and returns it.',
        surfaces: ['agent', 'mcp'],
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            note: { type: 'string' },
          },
          required: ['note'],
        },
        handler: { target: 'plugin', registrationId: toolId },
      },
    ],
    hooks: [
      {
        id: 'session.spawned',
        category: 'lifecycle',
        scope: 'session',
        executionKind: 'observe',
        handler: { target: 'plugin', exportName: 'handleSessionSpawned' },
      },
    ],
    settings: [
      {
        id: `${params.pluginId}.settings`,
        fields: [
          {
            id: settingFieldId,
            kind: 'settings.field',
            version: '1',
            valueSchema: { type: 'boolean' },
            control: 'switch',
            displayKey: 'Enabled',
            descriptionKey: 'Controls whether template actions include the enabled flag.',
            defaultBooleanValue: true,
          },
        ],
      },
    ],
    agents: [
      {
        id: params.pluginId,
        runtime: { kind: 'custom' },
        capabilities: {
          executionRun: { supported: false },
          session: {
            media: {
              acceptsImageInput: { supported: false },
              emitsSessionMedia: { supported: false },
              nativeImageGeneration: { supported: false },
            },
          },
        },
        surfaceHandlers: [],
      },
    ],
  };

  if (params.ui === 'hostedWeb') {
    contributes.hostedWeb = [
      {
        id: 'main-web',
        service: { kind: 'staticAssets', assetRootId: 'hosted-web/main-web' },
        entry: { routeMode: 'hostOrigin', path: '/' },
        bridge: { allowedMessages: ['ready'] },
        sandbox: {
          scripts: true,
          sameOrigin: false,
          popups: false,
          topNavigation: false,
          mixedContent: false,
        },
        security: {
          allowedNavigationOrigins: [],
          allowedCallbackOrigins: [],
          allowedConnectOrigins: [],
          csp: {
            scriptSrc: 'selfOnly',
            styleSrc: 'selfOnly',
            imgSrc: 'selfOnly',
            fontSrc: 'selfOnly',
            connectSrc: 'selfOnly',
            allowDataUrls: false,
            allowBlobUrls: false,
            allowInlineStyles: false,
            allowEval: false,
          },
          sourceMaps: 'disabled',
          mixedContent: 'deny',
        },
        fallback: { kind: 'unavailable' },
        display: {
          titleKey: `${params.pluginId}.mainWeb.title`,
          descriptionKey: `${params.pluginId}.mainWeb.description`,
          developerFallback: `${params.displayName} Web`,
          iconToken: 'preview',
          tone: 'info',
        },
      },
    ];
  }

  if (params.ui === 'reactNative') {
    // Scaffolded as a local development hot-reload declaration (no built artifact
    // yet — `bundle.channel: 'development'` + `policy.allowDevHotReload: true`,
    // the same carve-out `defineReactNativeRepackBuildPreset` authors reach for).
    // Swap in `assetPath`/`integrity` (via `defineReactNativeBundleBuildArtifact`)
    // once you have a real Re.Pack build to ship.
    contributes.reactNativeBundles = [
      {
        id: 'main-native',
        bundle: { platform: 'ios', channel: 'development' },
        entry: { modulePath: './renderSurface', exportName: 'renderSurface' },
        compatibility: {
          hostUiApiVersion: '1.0.0',
          reactVersion: '19.0.0',
          reactNativeVersion: '0.79.0',
          supportedPlatforms: ['ios'],
          supportedChannels: ['development'],
        },
        hostApi: { minVersion: '1.0.0' },
        fallback: { kind: 'unavailable' },
        display: {
          titleKey: `${params.pluginId}.mainNative.title`,
          descriptionKey: `${params.pluginId}.mainNative.description`,
          developerFallback: `${params.displayName} Native`,
          iconToken: 'preview',
          tone: 'info',
        },
        policy: { allowDevHotReload: true },
      },
    ];
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
    uses: ['actions', 'tools', 'hooks', 'settings', 'agents'],
    entrypoints: {
      main: './dist/index.js',
      dev: './src/index.ts',
    },
    permissions: {
      required: [],
      optional: [],
    },
    activationEvents: ['startup'],
    contributes,
  };
}

function createPackageJson(params: Readonly<{
  packageName: string;
  displayName: string;
}>): unknown {
  return {
    name: params.packageName,
    version: DEFAULT_PLUGIN_VERSION,
    private: true,
    type: 'module',
    description: `${params.displayName} Happier plugin.`,
    scripts: {
      build: 'tsc -p tsconfig.json',
      typecheck: 'tsc --noEmit -p tsconfig.json',
      'pack:plugin': 'happier plugins pack .',
    },
    dependencies: {
      '@happier-dev/plugin-sdk': resolveDefaultPluginSdkDependencySpec(),
    },
    devDependencies: {
      typescript: '^5.9.2',
    },
  };
}

function createTypeScriptConfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM'],
      rootDir: 'src',
      outDir: 'dist',
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      strict: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
    exclude: ['node_modules', 'dist', 'src/**/*.test.ts'],
  }, null, 2)}\n`;
}

function createPluginSource(params: Readonly<{
  pluginId: string;
}>): string {
  const actionId = `${params.pluginId}.hello`;
  const toolId = `${params.pluginId}.notes.add`;
  return [
    "import type { AgentRuntime, PluginApi, PluginContext } from '@happier-dev/plugin-sdk';",
    '',
    `const ACTION_ID = ${JSON.stringify(actionId)};`,
    `const TOOL_ID = ${JSON.stringify(toolId)};`,
    '',
    'export function activate(host: PluginApi): void {',
    '  // Bind the handler for the manifest-declared action id. Metadata such as',
    '  // title, surfaces, placement, and dangerLevel stays in .happier-plugin/plugin.json.',
    '  host.registerAction({',
    '    id: ACTION_ID,',
    '    handler: async () => ({',
    '      ok: true,',
    "      data: { message: 'hello from scaffolded plugin' },",
    '    }),',
    '  });',
    '',
    '  // Tool handlers receive request.context with plugin-scoped storage, settings,',
    '  // logger, and events. Use it for plugin-owned state instead of host internals.',
    '  host.registerTool({',
    '    id: TOOL_ID,',
    '    handler: async (request) => {',
    '      const services = request.context;',
    "      const note = String((request.input as { note?: unknown }).note ?? '');",
    "      await services.storage.local.set('latestNote', note);",
    '      return {',
    '        ok: true,',
    "        data: { note: await services.storage.local.get<string>('latestNote') },",
    '      };',
    '    },',
    '  });',
    '',
    '  // The manifest declares which hook id calls this handler; registration binds',
    '  // the exported implementation to the runtime.',
    '  host.registerHook({',
    "    hookId: 'session.spawned',",
    '    handler: handleSessionSpawned,',
    '  });',
    '',
    '  // Agent runtimes receive PluginContext so they can use host services',
    '  // without importing Happier internals.',
    '  host.registerAgentRuntime({',
    `    agentId: ${JSON.stringify(params.pluginId)},`,
    '    create: createTemplateRuntime,',
    '  });',
    '',
    '  // Dispose handlers run on reload and shutdown; clean up timers, watchers,',
    '  // sockets, or other resources here.',
    '  host.onDispose(() => undefined);',
    '}',
    '',
    'export async function handleSessionSpawned(_payload: unknown, context: { logger: PluginContext["logger"] }): Promise<void> {',
    "  context.logger.debug('scaffolded plugin observed session spawn');",
    '}',
    '',
    'async function createTemplateRuntime(ctx: PluginContext): Promise<AgentRuntime> {',
    '  // Use scoped plugin storage for durable local state instead of writing',
    '  // arbitrary files from the runtime.',
    "  const current = await ctx.storage.local.get<number>('templateRuntimeCreates');",
    "  await ctx.storage.local.set('templateRuntimeCreates', (current ?? 0) + 1);",
    '  return {};',
    '}',
    '',
  ].join('\n');
}

function createCompiledPluginSource(params: Readonly<{
  pluginId: string;
}>): string {
  const actionId = `${params.pluginId}.hello`;
  const toolId = `${params.pluginId}.notes.add`;
  return [
    `const ACTION_ID = ${JSON.stringify(actionId)};`,
    `const TOOL_ID = ${JSON.stringify(toolId)};`,
    '',
    'export function activate(host) {',
    '  host.registerAction({',
    '    id: ACTION_ID,',
    '    handler: async () => ({',
    '      ok: true,',
    "      data: { message: 'hello from scaffolded plugin' },",
    '    }),',
    '  });',
    '',
    '  host.registerTool({',
    '    id: TOOL_ID,',
    '    handler: async (request) => {',
    '      const services = request.context;',
    "      const note = String(request.input?.note ?? '');",
    "      await services.storage.local.set('latestNote', note);",
    '      return {',
    '        ok: true,',
    "        data: { note: await services.storage.local.get('latestNote') },",
    '      };',
    '    },',
    '  });',
    '',
    '  host.registerHook({',
    "    hookId: 'session.spawned',",
    '    handler: handleSessionSpawned,',
    '  });',
    '',
    '  host.registerAgentRuntime({',
    `    agentId: ${JSON.stringify(params.pluginId)},`,
    '    create: createTemplateRuntime,',
    '  });',
    '',
    '  host.onDispose(() => undefined);',
    '}',
    '',
    'export async function handleSessionSpawned(_payload, context) {',
    "  context.logger.debug('scaffolded plugin observed session spawn');",
    '}',
    '',
    'async function createTemplateRuntime(ctx) {',
    "  const current = await ctx.storage.local.get('templateRuntimeCreates');",
    "  await ctx.storage.local.set('templateRuntimeCreates', (current ?? 0) + 1);",
    '  return {};',
    '}',
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

function createReactNativeSurfaceSource(): string {
  return [
    '// React Native plugin UI stub. The host calls `renderSurface(context)` and',
    "// mounts the returned element inside the plugin's React Native surface",
    '// boundary. Add `react`/`react-native` as dependencies once you replace this',
    '// with a real component.',
    'export function renderSurface() {',
    '  return null;',
    '}',
    '',
  ].join('\n');
}

export async function scaffoldLocalPlugin(params: Readonly<{
  targetDir: string;
  baseDir?: string;
  pluginId: string;
  displayName: string;
  ui?: PluginScaffoldUiMode;
}>): Promise<ScaffoldLocalPluginResult> {
  const rawTargetDir = params.targetDir.trim();
  const pluginId = params.pluginId.trim();
  const displayName = params.displayName.trim();
  const ui = params.ui;

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
  const packageJsonPath = join(targetDir, 'package.json');
  const sourceEntryPath = join(targetDir, 'src', 'index.ts');
  const compiledEntryPath = join(targetDir, 'dist', 'index.js');
  const tsconfigPath = join(targetDir, 'tsconfig.json');
  const uiEntryPath = ui === 'hostedWeb'
    ? join(targetDir, 'src', 'ui', 'index.ts')
    : ui === 'reactNative'
      ? join(targetDir, 'src', 'ui', 'renderSurface.ts')
      : undefined;

  try {
    await mkdir(join(targetDir, '.happier-plugin'), { recursive: true });
    await mkdir(join(targetDir, 'src'), { recursive: true });
    await mkdir(join(targetDir, 'dist'), { recursive: true });
    if (uiEntryPath) {
      await mkdir(join(targetDir, 'src', 'ui'), { recursive: true });
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify(createManifest({ pluginId, displayName, ui }), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(createPackageJson({ packageName: sanitizePackageName(pluginId), displayName }), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      sourceEntryPath,
      createPluginSource({ pluginId }),
      'utf8',
    );
    await writeFile(
      compiledEntryPath,
      createCompiledPluginSource({ pluginId }),
      'utf8',
    );
    await writeFile(tsconfigPath, createTypeScriptConfig(), 'utf8');
    if (uiEntryPath && ui === 'hostedWeb') {
      await writeFile(uiEntryPath, createHostedWebSource(), 'utf8');
    } else if (uiEntryPath && ui === 'reactNative') {
      await writeFile(uiEntryPath, createReactNativeSurfaceSource(), 'utf8');
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
    packageJsonPath,
    sourceEntryPath,
    ...(uiEntryPath ? { uiEntryPath } : {}),
  };
}
