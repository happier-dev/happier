import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  PluginIdSchema,
  PluginScaffoldUiModeSchema,
  type PluginScaffoldUiMode,
} from '@happier-dev/protocol';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';

import {
  expandHomeDirPath,
  isCanonicalAbsolutePathInsideRoot,
} from '@/utils/path/expandHomeDirPath';

export type PluginScaffoldDiagnostic = Readonly<{
  code: 'plugin_scaffold_invalid_input' | 'plugin_scaffold_target_exists' | 'plugin_scaffold_failed';
  message: string;
}>;

// React Native is the flagship/recommended plugin-UI scaffold mode and also
// targets web through React Native Web. The vocabulary itself is owned by
// `PluginScaffoldUiModeSchema` so the CLI flag and the `plugins.scaffold`
// action input cannot diverge.
export type { PluginScaffoldUiMode };

export type ScaffoldLocalPluginResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      title: string;
      version: string;
      targetDir: string;
      packageJsonPath: string;
      sourceEntryPath: string;
      uiEntryPath?: string;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginScaffoldDiagnostic[];
    }>;

const DEFAULT_PLUGIN_VERSION = '0.1.0';
const PUBLIC_PLUGIN_SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const PLUGIN_AUTHORING_SKILL_DIRECTORY = ['.agents', 'skills', 'happier-plugin-authoring'] as const;
const MAIN_SURFACE_ID = 'main';
/** `uiSurfaceRendererId(MAIN_SURFACE_ID)`; the generated test pins the equality. */
const REACT_NATIVE_WEB_CONTRIBUTION_ID = 'main-renderer';
const MAIN_SURFACE_MODULE_RELATIVE_PATH = 'src/ui/surfaces.ts';
const REACT_NATIVE_WEB_SOURCE_ENTRY = 'src/ui/renderSurface.tsx';
const REACT_NATIVE_REPACK_MODULE_PATH = './renderSurface';
const REACT_NATIVE_REPACK_EXPORT_NAME = 'renderSurface';
// Hosted web declares only its source entry. `happier-plugin-build-ui` owns the
// operation-local Vite config and HTML entry for the declared target.
const HOSTED_WEB_SOURCE_ENTRY = 'src/ui/index.ts';

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

function sanitizePackageName(pluginId: string): string {
  const suffix = pluginId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
  return `happier-plugin-${suffix || 'plugin'}`;
}

