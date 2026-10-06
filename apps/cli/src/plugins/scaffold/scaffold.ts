import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { DEFAULT_PLUGIN_SCAFFOLD_UI_MODE, PluginScaffoldTemplateSchema, PluginScaffoldUiModeSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import type { PluginScaffoldTemplate, PluginScaffoldUiMode } from '@happier-dev/protocol';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';

import {
  expandHomeDirPath,
  isCanonicalAbsolutePathInsideRoot,
} from '@/utils/path/expandHomeDirPath';
import {
  createSessionAgentPluginSource,
  createSessionAgentRunnerSource,
  createSessionAgentTestSource,
} from './sessionAgentTemplate';

export type PluginScaffoldDiagnostic = Readonly<{
  code: 'plugin_scaffold_invalid_input' | 'plugin_scaffold_target_exists' | 'plugin_scaffold_failed';
  message: string;
}>;

// `declarative` is the default: the host projects the declared nodes, so a
// fresh plugin renders its first surface on every platform with no bundler and
// no UI dependency tree. `reactNative` remains the executable mode that also
// targets web through React Native Web. The vocabulary and the default are
// owned by `PluginScaffoldUiModeSchema` and `DEFAULT_PLUGIN_SCAFFOLD_UI_MODE`,
// so the CLI flag, the `plugins.scaffold` action input and the Settings Create
// form cannot diverge.
export type { PluginScaffoldUiMode };
export type { PluginScaffoldTemplate };

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
const MAIN_SURFACE_MODULE_RELATIVE_PATH = 'src/ui/surfaces.ts';
const REACT_NATIVE_WEB_SOURCE_ENTRY = 'src/ui/renderSurface.tsx';
const HOSTED_WEB_SOURCE_ROOT = '.happier-plugin/ui/hosted-web/main-renderer';
const HOSTED_WEB_SOURCE_ENTRY = `${HOSTED_WEB_SOURCE_ROOT}/entry.ts`;
const HOSTED_WEB_INDEX_ENTRY = `${HOSTED_WEB_SOURCE_ROOT}/index.html`;

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
  invokerName: string;
  ui?: PluginScaffoldUiMode;
}>): unknown {
  const invoker = params.invokerName;
  const scripts: Record<string, string> = {
    build: `${invoker} plugins dev build .`,
    typecheck: `${invoker} plugins dev typecheck .`,
    test: `${invoker} plugins test .`,
    'pack:plugin': `${invoker} plugins pack .`,
  };
  const dependencies: Record<string, string> = {
    '@happier-dev/plugin-sdk': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk'],
  };
  const devDependencies: Record<string, string> = {
    '@types/node': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/node'],
    '@typescript/native': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@typescript/native'],
  };

  if (params.ui === 'hostedWeb') {
    // Hosted web is an isolated plugin-owned static application. The compiler
    // stages its conventional directory and compiles only its optional entry.ts.
    scripts['build:ui'] = 'happier-plugin-build-ui --project-root .';
    devDependencies.typescript = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.typescript;
    devDependencies.react = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies.react;
  }

  if (params.ui === 'reactNative') {
    // One neutral CommonJS artifact runs on web, iOS, and Android.
    scripts['build:ui'] = 'happier-plugin-build-ui --project-root .';
    dependencies['@happier-dev/plugin-ui'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-ui'];
    dependencies.react = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies.react;
    dependencies['react-dom'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-dom'];
    dependencies['react-native'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-native'];
    dependencies['react-native-web'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-native-web'];
    devDependencies.typescript = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.typescript;
    devDependencies['@types/react'] = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/react'];
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
    ...(params.ui === 'reactNative'
      ? { exports: { [`./happier-plugin-ui/${MAIN_SURFACE_ID}-renderer`]: `./${REACT_NATIVE_WEB_SOURCE_ENTRY}` } }
      : {}),
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
      // `happier plugins dev build` bundles this project into
      // `entrypoints.daemon` inside `outDir`, so a compiler emit here would
      // replace that self-contained bundle with a re-export module — which
      // still resolves in the author's checkout and fails once the plugin is
      // packed. The compiler's job in a plugin package is type checking only;
      // the bundler is the single producer of built output.
      noEmit: true,
      // Native TypeScript retains the semantic graph between explicit
      // `plugins dev typecheck|build|test` invocations. The cache stays inside
      // the already-ignored dependency tree and never enters a plugin archive.
      incremental: true,
      tsBuildInfoFile: 'node_modules/.cache/happier/plugin-author.tsbuildinfo',
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
function createPluginAuthoringSkillSource(invokerName: string, ui?: PluginScaffoldUiMode): string {
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
    `Before adopting a contribution or service family, read \`node_modules/${PUBLIC_PLUGIN_SDK_PACKAGE_NAME}/capability-matrix.json\`. It is the sole product-availability authority: a \`deferred\` row is conformance-only reference material, not a supported product lifecycle. Its source API and consumer fields do not by themselves establish loaded-platform or release availability.`,
    'Use only the package entrypoints documented there. Do not reach into host source, private aliases, or another installed plugin artifact.',
    ...(ui === 'reactNative'
      ? [`For React Native UI exports, read \`node_modules/@happier-dev/plugin-ui/API.md\` before choosing a component or hook; it is the shipped Plugin UI API inventory for this package.`]
      : []),
    '',
    '## Settings and configuration pages',
    '',
    'A plugin settings or detail page uses the same anatomy as Happier\'s own settings (`DESIGN.md` → "Configuration surfaces"): a page header, sentence-case sections with their explanation above the rows, one control per row, visual tiles for choices that change what you see, and list + detail for collections of named things. Compose it from the public plugin UI components that render through Happier\'s own page owners — `PageHeader`, `ItemGroup` with a `title`/`description`/`action` (a page section), `Item` rows with one control in `accessory`, `Toggle`, `Select` (`presentation="segmented"` for 2–4 short options, `"field"` for longer sets), `TextField presentation="field"` for a value typed in place (`onCommit` saves on leaving), `SelectionTiles` (`variant="visual"` with real previews) and `EmptyState` (`layout="page"`/`"line"`) — checking exact names in the API inventory; do not rebuild headers, row dividers, dropdown triggers, switches or selection rings locally, and do not draw a back control or duplicate the page title (the host places both). See [Settings and detail pages](https://docs.happier.dev/plugins/ui/configuration-pages).',
    '',
    'Load `.agents/skills/happier-ui-craft` for the method: hierarchy, control choice, copy, states and the side-by-side check.',
    '',
    '## Cross-plugin integrations',
    '',
    `For broader public composition patterns, read \`node_modules/${PUBLIC_PLUGIN_SDK_PACKAGE_NAME}/examples/public-authoring/\` and \`node_modules/${PUBLIC_PLUGIN_SDK_PACKAGE_NAME}/examples/advanced-package-root/\`. Use only contribution and service families marked available in the capability matrix; an example demonstrates public package boundaries but does not create product availability. This beginner scaffold does not declare a feature integration.`,
    '',
    '## Normal author loop',
    '',
    'Work in a normal Happier Agent Session rooted at this source directory. Use the same public lifecycle as a human author:',
    '',
    `1. Start or continue live development with \`${invokerName} plugins dev\`. It prepares declared dependencies automatically; do not run \`${invokerName} plugins dev install .\` first. Explicit registration trusts this exact source root without a separate code-trust prompt. Automatic workspace discovery still requires its remembered project-trust decision. Optional host resources and secrets require their separate authority decisions.`,
    `Exception — dependency refresh: that cold-start preparation materializes an author root exactly once, only when nothing resolvable is installed yet. After you change declared dependencies in \`package.json\`, or your \`node_modules\` is stale or wiped, run \`${invokerName} plugins dev install .\` once to refresh the tree; the watch loop does not reinstall on every start.`,
    '2. The generated prepublication SDK version resolves automatically through the running Happier CLI during managed author commands; do not add a workspace alias, file dependency, author-owned `pnpm-workspace.yaml`, or ad hoc local registry.',
    `When deliberately preparing from an approved registry origin, pass \`--sdk-registry <origin>\` to \`${invokerName} plugins dev\`, \`${invokerName} plugins dev install .\`, or \`${invokerName} plugins pack .\`.`,
    `3. Make the smallest source change, then use \`${invokerName} plugins dev typecheck .\`, \`${invokerName} plugins dev build .\`, and \`${invokerName} plugins test .\` for focused checks. Validate through the managed source-development lifecycle; do not create or install a local release archive as an additional feature-QA gate.`,
    `4. Use \`${invokerName} plugins doctor .\` to diagnose an import or top-level evaluation issue; it evaluates once and does not prove repeated evaluation is pure.`,
    `5. Use the installed \`node_modules/@happier-dev/plugin-sdk/examples/\` as public patterns, then adapt the smallest matching example through documented SDK exports. For a custom persistent Session Agent, start with \`${invokerName} plugins create <name> --template session-agent\`; \`node_modules/@happier-dev/plugin-sdk/examples/session-agent/\` remains the richer deterministic lifecycle reference. Use \`node_modules/@happier-dev/plugin-sdk/examples/advanced-package-root/\` only when the same package also needs External Sessions, a Provider, Connected Accounts, Resources, or background work.`,
    '',
    'The daemon owns prepared-change custody and activation. A failed in-process replacement keeps the incumbent plugin occurrence active only while that daemon lives. After a daemon restart, Happier rebuilds the current source; if it cannot build and activate, the development plugin is unavailable until corrected. Fix the source and let the normal development cycle retry; do not start another watcher or loader.',
    '',
    '## Explicit development install',
    '',
    `\`${invokerName} plugins install . --dev --json\` is the explicit code-trust action for that exact local development source, so the first install needs no redundant code-trust prompt. It selects no optional host resources, and cancels the pending change with \`plugin_explicit_trust_target_mismatch\` if the daemon review names any other source.`,
    `Later iterations need nothing further: a trusted development source root short-circuits code review, so \`${invokerName} plugins reload --json\` applies subsequent edits. This is an alternative explicit install command; the normal \`plugins dev\` loop already trusts its registered source root.`,
    '',
    '## Reviews and reconnecting',
    '',
    `A local-path install carries code trust only. A separate authority decision still returns a daemon-issued pending ID for a present user to decide. Preserve that ID and rejoin the same change with \`${invokerName} plugins change status <pendingChangeId> --json\`; a present user decides it with \`${invokerName} plugins change approve <pendingChangeId> --json\` or \`${invokerName} plugins change reject <pendingChangeId> --json\`, or from Settings -> Plugins on that machine. Do not submit a second change request while a review or apply is pending. Optional host resources and secrets always stay with their canonical authority owner.`,
    'A pending ID can be rejoined only during the same daemon lifetime. If status reports `expired` after a daemon restart, rerun the original development or install request and review its newly prepared facts; do not reuse the old pending ID. `outcome_unknown` is different: inspect installed state before replaying a mutation.',
    '',
  ].join('\n');
}

/**
 * The surface lives in its own leaf module; executable bytes are discovered
 * through its manifest artifact id and the package's exact export.
 */
function createPluginUiSurfaceModuleSource(params: Readonly<{
  pluginId: string;
  displayName: string;
  ui: PluginScaffoldUiMode;
}>): string {
  const declaration = params.ui === 'declarative'
    // A declarative surface IS its declaration: the host projects these nodes,
    // so there is no entry module, no build target and no bundler to learn
    // before the first surface renders.
    ? [
      'export const mainSurface = defineUiSurfaceDefinition({',
      `  id: ${JSON.stringify(MAIN_SURFACE_ID)},`,
      "  placement: 'appPage',",
      `  title: { key: 'scaffold.main.title', fallback: ${JSON.stringify(params.displayName)} },`,
      '  renderer: {',
      "    kind: 'declarative',",
      '    root: {',
      "      kind: 'group',",
      `      title: { key: 'scaffold.main.title', fallback: ${JSON.stringify(params.displayName)} },`,
      '      children: [{',
      "        kind: 'text',",
      `        text: { key: 'scaffold.main.greeting', fallback: ${JSON.stringify(`Hello from ${params.displayName}`)} },`,
      '      }, {',
      "        kind: 'action',",
      "        action: 'save-note',",
      "        variant: 'primary',",
      "        input: { note: 'hello' },",
      "        label: { key: 'scaffold.action.saveNote', fallback: 'Save note' },",
      '      }],',
      '    },',
      '  },',
      '});',
    ]
    : params.ui === 'hostedWeb'
    ? [
      'export const mainSurface = defineUiSurfaceDefinition({',
      `  id: ${JSON.stringify(MAIN_SURFACE_ID)},`,
      "  placement: 'appPage',",
      `  title: { key: 'scaffold.main.title', fallback: ${JSON.stringify(params.displayName)} },`,
      "  renderer: { kind: 'hostedWeb', requiredHostMethods: ['context', 'executeAction'] },",
      '});',
    ]
    : (() => {
      return [
        'export const mainSurface = defineUiSurfaceDefinition({',
        `  id: ${JSON.stringify(MAIN_SURFACE_ID)},`,
        "  placement: 'appPage',",
        `  title: { key: 'scaffold.main.title', fallback: ${JSON.stringify(params.displayName)} },`,
        "  renderer: { kind: 'reactNative', requiredHostMethods: ['context', 'executeAction'] },",
        '});',
      ];
    })();
  return [
    '// One surface declaration. `src/index.ts` projects it into the manifest;',
    '// exact package exports identify executable source entries.',
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
    // The status vocabulary belongs to the executable bootstraps, which own a
    // connecting/ready/failed lifecycle. A declarative surface has none — the
    // host renders the declared nodes — so it would ship five keys nothing
    // reads.
    const statusMessages = params.ui === 'declarative'
      ? { en: [], fr: [] }
      : {
        en: [
          "        'scaffold.status.connecting': 'Connecting to Happier…',",
          "        'scaffold.status.ready': 'Ready',",
          "        'scaffold.status.saved': 'Saved',",
          "        'scaffold.status.actionFailed': 'Action failed',",
          "        'scaffold.status.startFailed': 'Failed to start',",
        ],
        fr: [
          "        'scaffold.status.connecting': 'Connexion à Happier…',",
          "        'scaffold.status.ready': 'Prêt',",
          "        'scaffold.status.saved': 'Enregistré',",
          "        'scaffold.status.actionFailed': 'L’action a échoué',",
          "        'scaffold.status.startFailed': 'Le démarrage a échoué',",
        ],
      };
    lines.push(
      '  ui: {',
      '    surfaces: [mainSurface],',
      '    translations: [{',
      "      locale: 'en',",
      '      messages: {',
      `        'scaffold.main.title': ${JSON.stringify(params.displayName)},`,
      `        'scaffold.main.greeting': ${JSON.stringify(`Hello from ${params.displayName}`)},`,
      "        'scaffold.action.saveNote': 'Save note',",
      ...statusMessages.en,
      '      },',
      '    }, {',
      "      locale: 'fr',",
      '      messages: {',
      `        'scaffold.main.title': ${JSON.stringify(params.displayName)},`,
      `        'scaffold.main.greeting': ${JSON.stringify(`Bonjour de ${params.displayName}`)},`,
      "        'scaffold.action.saveNote': 'Enregistrer la note',",
      ...statusMessages.fr,
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

  return [
    '',
    `test('${rendererKind} UI definition projects the public app surface and action launcher', async (t) => {`,
    '  const uiSurface = mainSurface;',
    `  assert.equal(uiSurface.renderer.kind, ${JSON.stringify(rendererKind)});`,
    "  assert.equal(uiSurface.placement, 'appPage');",
    `  assert.deepEqual(uiSurface.title, { key: 'scaffold.main.title', fallback: ${JSON.stringify(params.displayName)} });`,
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
  if (params.ui === 'declarative') {
    // There is no author bootstrap to execute: the host renders the declared
    // nodes. What the generated test can and does prove is that the declaration
    // reaches the action the surface offers, which is already covered above.
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
    '      attributes: {},',
    "      textContent: '',",
    '      setAttribute(name, value) { this.attributes[name] = value; },',
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
    "    identity: { instanceId: 'generated-instance', mountNonce: 'generated-mount' },",
    '    authorPlugin: {',
    `      id: ${JSON.stringify(params.pluginId)},`,
    `      version: ${JSON.stringify(DEFAULT_PLUGIN_VERSION)},`,
    '    },',
    "    surface: { kind: 'hosted-web-bootstrap' },",
    "    surfaceContext: createSurfaceContextFixture({ locale: 'fr', translations: {",
    `      'scaffold.main.greeting': ${JSON.stringify(`Bonjour de ${params.displayName}`)},`,
    "      'scaffold.action.saveNote': 'Enregistrer la note',",
    "      'scaffold.status.saved': 'Enregistré',",
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
    "  const { bootstrapHostedWebSurface } = await import('../dist/happier-plugin-ui/hosted-web/main-renderer/assets/app.js');",
    '  await bootstrapHostedWebSurface(fixture.context);',
    "  const root = hostedDocument.query('#root');",
    "  const title = hostedDocument.query('[data-role=\"title\"]');",
    "  const save = hostedDocument.query('[data-role=\"save\"]');",
    "  const status = hostedDocument.query('[data-role=\"status\"]');",
    '  assert.ok(root);',
    '  assert.ok(title);',
    '  assert.ok(save);',
    '  assert.ok(status);',
    `  assert.equal(title.textContent, ${JSON.stringify(`Bonjour de ${params.displayName}`)});`,
    "  assert.equal(root.dataset.status, 'ready');",
    "  assert.equal(save.textContent, 'Enregistrer la note');",
    "  save.dispatch('click');",
    "  await waitForHostedStatus(root, 'ready', 'Enregistré');",
    "  assert.equal(status.attributes.role, 'status');",
    "  assert.equal(status.attributes['aria-live'], 'polite');",
    "  assert.equal(status.attributes['aria-atomic'], 'true');",
    '  await fixture.updateSurface(createSurfaceContextFixture({ locale: \'en\', translations: {',
    `    'scaffold.main.greeting': ${JSON.stringify(`Hello from ${params.displayName}`)},`,
    "    'scaffold.action.saveNote': 'Save note',",
    "    'scaffold.status.saved': 'Saved',",
    '  } }));',
    "  await waitForHostedStatus(root, 'ready', 'Saved');",
    `  assert.equal(title.textContent, ${JSON.stringify(`Hello from ${params.displayName}`)});`,
    "  assert.equal(save.textContent, 'Save note');",
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
    'function translate(surface: SurfaceContext | null, key: string, fallback: string): string {',
    '  return surface?.translations[key] ?? fallback;',
    '}',
    '',
    "type ScaffoldStatus = 'connecting' | 'ready' | 'saved' | 'actionFailed' | 'startFailed';",
    '',
    'function renderStatus(root: HTMLElement, statusKind: ScaffoldStatus, surface: SurfaceContext | null): void {',
    "  const tone = statusKind === 'connecting' ? 'loading' : statusKind === 'actionFailed' || statusKind === 'startFailed' ? 'error' : 'ready';",
    '  const statusMessages: Record<ScaffoldStatus, readonly [string, string]> = {',
    "    connecting: ['scaffold.status.connecting', 'Connecting to Happier…'],",
    "    ready: ['scaffold.status.ready', 'Ready'],",
    "    saved: ['scaffold.status.saved', 'Saved'],",
    "    actionFailed: ['scaffold.status.actionFailed', 'Action failed'],",
    "    startFailed: ['scaffold.status.startFailed', 'Failed to start'],",
    '  };',
    '  const [key, fallback] = statusMessages[statusKind];',
    "  root.dataset.status = tone;",
    "  const status = root.querySelector<HTMLElement>('[data-role=\"status\"]');",
    "  if (status) status.setAttribute('role', tone === 'error' ? 'alert' : 'status');",
    "  if (status) status.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');",
    "  if (status) status.setAttribute('aria-atomic', 'true');",
    '  if (status) status.textContent = translate(surface, key, fallback);',
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
    "  save.style.minWidth = '44px';",
    "  save.style.minHeight = '44px';",
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
    "  let currentStatus: ScaffoldStatus = 'connecting';",
    '  let currentSurface = providedContext?.surface ?? null;',
    '  renderStatus(root, currentStatus, currentSurface);',
    '',
    '  const context = providedContext ?? await createPluginUiRenderContext();',
    '  currentSurface = context.surface;',
    '  render(root, context.surface);',
    "  currentStatus = 'ready';",
    '  renderStatus(root, currentStatus, currentSurface);',
    '',
    '  // Stay current when the host publishes new facts.',
    "  if (context.hostApi.version().methods.includes('watchContext')) {",
    '    await context.hostApi.watchContext((surface) => {',
    '      currentSurface = surface;',
    '      render(root, surface);',
    '      renderStatus(root, currentStatus, currentSurface);',
    '    }, { signal: context.signal });',
    '  }',
    '',
    "  const save = root.querySelector<HTMLButtonElement>('[data-role=\"save\"]');",
    "  save?.addEventListener('click', () => {",
    '    void (async () => {',
    '      try {',
    "        await context.hostApi.executeAction('save-note', { note: 'hello' }, { signal: context.signal });",
    "        currentStatus = 'saved';",
    '        renderStatus(root, currentStatus, currentSurface);',
    '      } catch {',
    "        currentStatus = 'actionFailed';",
    '        renderStatus(root, currentStatus, currentSurface);',
    '      }',
    '    })();',
    '  });',
    '}',
    '',
    "if (typeof window !== 'undefined') {",
    '  void (async () => {',
    '    let surface: SurfaceContext | null = null;',
    '    try {',
    '      const context = await createPluginUiRenderContext();',
    '      surface = context.surface;',
    '      await bootstrapHostedWebSurface(context);',
    '    } catch {',
    "      renderStatus(ensureRoot(), 'startFailed', surface);",
    '    }',
    '  })();',
    '}',
    '',
  ].join('\n');
}

function createHostedWebIndex(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <title>Happier plugin</title>',
    '  </head>',
    '  <body>',
    '    <main id="root"></main>',
    '    <script type="module" src="./assets/app.js"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
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
    '// This exact export is compiled once for web, iOS, and Android.',
    'export const renderSurface = defineUiSurface(MainSurface);',
    '',
  ].join('\n');
}

export async function scaffoldLocalPlugin(params: Readonly<{
  targetDir: string;
  baseDir?: string;
  pluginId: string;
  displayName: string;
  invokerName?: string;
  ui?: PluginScaffoldUiMode;
  template?: PluginScaffoldTemplate;
}>): Promise<ScaffoldLocalPluginResult> {
  const rawTargetDir = params.targetDir.trim();
  const pluginId = params.pluginId.trim();
  const displayName = params.displayName.trim();
  const template = params.template;
  /**
   * An author who expresses no UI preference gets the declarative surface: it
   * renders on every platform with no bundler, no UI dependency tree and no
   * build step, so the first `happier plugins create` produces something
   * visible rather than an action-only package. `session-agent` is a different
   * starting shape that deliberately contributes no surface, so it keeps none.
   */
  const ui = params.ui ?? (template === 'session-agent' ? undefined : DEFAULT_PLUGIN_SCAFFOLD_UI_MODE);
  const invokerName = params.invokerName?.trim() || 'happier';

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
      diagnostics: [createDiagnostic(
        'plugin_scaffold_invalid_input',
        `--ui requires one of: ${PluginScaffoldUiModeSchema.options.join(', ')}`,
      )],
    };
  }
  if (template !== undefined && !PluginScaffoldTemplateSchema.safeParse(template).success) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'Only --template session-agent is supported for plugin scaffolds')],
    };
  }
  if (template === 'session-agent' && params.ui !== undefined) {
    return {
      ok: false,
      diagnostics: [createDiagnostic('plugin_scaffold_invalid_input', 'The session-agent template does not include a UI surface; omit --ui')],
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
  const uiSurfaceModulePath = join(targetDir, ...MAIN_SURFACE_MODULE_RELATIVE_PATH.split('/'));
  const sessionAgentEntryPath = template === 'session-agent'
    ? join(targetDir, 'src', 'agent', 'sessionAgent.ts')
    : undefined;

  try {
    await mkdir(join(targetDir, 'src'), { recursive: true });
    await mkdir(join(targetDir, 'test'), { recursive: true });
    await mkdir(join(targetDir, ...PLUGIN_AUTHORING_SKILL_DIRECTORY), { recursive: true });
    // Every UI mode owns `src/ui/surfaces.ts`; only the executable modes also
    // own an entry module beside it.
    if (ui !== undefined) {
      await mkdir(join(targetDir, 'src', 'ui'), { recursive: true });
    }
    if (sessionAgentEntryPath) {
      await mkdir(join(targetDir, 'src', 'agent'), { recursive: true });
    }
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(createPackageJson({
        packageName: sanitizePackageName(pluginId),
        displayName,
        invokerName,
        ui,
      }), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      sourceEntryPath,
      template === 'session-agent'
        ? createSessionAgentPluginSource({ pluginId, displayName, version: DEFAULT_PLUGIN_VERSION })
        : createPluginSource({ pluginId, displayName, ui }),
      'utf8',
    );
    await writeFile(
      testEntryPath,
      template === 'session-agent'
        ? createSessionAgentTestSource()
        : createPluginTestSource({ pluginId, displayName, ui }),
      'utf8',
    );
    if (sessionAgentEntryPath) {
      await writeFile(sessionAgentEntryPath, createSessionAgentRunnerSource(), 'utf8');
    }
    await writeFile(tsconfigPath, createTypeScriptConfig(), 'utf8');
    await writeFile(authoringSkillPath, createPluginAuthoringSkillSource(invokerName, ui), 'utf8');
    if (ui !== undefined) {
      await writeFile(
        uiSurfaceModulePath,
        createPluginUiSurfaceModuleSource({ pluginId, displayName, ui }),
        'utf8',
      );
    }
    if (uiEntryPath) {
      if (ui === 'hostedWeb') {
        await mkdir(join(targetDir, ...HOSTED_WEB_SOURCE_ROOT.split('/')), { recursive: true });
        await writeFile(join(targetDir, ...HOSTED_WEB_INDEX_ENTRY.split('/')), createHostedWebIndex(), 'utf8');
      }
      await writeFile(
        uiEntryPath,
        ui === 'hostedWeb'
          ? createHostedWebSource({ displayName })
          : createReactNativeSurfaceSource({ displayName }),
        'utf8',
      );
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