function createPackageJson(params: Readonly<{
  packageName: string;
  displayName: string;
  ui?: PluginScaffoldUiMode;
}>): unknown {
  const scripts: Record<string, string> = {
    build: 'happier plugins author build .',
    typecheck: 'happier plugins author typecheck .',
    test: 'happier plugins test .',
    'pack:plugin': 'happier plugins pack .',
  };
  const dependencies: Record<string, string> = {
    '@happier-dev/plugin-sdk': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk'],
  };
  const devDependencies: Record<string, string> = {
    '@types/node': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/node'],
    '@typescript/native': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@typescript/native'],
  };

  if (params.ui === 'hostedWeb') {
    // Hosted web is an isolated plugin-owned web application; `build:ui` drives
    // the same `happier-plugin-build-ui` bin the react-native arm uses. React is
    // a declared build dependency because the managed hosted-web bundler records
    // the installed React version as artifact compatibility provenance, not
    // because the template imports it.
    scripts['build:ui'] = 'happier-plugin-build-ui --project-root .';
    devDependencies.typescript = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.typescript;
    devDependencies.vite = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.vite;
    devDependencies.react = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies.react;
  }

  if (params.ui === 'reactNative') {
    // The React Native surface renders on web through the SDK-managed
    // react-native-web build. `build:ui` reads only `pluginUiBuild.ts`; the
    // SDK derives operation-local Vite and Re.Pack configs before emitting the
    // digested `dist/happier-plugin-ui` artifact tree.
    scripts['build:ui'] = 'happier-plugin-build-ui --project-root .';
    dependencies['@happier-dev/plugin-ui'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-ui'];
    dependencies.react = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies.react;
    dependencies['react-dom'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-dom'];
    dependencies['react-native'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-native'];
    dependencies['react-native-web'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-native-web'];
    devDependencies.typescript = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.typescript;
    devDependencies.vite = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.vite;
    devDependencies['@vitejs/plugin-react'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@vitejs/plugin-react'];
    devDependencies['@types/react'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/react'];
    devDependencies['@callstack/repack'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@callstack/repack'];
    devDependencies['@react-native-community/cli'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@react-native-community/cli'];
    devDependencies['@rspack/core'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@rspack/core'];
    devDependencies['@swc/helpers'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@swc/helpers'];
  }

  return {
    name: params.packageName,
    version: DEFAULT_PLUGIN_VERSION,
    type: 'module',
    description: `${params.displayName} Happier plugin.`,
    happier: { manifest: '.happier-plugin/plugin.json' },
    keywords: ['happier-plugin'],
    // Code-defined plugins have no checked-in `.happier-plugin/plugin.json`:
    // `happier plugins pack` projects it from `definePlugin(...)` and adds it to
    // the staged package inventory itself. The generated authoring skill is a
    // real source artifact, so preserve that exact path (not unrelated author
    // files) in packed scaffolds through the same deliberate file inventory.
    // Selecting a path that never exists in the source tree makes every pack fail.
    files: ['.agents/skills/happier-plugin-authoring', 'dist'],
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
      // `happier plugins author build` bundles this project into
      // `entrypoints.daemon` inside `outDir`, so a compiler emit here would
      // replace that self-contained bundle with a re-export module — which
      // still resolves in the author's checkout and fails once the plugin is
      // packed. The compiler's job in a plugin package is type checking only;
      // the bundler is the single producer of built output.
      noEmit: true,
      // A plugin package is loaded by the host through its manifest and
      // runtime entrypoints, not consumed as a typed library. Emitting
      // declarations would additionally force the author to annotate every
      // `definePlugin(...)` result, because the inferred manifest type names
      // types the SDK owns transitively.
      declaration: false,
      sourceMap: true,
      strict: true,
      skipLibCheck: true,
      jsx: 'react',
    },
    include: ['src/**/*.ts', 'src/**/*.tsx'],
    exclude: ['node_modules', 'dist', 'src/**/*.test.ts'],
  }, null, 2)}\n`;
}

/**
 * This is deliberately a small workflow guide, not a second API reference.
 * The installed SDK's generated API inventory remains the sole enumerator of
 * public entrypoints and symbols, while the compatibility packet supplies the
 * exact SDK version a fresh workspace receives.
 */
function createPluginAuthoringSkillSource(): string {
  const sdkVersion = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies[PUBLIC_PLUGIN_SDK_PACKAGE_NAME];
  return [
    '---',
    'name: happier-plugin-authoring',
    'description: Create, edit, diagnose, test, package, and install a Happier plugin through public authoring contracts.',
    '---',
    '',
    '# Happier plugin authoring',
    '',
    `This workspace uses \`${PUBLIC_PLUGIN_SDK_PACKAGE_NAME}@${sdkVersion}\`, derived from the public toolchain compatibility packet.`,
    '',
    '## Public API source of truth',
    '',
    `Before choosing an SDK import, read \`node_modules/${PUBLIC_PLUGIN_SDK_PACKAGE_NAME}/API.md\`. That generated inventory is the current public API contract; do not guess names or copy a versioned export list into this skill.`,
    `Before adopting a contribution or service family, read \`node_modules/${PUBLIC_PLUGIN_SDK_PACKAGE_NAME}/capability-matrix.json\`. It is the sole availability authority: a \`deferred\` row is conformance-only reference material, not a supported product lifecycle.`,
    'Use only the package entrypoints documented there. Do not reach into host source, private aliases, or another installed plugin artifact.',
    '',
    '## Cross-plugin integrations',
    '',
    'For a maintained feature-owned integration, follow the [cross-plugin contribution guide](/plugins/guides/cross-plugin-contributions). This beginner scaffold does not declare a feature integration.',
    '',
    '## Normal author loop',
    '',
    'Work in a normal Happier Agent Session rooted at this source directory. Use the same public lifecycle as a human author:',
    '',
    '1. Start or continue live development with `happier plugins dev`. It prepares declared dependencies automatically; do not run `happier plugins author install .` first. It prompts once to trust this source root, so when no present user can answer that prompt use the headless route below instead.',
    '2. The generated prepublication SDK version resolves automatically through the running Happier CLI during managed author commands; do not add a workspace alias, file dependency, author-owned `pnpm-workspace.yaml`, or ad hoc local registry.',
    'When deliberately preparing from an approved registry origin, pass `--sdk-registry <origin>` to `happier plugins dev`, `happier plugins author install .`, or `happier plugins pack .`.',
    '3. Make the smallest source change, then use `happier plugins author typecheck .`, `happier plugins author build .`, and `happier plugins test .` for focused checks. Use `happier plugins test . --packed` when you need the explicit disposable-daemon package/load smoke.',
    '4. Use `happier plugins doctor .` to diagnose an import or top-level evaluation issue; it evaluates once and does not prove repeated evaluation is pure.',
    '5. Use the installed `node_modules/@happier-dev/plugin-sdk/examples/` as copyable public patterns, then adapt the smallest matching example through documented SDK exports. For a custom Session Agent, an External Sessions companion, a managed Provider, Connected Accounts, or daemon-generation background work, start from `node_modules/@happier-dev/plugin-sdk/examples/advanced-package-root/`; its package-root entry and import-safe Session runner leaf are the maintained executable reference.',
    '6. Use `happier plugins pack .` before requesting installation through the ordinary install-and-trust flow.',
    '',
    'The daemon owns candidate custody, activation, and the retained last-known-good generation. If dependency preparation, evaluation, or a UI build fails, fix the source and let the normal development cycle retry; do not start another watcher or loader.',
    '',
    '## Headless first install',
    '',
    '`happier plugins install . --dev --trust --json` carries one explicit non-interactive authorization for that exact local development source, so the first install of a source root needs no terminal prompt. It decides source-root trust and package trust for that one path, selects no optional host resources, and cancels the pending change with `plugin_explicit_trust_target_mismatch` if the daemon review names any other source. `--trust` is valid only together with `--dev` on a local path.',
    'Later iterations need nothing further: a trusted development source root short-circuits review, so `happier plugins reload --json` applies subsequent edits. `happier plugins dev` has no `--trust` equivalent, so use this route when no present user can answer its source-root prompt.',
    '',
    '## Reviews and reconnecting',
    '',
    '`--trust` above is the only non-interactive approval. Without it, a `--json` or noninteractive request never auto-approves: it returns a daemon-issued pending ID for a present user to decide. Preserve that ID and rejoin the same change with `happier plugins change status <pendingChangeId> --json`; a present user decides it with `happier plugins change approve <pendingChangeId> --json` or `happier plugins change reject <pendingChangeId> --json`, or from Settings -> Plugins on that machine. Do not submit a second change request while a review or apply is pending. Consequential updates, optional host resources, and secrets always stay with a present user.',
    'A pending ID can be rejoined only during the same daemon lifetime. If status reports `expired` after a daemon restart, rerun the original development or install request and review its newly prepared facts; do not reuse the old pending ID. `outcome_unknown` is different: inspect installed state before replaying a mutation.',
    '',
  ].join('\n');
}

/**
 * The surface lives in its own leaf module so `pluginUiBuild.ts` can derive the
 * build targets from the SAME declaration the manifest projects. Its only
 * import is the SDK, which keeps it cheap for the build-config loader to
 * evaluate and keeps the author with one place to edit a surface.
 */
function createPluginUiSurfaceModuleSource(params: Readonly<{
  pluginId: string;
  displayName: string;
  ui: PluginScaffoldUiMode;
}>): string {
  const declaration = params.ui === 'hostedWeb'
    ? [
      'export const mainSurface = defineUiSurfaceDefinition({',
      `  id: ${JSON.stringify(MAIN_SURFACE_ID)},`,
      "  placement: 'appPage',",
      `  title: { key: 'scaffold.main.title', fallback: ${JSON.stringify(params.displayName)} },`,
      "  renderer: { kind: 'hostedWeb', requiredHostMethods: ['context', 'executeAction'] },",
      `  build: { entry: ${JSON.stringify(HOSTED_WEB_SOURCE_ENTRY)} },`,
      '});',
    ]
    : (() => {
      const module = createReactNativeRepackModuleIdentity(params.pluginId);
      return [
        'export const mainSurface = defineUiSurfaceDefinition({',
        `  id: ${JSON.stringify(MAIN_SURFACE_ID)},`,
        "  placement: 'appPage',",
        `  title: { key: 'scaffold.main.title', fallback: ${JSON.stringify(params.displayName)} },`,
        "  renderer: { kind: 'reactNative', requiredHostMethods: ['context', 'executeAction'] },",
        '  build: {',
        `    entry: ${JSON.stringify(REACT_NATIVE_WEB_SOURCE_ENTRY)},`,
        "    platforms: ['web', 'ios', 'android'],",
        '    module: {',
        `      containerName: ${JSON.stringify(module.containerName)},`,
        `      modulePath: ${JSON.stringify(module.modulePath)},`,
        `      exportName: ${JSON.stringify(module.exportName)},`,
        '    },',
        '  },',
        '});',
      ];
    })();
  return [
    '// One surface declaration. `src/index.ts` projects it into the manifest and',
    '// `pluginUiBuild.ts` derives its build target from it, so a renderer, entry',
    '// or platform change is edited exactly once.',
    "import { defineUiSurfaceDefinition } from '@happier-dev/plugin-sdk';",
    '',
    ...declaration,
    '',
  ].join('\n');
}

function createPluginSource(params: Readonly<{
  pluginId: string;
  displayName: string;
  ui?: PluginScaffoldUiMode;
}>): string {
  const saveNoteSurfaces = params.ui === undefined
    ? "['agent', 'cli', 'mcp']"
    : "['agent', 'cli', 'mcp', 'ui']";
  const mainSurface = params.ui === undefined
    ? []
    : [
      "import { mainSurface } from './ui/surfaces.js';",
      '',
      'export { mainSurface };',
      '',
    ];
  const lines = [
    "import { definePlugin } from '@happier-dev/plugin-sdk';",
    "import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';",
    '',
    ...mainSurface,
    'export const { manifest, activate } = definePlugin({',
    `  id: ${JSON.stringify(params.pluginId)},`,
    `  version: ${JSON.stringify(DEFAULT_PLUGIN_VERSION)},`,
    `  displayName: ${JSON.stringify(params.displayName)},`,
    `  description: ${JSON.stringify(`Local Happier plugin scaffold for ${params.displayName}.`)},`,
    `  runtime: { apiVersion: ${Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime)} },`,
    "  entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },",
    '  actions: {',
    "    'save-note': {",
    "      title: 'Save note',",
    "      description: 'Returns the supplied note from one minimal plugin action.',",
    "      scopes: ['global'],",
    `      surfaces: ${saveNoteSurfaces},`,
    "      execution: { target: 'daemon' },",
    "      placementBindings: ['commandPalette'],",
    "      dangerLevel: 'safe',",
    '      inputSchema: defineProtocolObject({',
    '        note: defineProtocolString(),',
    "      }, { policy: 'closed' }),",
    '      resultSchema: defineProtocolObject({',
    '        note: defineProtocolString(),',
    "      }, { policy: 'closed' }),",
    '      async run(input) {',
    '        return { note: input.note };',
    '      },',
    '    },',
    '  },',
  ];

  if (params.ui !== undefined) {
    lines.push(
      '  ui: {',
      '    surfaces: [mainSurface],',
      '    translations: [{',
      "      locale: 'en',",
      '      messages: {',
      `        'scaffold.main.title': ${JSON.stringify(params.displayName)},`,
      `        'scaffold.main.greeting': ${JSON.stringify(`Hello from ${params.displayName}`)},`,
      "        'scaffold.action.saveNote': 'Save note',",
      '      },',
      '    }, {',
      "      locale: 'fr',",
      '      messages: {',
      `        'scaffold.main.title': ${JSON.stringify(params.displayName)},`,
      `        'scaffold.main.greeting': ${JSON.stringify(`Bonjour de ${params.displayName}`)},`,
      "        'scaffold.action.saveNote': 'Enregistrer la note',",
      '      },',
      '    }],',
      '  },',
    );
  }

  lines.push(
    '});',
    '',
  );
  return lines.join('\n');
}

function createPluginTestSource(params: Readonly<{
  pluginId: string;
  displayName: string;
  ui?: PluginScaffoldUiMode;
}>): string {
  const uiTest = params.ui === undefined
    ? []
    : createUiDefinitionTestSource({
      pluginId: params.pluginId,
      displayName: params.displayName,
      ui: params.ui,
    });
  return [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    '',
    params.ui === undefined
      ? "import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';"
      : "import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';",
    ...(params.ui === undefined ? [] : ["import { buildUiSurfaceTargets } from '@happier-dev/plugin-sdk/ui/build';"]),
    ...(params.ui === undefined ? [] : ["import { activate, mainSurface, manifest } from '../dist/index.js';"]),
    '',
    ...(params.ui === undefined
      ? ["const module = await import('../dist/index.js');"]
      : ['const module = { activate, manifest };']),
    '',
    "test('save-note returns the supplied note', async (t) => {",
    '  const plugin = await createPluginTestkit({ manifest: module.manifest, module });',
    '  t.after(async () => plugin.dispose());',
    '',
    "  const result = await plugin.invokeAction('save-note', { note: 'hello' });",
    "  assert.deepEqual({ ...result }, { note: 'hello' });",
    '});',
    ...uiTest,
    '',
  ].join('\n');
}

function createUiDefinitionTestSource(params: Readonly<{
  pluginId: string;
  displayName: string;
  ui: PluginScaffoldUiMode;
}>): readonly string[] {
  const rendererKind = params.ui;
  const isReactNative = rendererKind === 'reactNative';
  const module = isReactNative ? createReactNativeRepackModuleIdentity(params.pluginId) : undefined;
  const expectedTargets = isReactNative
    ? [
      '    kind: \'reactNative\',',
      "    rendererId: 'main-renderer',",
      `    entry: ${JSON.stringify(REACT_NATIVE_WEB_SOURCE_ENTRY)},`,
      "    platforms: ['web', 'ios', 'android'],",
      '    module: {',
      `      containerName: ${JSON.stringify(module?.containerName)},`,
      `      modulePath: ${JSON.stringify(module?.modulePath)},`,
      `      exportName: ${JSON.stringify(module?.exportName)},`,
      '    },',
    ]
    : [
      "    kind: 'hostedWeb',",
      "    rendererId: 'main-renderer',",
      `    entry: ${JSON.stringify(HOSTED_WEB_SOURCE_ENTRY)},`,
    ];

  return [
    '',
    `test('${rendererKind} UI definition projects the public app surface and action launcher', async (t) => {`,
    '  const uiSurface = mainSurface;',
    `  assert.equal(uiSurface.renderer.kind, ${JSON.stringify(rendererKind)});`,
    "  assert.equal(uiSurface.placement, 'appPage');",
    `  assert.deepEqual(uiSurface.title, { key: 'scaffold.main.title', fallback: ${JSON.stringify(params.displayName)} });`,
    '  assert.deepEqual(buildUiSurfaceTargets(uiSurface), [{',
    ...expectedTargets,
    '  }]);',
    '',
    "  const view = manifest.contributes.ui.views.find((candidate) => candidate.id === uiSurface.id);",
    '  assert.deepEqual({',
    '    id: view?.id,',
    '    container: view?.container,',
    '    target: view?.target,',
    '    renderer: view?.renderer,',
    '    title: view?.title,',
    '  }, {',
    "    id: 'main',",
    "    container: 'appPage',",
    "    target: { kind: 'app' },",
    "    renderer: 'main-renderer',",
    `    title: { key: 'scaffold.main.title', fallback: ${JSON.stringify(params.displayName)} },`,
    '  });',
    "  const action = manifest.contributes.actions.find((candidate) => candidate.id === 'save-note');",
    '  assert.deepEqual({',
    '    surfaces: action?.surfaces,',
    '    placementBindings: action?.placementBindings,',
    '  }, {',
    "    surfaces: ['agent', 'cli', 'mcp', 'ui'],",
    "    placementBindings: ['commandPalette'],",
    '  });',
    '',
    '  const plugin = await createPluginTestkit({ manifest, module });',
    '  t.after(async () => plugin.dispose());',
    "  const result = await plugin.invokeAction('save-note', { note: 'hello' }, { surface: 'ui' });",
    "  assert.deepEqual({ ...result }, { note: 'hello' });",
    '});',
    ...createUiExecutionTestSource(params),
  ];
}

function createUiExecutionTestSource(params: Readonly<{
  pluginId: string;
  displayName: string;
  ui: PluginScaffoldUiMode;
}>): readonly string[] {
  if (params.ui === 'reactNative') {
    // `happier plugins test` deliberately executes the generated public test
    // through Node's native test runner. RNW semantic mounting is DOM-backed,
    // so it belongs to the existing jsdom RNW scaffold harness rather than a
    // fabricated document in the generated Node test.
    return [];
  }

  return [
    '',
    'function createHostedDocumentFixture() {',
    '  const createElement = (tagName) => {',
    '    const children = [];',
    '    const listeners = new Map();',
    '    const element = {',
    '      tagName,',
    '      children,',
    '      dataset: {},',
    '      style: { setProperty() {} },',
    "      textContent: '',",
    '      append(...nodes) { children.push(...nodes); },',
    '      querySelector(selector) { return query(element, selector); },',
    '      addEventListener(type, listener) {',
    '        const current = listeners.get(type) ?? [];',
    '        current.push(listener);',
    '        listeners.set(type, current);',
    '      },',
    '      dispatch(type) {',
    '        for (const listener of listeners.get(type) ?? []) listener();',
    '      },',
    '    };',
    '    return element;',
    '  };',
    '  const body = createElement(\'body\');',
    '  const documentElement = createElement(\'html\');',
    '  const matches = (element, selector) => (',
    "    selector === '#root' ? element.id === 'root' : element.dataset.role === selector.match(/^\\[data-role=\"(.+)\"\\]$/)?.[1]",
    '  );',
    '  const query = (element, selector) => {',
    '    for (const child of element.children) {',
    '      if (matches(child, selector)) return child;',
    '      const nested = query(child, selector);',
    '      if (nested) return nested;',
    '    }',
    '    return undefined;',
    '  };',
    '  return {',
    '    document: {',
    '      body,',
    '      documentElement,',
    '      createElement,',
    '      querySelector(selector) { return query(body, selector); },',
    '    },',
    '    query(selector) { return query(body, selector); },',
    '  };',
    '}',
    '',
    'async function waitForHostedStatus(root, expectedTone, expectedMessage) {',
    '  for (let attempt = 0; attempt < 20; attempt += 1) {',
    "    const status = root.querySelector('[data-role=\"status\"]');",
    '    if (root.dataset.status === expectedTone && status?.textContent === expectedMessage) return;',
    '    await new Promise((resolve) => setTimeout(resolve, 0));',
    '  }',
    '  throw new Error(`Hosted scaffold did not reach ${expectedTone}: ${expectedMessage}`);',
    '}',
    '',
    "test('hostedWeb UI executes the compiled public bootstrap through the SDK test adapter', async (t) => {",
    '  const actionCalls = [];',
    '  const fixture = await createPluginUiTestkit({',
    '    identity: {',
    `      pluginId: ${JSON.stringify(params.pluginId)},`,
    `      pluginVersion: ${JSON.stringify(DEFAULT_PLUGIN_VERSION)},`,
    "      viewId: 'main',",
    "      generation: 'generated-test',",
    "      sessionId: 'generated-session',",
    '    },',
    "    surface: { kind: 'hosted-web-bootstrap' },",
    "    surfaceContext: createSurfaceContextFixture({ locale: 'fr', translations: {",
    `      'scaffold.main.greeting': ${JSON.stringify(`Bonjour de ${params.displayName}`)},`,
    "      'scaffold.action.saveNote': 'Enregistrer la note',",
    '    } }),',
    '    adapter: {',
    '      async mount() {',
    '        return {',
    '          async snapshot() { return { revision: 1, nodes: [] }; },',
    '          async update() {},',
    "          async invoke() { throw new Error('Hosted bootstrap adapter has no semantic controls.'); },",
    '          async dispose() {},',
    '        };',
    '      },',
    '    },',
    '    handlers: {',
    '      async executeAction({ action, input }) {',
    '        actionCalls.push({ action, input });',
    "        return { note: 'hello' };",
    '      },',
    '    },',
    '  });',
    '  t.after(async () => fixture.dispose());',
    '',
    '  const hostedDocument = createHostedDocumentFixture();',
    "  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');",
    "  Object.defineProperty(globalThis, 'document', { configurable: true, value: hostedDocument.document });",
    '  t.after(() => {',
    "    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);",
    "    else Reflect.deleteProperty(globalThis, 'document');",
    '  });',
    '',
    "  const { bootstrapHostedWebSurface } = await import('../dist/ui/index.js');",
    '  await bootstrapHostedWebSurface(fixture.context);',
    "  const root = hostedDocument.query('#root');",
    "  const title = hostedDocument.query('[data-role=\"title\"]');",
    "  const save = hostedDocument.query('[data-role=\"save\"]');",
    '  assert.ok(root);',
    '  assert.ok(title);',
    '  assert.ok(save);',
    `  assert.equal(title.textContent, ${JSON.stringify(`Bonjour de ${params.displayName}`)});`,
    "  assert.equal(root.dataset.status, 'ready');",
    "  assert.equal(save.textContent, 'Enregistrer la note');",
    "  save.dispatch('click');",
    "  await waitForHostedStatus(root, 'ready', 'Saved');",
    "  assert.deepEqual(actionCalls.map(({ action, input }) => ({ action, input: { ...input } })), [{ action: 'save-note', input: { note: 'hello' } }]);",
    '});',
  ];
}

function createHostedWebSource(params: Readonly<{ displayName: string }>): string {
  // Hosted web is isolated plugin-owned web UI. The host injects the transport;
  // the surface takes its whole render context from the public client rather
  // than guessing browser state.
  //
  // `createPluginUiRenderContext()` is the hosted-web bootstrap boundary for
  // the current plugin/view/surface facts and the retirement signal. Launch
  // details remain host-owned; a generated application does not parse or
  // display them.
  //
  // The bridge now has a host->frame push channel (EU-8), so `watchContext` is
  // real: the surface stays current with locale, theme, direction and
  // accessibility changes instead of rendering the negotiated snapshot once.
  // It is still feature-detected through `version().methods`, because a mount
  // that cannot push does not advertise it.
  return [
    "import {",
    "  applyPluginUiThemeCssVariables,",
    "  createPluginUiRenderContext,",
    "} from '@happier-dev/plugin-sdk/ui/client';",
    "import type { RenderContext, SurfaceContext } from '@happier-dev/plugin-sdk/ui';",
    '',
    'function setStatus(root: HTMLElement, message: string, tone: \'loading\' | \'error\' | \'ready\'): void {',
    "  root.dataset.status = tone;",
    "  const status = root.querySelector<HTMLElement>('[data-role=\"status\"]');",
    '  if (status) status.textContent = message;',
    "  if (status) status.style.color = tone === 'error'",
    "    ? 'var(--happier-plugin-color-danger, inherit)'",
    "    : 'var(--happier-plugin-color-secondary-text, inherit)';",
    '}',
    '',
    '// Standard managed hosted-web HTML contains only the module script. The',
    '// scaffold creates its small document shell so it remains runnable without',
    '// a package-root index.html that the SDK builder would ignore.',
    'function ensureRoot(): HTMLElement {',
    "  const existing = document.querySelector<HTMLElement>('#root');",
    '  if (existing) return existing;',
    '',
    "  document.body.style.margin = '0';",
    "  document.body.style.background = 'var(--happier-plugin-color-canvas, transparent)';",
    "  document.body.style.color = 'var(--happier-plugin-color-text, inherit)';",
    "  document.body.style.fontSize = 'var(--happier-plugin-text-body-size, 14px)';",
    "  document.body.style.lineHeight = 'var(--happier-plugin-text-body-line-height, 20px)';",
    "  const root = document.createElement('main');",
    "  root.id = 'root';",
    "  root.dataset.status = 'loading';",
    "  root.style.display = 'flex';",
    "  root.style.flexDirection = 'column';",
    "  root.style.gap = 'var(--happier-plugin-spacing-small, 8px)';",
    "  root.style.padding = 'var(--happier-plugin-spacing-medium, 12px)';",
    '',
    "  const title = document.createElement('h1');",
    "  title.dataset.role = 'title';",
    "  const status = document.createElement('p');",
    "  status.dataset.role = 'status';",
    "  status.textContent = 'Connecting to Happier…';",
    "  const save = document.createElement('button');",
    "  save.type = 'button';",
    "  save.dataset.role = 'save';",
    "  save.textContent = 'Save note';",
    "  save.style.alignSelf = 'flex-start';",
    "  save.style.border = '1px solid var(--happier-plugin-color-border, currentColor)';",
    "  save.style.borderRadius = 'var(--happier-plugin-radius-control, 6px)';",
    "  save.style.background = 'var(--happier-plugin-color-control, transparent)';",
    "  save.style.color = 'inherit';",
    "  save.style.padding = 'var(--happier-plugin-spacing-xsmall, 4px) var(--happier-plugin-spacing-small, 8px)';",
    '  root.append(title, status, save);',
    '  document.body.append(root);',
    '  return root;',
    '}',
    '',
    '// Everything visual comes from the semantic theme: the host cannot inject',
    '// styles into an isolated realm, so the guest applies the snapshot as',
    '// `--happier-plugin-*` custom properties and the surface consumes them.',
    'function render(root: HTMLElement, surface: SurfaceContext): void {',
    '  applyPluginUiThemeCssVariables(surface.theme, document.documentElement);',
    '  root.dir = surface.direction;',
    '  root.lang = surface.locale;',
    '  root.dataset.colorScheme = surface.colorScheme;',
    `  const title = root.querySelector<HTMLElement>('[data-role="title"]');`,
    `  if (title) title.textContent = surface.translations['scaffold.main.greeting'] ?? ${JSON.stringify(`Hello from ${params.displayName}`)};`,
    `  const save = root.querySelector<HTMLElement>('[data-role="save"]');`,
    "  if (save) save.textContent = surface.translations['scaffold.action.saveNote'] ?? 'Save note';",
    '}',
    '',
    'export async function bootstrapHostedWebSurface(providedContext?: RenderContext): Promise<void> {',
    '  const root = ensureRoot();',
    "  setStatus(root, 'Connecting to Happier…', 'loading');",
    '',
    '  const context = providedContext ?? await createPluginUiRenderContext();',
    '  render(root, context.surface);',
    "  setStatus(root, 'Ready', 'ready');",
    '',
    '  // Stay current when the host publishes new facts.',
    "  if (context.hostApi.version().methods.includes('watchContext')) {",
    '    await context.hostApi.watchContext((surface) => { render(root, surface); }, { signal: context.signal });',
    '  }',
    '',
    "  const save = root.querySelector<HTMLButtonElement>('[data-role=\"save\"]');",
    "  save?.addEventListener('click', () => {",
    '    void (async () => {',
    '      try {',
    "        await context.hostApi.executeAction('save-note', { note: 'hello' }, { signal: context.signal });",
    "        setStatus(root, 'Saved', 'ready');",
    '      } catch (error: unknown) {',
    "        setStatus(root, error instanceof Error ? error.message : 'Action failed', 'error');",
    '      }',
    '    })();',
    '  });',
    '}',
    '',
    "if (typeof window !== 'undefined') {",
    '  void bootstrapHostedWebSurface().catch((error: unknown) => {',
    '    setStatus(ensureRoot(), error instanceof Error ? error.message : \'Failed to start\', \'error\');',
    '  });',
    '}',
    '',
  ].join('\n');
}

/**
 * The build config DERIVES its targets from the one surface declaration through
 * the SDK's retained `buildUiSurfaceTargets` projection. The predecessor
 * scaffold restated `rendererId`, `entry`, `kind`, `platforms` and the Module
 * Federation identity here as well, so a beginner maintained two sources of one
 * truth and a drifted pair failed only at artifact-verification time.
 *
 * Raw `ui.views` / `ui.renderers` plus a hand-written `targets` array remain the
 * advanced route for shared renderers, fallback chains and custom artifacts.
 */
function createUiBuildConfigSource(): string {
  return [
    "import { buildUiSurfaceTargets, defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';",
    '',
    `import { mainSurface } from './${MAIN_SURFACE_MODULE_RELATIVE_PATH}';`,
    '',
    'export const pluginUiBuildConfig = defineBuildConfig({',
    '  targets: [...buildUiSurfaceTargets(mainSurface)],',
    '});',
    '',
    'export default pluginUiBuildConfig;',
    '',
  ].join('\n');
}

function createReactNativeRepackModuleIdentity(pluginId: string): Readonly<{
  containerName: string;
  modulePath: string;
  exportName: string;
}> {
  return {
    // Module Federation container names are JavaScript identifiers. Deriving
    // this one from the generated package name keeps it unique per plugin
    // without asking authors to synchronize a second identity by hand.
    containerName: `${sanitizePackageName(pluginId).replaceAll('-', '_')}_${REACT_NATIVE_WEB_CONTRIBUTION_ID.replaceAll('-', '_')}`,
    modulePath: REACT_NATIVE_REPACK_MODULE_PATH,
    exportName: REACT_NATIVE_REPACK_EXPORT_NAME,
  };
}

function createReactNativeSurfaceSource(params: Readonly<{ displayName: string }>): string {
  return [
    '// React Native plugin UI surface. `defineUiSurface` installs the',
    '// public provider from the host-supplied render context, so this author',
    '// component owns neither a second provider nor a raw host API bridge.',
    "import * as React from 'react';",
    "import { Action, Card, defineUiSurface, Text, usePluginTranslation } from '@happier-dev/plugin-ui';",
    '',
    'function MainSurface() {',
    '  const translate = usePluginTranslation();',
    '  return (',
    '    <Card>',
    `      <Text variant="title" value={translate('scaffold.main.greeting', ${JSON.stringify(`Hello from ${params.displayName}`)})} />`,
    "      <Action.Execute action=\"save-note\" input={{ note: \"hello\" }} title={translate('scaffold.action.saveNote', 'Save note')} />",
    '    </Card>',
    '  );',
    '}',
    '',
    '// This is the single bundle-contract export consumed by both the Vite',
    '// react-native-web artifact and the iOS/Android Re.Pack artifacts.',
    'export const renderSurface = defineUiSurface(MainSurface);',
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
  // Scaffolding writes a working tree, not a published artifact. The reserved
  // `happier.*` namespace is a registry-custody rule owned by manifest
  // validation and archive staging, so refusing it here only stopped a
  // maintainer from scaffolding a plugin this repository ships.
  if (!PluginIdSchema.safeParse(pluginId).success) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'Plugin id must use a lower-case dot-delimited owner namespace')],
    };
  }
  if (!displayName) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'Plugin display name is required')],
    };
  }
  if (ui !== undefined && !PluginScaffoldUiModeSchema.safeParse(ui).success) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'Only --ui hostedWeb or --ui reactNative is supported for plugin scaffolds')],
    };
  }

  const targetDir = resolve(expandHomeDirPath(rawTargetDir));
  const baseDir = typeof params.baseDir === 'string' && params.baseDir.trim().length > 0
    ? resolve(expandHomeDirPath(params.baseDir.trim()))
    : null;
  if (baseDir && !isCanonicalAbsolutePathInsideRoot(baseDir, targetDir)) {
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

  const packageJsonPath = join(targetDir, 'package.json');
  const sourceEntryPath = join(targetDir, 'src', 'index.ts');
  const testEntryPath = join(targetDir, 'test', 'index.test.mjs');
  const tsconfigPath = join(targetDir, 'tsconfig.json');
  const authoringSkillPath = join(targetDir, ...PLUGIN_AUTHORING_SKILL_DIRECTORY, 'SKILL.md');
  const uiEntryPath = ui === 'hostedWeb'
    ? join(targetDir, ...HOSTED_WEB_SOURCE_ENTRY.split('/'))
    : ui === 'reactNative'
      ? join(targetDir, ...REACT_NATIVE_WEB_SOURCE_ENTRY.split('/'))
      : undefined;
  // A TypeScript build config is an admitted `BUILD_CONFIG_BASENAMES` entry and
  // is what lets the config import the typed surface declaration directly.
  const uiBuildConfigPath = join(targetDir, 'pluginUiBuild.ts');
  const uiSurfaceModulePath = join(targetDir, ...MAIN_SURFACE_MODULE_RELATIVE_PATH.split('/'));

  try {
    await mkdir(join(targetDir, 'src'), { recursive: true });
    await mkdir(join(targetDir, 'test'), { recursive: true });
    await mkdir(join(targetDir, ...PLUGIN_AUTHORING_SKILL_DIRECTORY), { recursive: true });
    if (uiEntryPath) {
      await mkdir(join(targetDir, 'src', 'ui'), { recursive: true });
    }
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(createPackageJson({
        packageName: sanitizePackageName(pluginId),
        displayName,
        ui,
      }), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      sourceEntryPath,
      createPluginSource({ pluginId, displayName, ui }),
      'utf8',
    );
    await writeFile(testEntryPath, createPluginTestSource({ pluginId, displayName, ui }), 'utf8');
    await writeFile(tsconfigPath, createTypeScriptConfig(), 'utf8');
    await writeFile(authoringSkillPath, createPluginAuthoringSkillSource(), 'utf8');
    if (uiEntryPath && ui !== undefined) {
      await writeFile(
        uiEntryPath,
        ui === 'hostedWeb'
          ? createHostedWebSource({ displayName })
          : createReactNativeSurfaceSource({ displayName }),
        'utf8',
      );
      await writeFile(
        uiSurfaceModulePath,
        createPluginUiSurfaceModuleSource({ pluginId, displayName, ui }),
        'utf8',
      );
      await writeFile(uiBuildConfigPath, createUiBuildConfigSource(), 'utf8');
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
    packageJsonPath,
    sourceEntryPath,
    ...(uiEntryPath ? { uiEntryPath } : {}),
  };
}
