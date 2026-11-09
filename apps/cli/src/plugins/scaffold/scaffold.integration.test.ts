import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { describe, expect, it } from 'vitest';
import { scaffoldLocalPlugin } from './scaffold';
import { packLocalPlugin } from '../packaging/pack';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { PLUGIN_UI_HOST_METHODS_V1 } from '@happier-dev/protocol/plugins/ui';
import { definePlugin, type PluginApi } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import * as ts from 'typescript';
import { resolveNativeTypeScriptBin, runPluginAuthorToolchain } from '../authoring/toolchain';

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

async function copyPublicSdk(targetDir: string): Promise<void> {
  const packageScope = join(targetDir, 'node_modules', '@happier-dev');
  const source = fileURLToPath(new URL('../../../../../packages/plugin-sdk', import.meta.url));
  const destination = join(packageScope, 'plugin-sdk');
  await mkdir(packageScope, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => !entry.split('/').includes('node_modules'),
  });
  await symlink(join(source, 'node_modules'), join(destination, 'node_modules'), 'dir');
}

async function linkPublicPluginUi(targetDir: string): Promise<void> {
  const packageScope = join(targetDir,
  'node_modules',
  '@happier-dev');
  await mkdir(packageScope,
  { recursive: true });
  const source = fileURLToPath(new URL('../../../../../packages/plugin-ui', import.meta.url));
  await cp(source, join(packageScope, 'plugin-ui'), {
    recursive: true,
    // A linked workspace exposes its private node_modules and lets Node pick
    // React Native's uncompiled Flow entry. A packed external author receives
    // package files only and resolves peers from the consuming project, so the
    // scaffold oracle must materialize that same physical boundary.
    filter: (entry) => !entry.split('/').includes('node_modules'),
  });
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

async function copyInstalledDependency(targetDir: string, packageName: string): Promise<void> {
  const source = fileURLToPath(new URL(`../../../../../node_modules/${packageName}`, import.meta.url));
  const destination = join(targetDir, 'node_modules', ...packageName.split('/'));
  await mkdir(join(destination, '..'), { recursive: true });
  await cp(source, destination, { recursive: true });
}

/**
 * Type-checks the generated plugin and materializes the built output the
 * scaffold's own `entrypoints.daemon` and generated test suite expect.
 *
 * The scaffolded TypeScript config deliberately cannot emit: `happier plugins
 * author build` is the single producer of `dist/`, and a compiler emit there
 * would overwrite that self-contained bundle with a re-export module. This
 * harness therefore compiles into a scratch directory it owns and copies the
 * result into `dist/` to stand in for that build, instead of depending on the
 * two-producer collision the scaffold no longer has.
 */
async function compileGeneratedPlugin(targetDir: string): Promise<readonly ts.Diagnostic[]> {
  await linkPublicSdk(targetDir);
  const config = ts.readConfigFile(join(targetDir,
  'tsconfig.json'),
  ts.sys.readFile);
  if (config.error) return [config.error];
  const parsed = ts.parseJsonConfigFileContent(config.config,
  ts.sys,
  targetDir);
  const compilerOutDir = join(targetDir, '.tsc-out');
  const program = ts.createProgram({ rootNames: parsed.fileNames,
  options: { ...parsed.options, noEmit: false, outDir: compilerOutDir } });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) {
    program.emit();
    await cp(compilerOutDir, join(targetDir, 'dist'), { recursive: true });
  }
  return diagnostics;
}

async function runRealGeneratedPluginTest(targetDir: string) {
  return await runPluginAuthorToolchain({ operation: 'test', projectRoot: targetDir }, {
    ensureManagedPnpmCommand: async () => null,
    managedPnpmBinPath: () => '',
    buildManagedPnpmEnvironment: (environment = {}) => environment,
    ensureManagedJavaScriptRuntimeCommand: async () => process.execPath,
    managedJavaScriptRuntimeBinPath: () => process.execPath,
    resolveNativeTypeScriptBin,
    spawn: async (input) => {
      const result = spawnSync(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      return {
        exitCode: result.status,
        signal: result.signal as NodeJS.Signals | null,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    processEnv: process.env,
  });
}

function generatedUiDeclarationPropertyNames(source: string): readonly string[] {
  const sourceFile = ts.createSourceFile('generated-plugin.ts', source, ts.ScriptTarget.Latest, true);
  let uiDeclaration: ts.ObjectLiteralExpression | undefined;

  const propertyName = (property: ts.ObjectLiteralElementLike): string | undefined => (
    ts.isPropertyAssignment(property)
    && property.name !== undefined
    && ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'definePlugin'
      && ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const uiProperty = node.arguments[0].properties.find((property) => propertyName(property) === 'ui');
      if (uiProperty && ts.isPropertyAssignment(uiProperty) && ts.isObjectLiteralExpression(uiProperty.initializer)) {
        uiDeclaration = uiProperty.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (!uiDeclaration) throw new Error('Generated plugin does not declare ui through definePlugin.');
  return Object.freeze(uiDeclaration.properties.flatMap((property) => {
    const name = propertyName(property);
    return name === undefined ? [] : [name];
  }));
}

function generatedUiSurfaceReference(source: string): string {
  const sourceFile = ts.createSourceFile('generated-plugin.ts', source, ts.ScriptTarget.Latest, true);
  let surfaces: ts.ArrayLiteralExpression | undefined;

  const propertyName = (property: ts.ObjectLiteralElementLike): string | undefined => (
    ts.isPropertyAssignment(property)
    && property.name !== undefined
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? property.name.text
      : undefined
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'definePlugin'
      && ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const uiProperty = node.arguments[0].properties.find((property) => propertyName(property) === 'ui');
      if (!uiProperty || !ts.isPropertyAssignment(uiProperty) || !ts.isObjectLiteralExpression(uiProperty.initializer)) return;
      const surfacesProperty = uiProperty.initializer.properties.find((property) => propertyName(property) === 'surfaces');
      if (surfacesProperty && ts.isPropertyAssignment(surfacesProperty) && ts.isArrayLiteralExpression(surfacesProperty.initializer)) {
        surfaces = surfacesProperty.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (!surfaces || surfaces.elements.length !== 1 || !ts.isIdentifier(surfaces.elements[0])) {
    throw new Error('Generated plugin must consume one named high-level UI surface declaration.');
  }
  return surfaces.elements[0].text;
}

function generatedUiSurfaceUsesPublicDeclarationHelper(source: string, surfaceName: string): boolean {
  const sourceFile = ts.createSourceFile('generated-plugin.ts', source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === surfaceName
      && node.initializer !== undefined
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'defineUiSurfaceDefinition'
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('scaffoldLocalPlugin',
  () => {

  it('selects the generated authoring skill in the canonical packed scaffold artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-packed-skill-'));
    const targetDir = join(root, 'template-plugin');
    const archivePath = join(root, 'template-plugin.tgz');
    const extractedRoot = join(root, 'extracted');

    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir,
        pluginId: 'acme.packed-skill',
        displayName: 'Acme Packed Skill',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const packageJson = await readJsonFile<Record<string, unknown>>(scaffold.packageJsonPath);
      expect(packageJson.files).toEqual(['.agents/skills/happier-plugin-authoring', 'dist']);

      // This focused archive assertion is about package-file selection, not
      // SDK resolution. Keep the canonical pack operation's package-root path
      // and the scaffold-emitted canonical SDK runtime dependency declaration
      // while using an SDK-import-free author module.
      delete packageJson.devDependencies;
      await writeFile(scaffold.packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
      await writeFile(scaffold.sourceEntryPath, [
        'export const manifest = {',
        "  schemaVersion: 2, id: 'acme.packed-skill', version: '0.1.0',",
        "  displayName: 'Acme Packed Skill', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
        '  contributes: {},',
        '};',
        'export function activate() {}',
        '',
      ].join('\n'), 'utf8');
      await mkdir(join(targetDir, 'dist'), { recursive: true });
      await writeFile(join(targetDir, 'dist', 'index.js'), 'export function activate() {}\n', 'utf8');

      const packed = await packLocalPlugin({ locator: targetDir, outPath: archivePath });
      expect(packed, packed.ok ? '' : packed.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.packed-skill' });

      await mkdir(extractedRoot);
      await tar.x({ file: archivePath, cwd: extractedRoot });
      const packedRoot = join(extractedRoot, 'package');
      await expect(readFile(
        join(packedRoot, '.agents', 'skills', 'happier-plugin-authoring', 'SKILL.md'),
        'utf8',
      )).resolves.toContain('happier plugins change status <pendingChangeId>');
      const packagedManifest = await readFile(join(packedRoot, '.happier-plugin', 'plugin.json'), 'utf8');
      const packagedPackageJson = await readJsonFile<{
        happier?: Readonly<{ marketplaceDiscovery?: unknown }>;
      }>(join(packedRoot, 'package.json'));
      expect(packagedPackageJson.happier?.marketplaceDiscovery).toEqual({
        version: 1,
        pluginId: 'acme.packed-skill',
        manifestDigest: `sha256:${createHash('sha256').update(packagedManifest).digest('hex')}`,
        display: { title: 'Acme Packed Skill', description: null },
        summary: {
          contributions: [],
          requiredHostAccess: [],
          optionalHostAccess: [],
          executableRealms: ['daemon'],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('scaffoldLocalPlugin',
  () => {

  it('scaffolds the maintained custom Session Agent shape without a manual example copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-session-agent-'));
    const targetDir = join(root, 'session-agent-plugin');

    try {
      const result = await scaffoldLocalPlugin({
        targetDir,
        pluginId: 'acme.session-agent',
        displayName: 'Acme Session Agent',
        template: 'session-agent',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [source, runner, testSource] = await Promise.all([
        readFile(result.sourceEntryPath, 'utf8'),
        readFile(join(targetDir, 'src', 'agent', 'sessionAgent.ts'), 'utf8'),
        readFile(join(targetDir, 'test', 'index.test.mjs'), 'utf8'),
      ]);
      expect(source).toContain('id: "acme.session-agent"');
      expect(source).toContain('displayName: "Acme Session Agent"');
      expect(source).toContain('"session-agent": {');
      expect(source).toContain('module: "./agent/sessionAgent.js"');
      expect(source).toContain('export: "createSessionAgentRuntime"');
      expect(source).not.toContain('save-note');
      expect(runner).toContain("from '@happier-dev/plugin-sdk/agents/runtime'");
      expect(runner).toContain('export const createSessionAgentRuntime: AgentRuntimeFactory');
      expect(runner).not.toMatch(/@happier-dev\/(?:protocol|agents)\b|plugin-sdk\/internal\b|from ['"]@\//u);
      expect(testSource).toContain('sessionRunnerFactory');
      expect(testSource).not.toContain('save-note');

      expect(await compileGeneratedPlugin(targetDir)).toEqual([]);
      const generatedSuite = spawnSync(
        process.execPath,
        ['--test', 'test/index.test.mjs'],
        { cwd: targetDir, encoding: 'utf8' },
      );
      expect(generatedSuite.status, `${generatedSuite.stdout}\n${generatedSuite.stderr}`).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits only the code-defined contribution-derived activation ABI', async () => {
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
    expect(source.match(/definePlugin\(/gu)).toHaveLength(1);
    expect(source.match(/api\.actions\.register\(/gu) ?? []).toHaveLength(0);
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
      manifest: unknown;
      activate(api: PluginApi): void;
    };
    const parsedManifest = parsePluginManifest(compiledModule.manifest);
    expect(parsedManifest.ok).toBe(true);
    if (!parsedManifest.ok) throw new Error('Expected generated manifest to parse.');
    const manifest = parsedManifest.manifest;
    // Compare with the former explicit declaration through the real author
    // helper: dropping defaults must preserve the entire projected Action.
    const explicit = definePlugin({
      id: 'acme.template',
      version: '0.1.0',
      displayName: 'Acme Template',
      actions: {
        'save-note': {
          title: 'Save note',
          description: 'Returns the supplied note from one minimal plugin action.',
          scopes: ['global'],
          surfaces: ['agent', 'cli', 'mcp', 'ui'],
          execution: { target: 'daemon' },
          placementBindings: ['commandPalette'],
          dangerLevel: 'safe',
          inputSchema: defineProtocolObject({ note: defineProtocolString() }, { policy: 'closed' }),
          resultSchema: defineProtocolObject({ note: defineProtocolString() }, { policy: 'closed' }),
          async run(input) { return { note: input.note }; },
        },
      },
    });
    expect(manifest.contributes.actions).toEqual(explicit.manifest.contributes.actions);
    expect(manifest.engines).toBeUndefined();
    // The default scaffold shape is the declarative surface, so `save-note` is
    // reachable from the UI it ships with as well as from the headless surfaces.
    expect(manifest.contributes.actions.find(({ id }) => id === 'save-note')?.surfaces)
      .toEqual(['agent', 'cli', 'mcp', 'ui']);
    // …and the whole point of that default is that it costs no build: a
    // declarative renderer is projected from the manifest, so the scaffold
    // declares no UI artifact and emits no build config for a bundler to run.
    expect(manifest.contributes.ui.renderers.map(({ kind }) => kind)).toEqual(['declarative']);
    await expect(readFile(join(targetDir, 'pluginUiBuild.ts'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(manifest.contributes.actions.find(({ id }) => id === 'save-note'))
      .toHaveProperty('execution', { target: 'daemon' });
    expect(manifest.contributes.actions.find(({ id }) => id === 'save-note'))
      .toHaveProperty('placementBindings', ['commandPalette']);
    const testkit = await createPluginTestkit({
      manifest,
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
    expect(config.config.compilerOptions).toMatchObject({
      incremental: true,
      tsBuildInfoFile: 'node_modules/.cache/happier/plugin-author.tsbuildinfo',
    });
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, targetDir);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('scaffolds a TypeScript config whose compiler cannot overwrite the daemon bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-emit-'));
    const targetDir = join(root, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // `happier plugins dev build` writes the self-contained daemon bundle to
    // the manifest's declared daemon entry. Read that entry from the scaffolded
    // source so this contract follows the scaffold instead of restating it.
    const scaffoldedSource = await readFile(result.sourceEntryPath, 'utf8');
    const declaredDaemon = /daemon:\s*'([^']+)'/u.exec(scaffoldedSource)?.[1];
    if (!declaredDaemon) throw new Error('Scaffolded plugin source must declare entrypoints.daemon');
    const daemonPath = join(targetDir, ...declaredDaemon.replace(/^\.\//u, '').split('/'));
    const bundleBytes = '// self-contained daemon bundle\nexport function activate() {}\n';
    await mkdir(join(daemonPath, '..'), { recursive: true });
    await writeFile(daemonPath, bundleBytes, 'utf8');

    await linkPublicSdk(targetDir);
    await linkInstalledDependency(targetDir, '@types/node');

    const config = ts.readConfigFile(join(targetDir, 'tsconfig.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, targetDir);
    expect(parsed.errors).toEqual([]);
    ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options }).emit();

    // The compiler runs even when the project does not type-check, so the
    // surviving bytes — not a diagnostic count — are the contract.
    expect(await readFile(daemonPath, 'utf8')).toBe(bundleBytes);
    await rm(root, { recursive: true, force: true });
  });

  it('emits a complete buildable hostedWeb bridge application', async () => {
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

    const source = await readFile(result.sourceEntryPath, 'utf8');
    // Generated authoring uses the one high-level UI declaration. Its compiled
    // manifest below proves the actual projected view/renderer/host-method
    // facts, so this AST check cannot be replaced by a raw parallel form.
    expect(generatedUiDeclarationPropertyNames(source)).toEqual(['surfaces', 'translations']);
    const surfaceName = generatedUiSurfaceReference(source);
    expect(surfaceName).toBe('mainSurface');
    // The manifest projection and conventional artifact directory derive from
    // this one `defineUiSurfaceDefinition(...)` call.
    expect(generatedUiSurfaceUsesPublicDeclarationHelper(
      await readFile(join(targetDir, 'src', 'ui', 'surfaces.ts'), 'utf8'),
      surfaceName,
    )).toBe(true);
    expect(generatedUiSurfaceUsesPublicDeclarationHelper(source, surfaceName)).toBe(false);
    expect(source).toContain("locale: 'en'");
    expect(source).toContain("locale: 'fr'");
    expect(await readJsonFile(join(targetDir, 'assets/i18n/en.json'))).toMatchObject({
      'scaffold.main.greeting': 'Hello from Acme Template',
    });

    // The hosted-web arm must ship a real bridge application, not an inert
    // title-only stub: a client entry that negotiates the public host API and
    // creates the document shell staged by the SDK-owned compiler.
    expect(result.uiEntryPath).toBe(join(
      targetDir,
      '.happier-plugin',
      'ui',
      'hosted-web',
      'main-renderer',
      'entry.ts',
    ));
    const uiSource = await readFile(result.uiEntryPath as string, 'utf8');
    expect(uiSource).toContain("createPluginUiRenderContext,");
    expect(uiSource).toContain("from '@happier-dev/plugin-sdk/ui/client';");
    expect(uiSource).not.toContain('Hosted web stub');
    expect(uiSource).toContain("document.createElement('main')");
    // The strict bootstrap owns launch context. A generated hosted surface
    // must not teach URL/sub-path parsing or treat a launch payload as action
    // input; actions declare their own stable sample input instead.
    expect(uiSource).not.toContain('context.subPath');
    expect(uiSource).not.toContain('context.launchInput');
    expect(uiSource).toContain("surface.translations['scaffold.main.greeting']");

    // §3.12: a scaffold is a real hosted-web application, not a title-only
    // document. It must call an action, apply the semantic theme through the
    // `--happier-plugin-*` custom properties the host cannot inject into an
    // isolated realm, and show its own loading and error states.
    expect(uiSource).toContain('applyPluginUiThemeCssVariables');
    expect(uiSource).toContain("executeAction('save-note'");
    expect(uiSource).toContain("'loading'");
    expect(uiSource).toContain("'error'");

    // UI-D16 / EU-8: the scaffold may call only methods in the sole canonical
    // tuple. The host still advertises only the factual installed subset, so a
    // call to an unavailable capability is rejected during negotiation/use.
    const calledHostMethods = [...uiSource.matchAll(/\bhostApi\.(\w+)\s*\(/gu)]
      .map(([, method]) => method as string)
      .filter((method) => method !== 'version');
    expect(calledHostMethods).toContain('executeAction');
    expect(calledHostMethods).toContain('watchContext');
    expect(calledHostMethods.filter(
      (method) => !(PLUGIN_UI_HOST_METHODS_V1 as readonly string[]).includes(method),
    )).toEqual([]);

    // A generated hosted surface receives the retirement signal from the
    // host-issued render context. It must carry that signal through both an
    // acknowledged subscription and its Action request, otherwise a retired
    // frame can leave an establishment or mutation running against an obsolete
    // generation.
    expect(uiSource).toContain('currentSurface = surface;');
    expect(uiSource).toContain('renderStatus(root, currentStatus, currentSurface);');
    expect(uiSource).toContain('}, { signal: context.signal });');
    expect(uiSource).toContain(
      "await context.hostApi.executeAction('save-note', { note: 'hello' }, { signal: context.signal });",
    );

    // Hosted static bytes live under the manifest-owned conventional directory.
    await expect(readFile(join(targetDir, 'index.html'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(targetDir, 'vite.config.mjs'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const packageJson = await readJsonFile<Record<string, unknown>>(join(targetDir, 'package.json'));
    expect(packageJson).toMatchObject({
      scripts: { 'build:ui': 'happier-plugin-build-ui --project-root .' },
      devDependencies: {
        typescript: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.typescript,
        react: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies.react,
      },
    });

    // One surface declaration owns the artifact identity; source bytes use the
    // matching conventional directory without author-owned build config.
    const uiSurfaceModuleSource = await readFile(join(targetDir, 'src', 'ui', 'surfaces.ts'), 'utf8');
    expect(uiSurfaceModuleSource).toContain('defineUiSurfaceDefinition');
    await expect(readFile(join(targetDir, 'pluginUiBuild.ts'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(targetDir, '.happier-plugin', 'ui', 'hosted-web', 'main-renderer', 'index.html'), 'utf8'))
      .toContain('<script type="module" src="./assets/app.js"></script>');
    expect(await readFile(join(targetDir, '.happier-plugin', 'ui', 'hosted-web', 'main-renderer', 'entry.ts'), 'utf8'))
      .toContain('createPluginUiRenderContext');

    const testSource = await readFile(join(targetDir, 'test', 'index.test.mjs'), 'utf8');
    expect(testSource).toContain("import { activate, mainSurface, manifest } from '../dist/index.js';");
    expect(testSource).toContain("test('hostedWeb UI definition projects the public app surface and action launcher'");
    expect(testSource).toContain("surface: 'ui'");
    expect(testSource).toContain('createPluginUiTestkit');
    expect(testSource).toContain('createSurfaceContextFixture');
    expect(testSource).toContain("import('../dist/happier-plugin-ui/hosted-web/main-renderer/assets/app.js')");
    expect(testSource).toContain('bootstrapHostedWebSurface');
    expect(testSource).toContain('adapter:');
    expect(testSource).not.toMatch(/(?:apps|packages)\//u);
    expect(testSource).not.toContain('react-test-renderer');

    await copyPublicSdk(targetDir);
    await copyInstalledDependency(targetDir, '@typescript/native');
    await copyInstalledDependency(
      targetDir,
      `@typescript/typescript-${process.platform}-${process.arch}`,
    );
    await linkInstalledDependency(targetDir, '@types/node');
    await linkInstalledDependency(targetDir, 'typescript');
    await linkInstalledDependency(targetDir, 'esbuild');
    const toolchainResult = await runRealGeneratedPluginTest(targetDir);
    expect(toolchainResult, JSON.stringify(toolchainResult, null, 2))
      .toMatchObject({ ok: true, operation: 'test', projectRoot: targetDir });
    await expect(readFile(
      join(targetDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'),
      'utf8',
    )).resolves.toContain('main-renderer');
    const hostedWebModule = await import(pathToFileURL(join(targetDir, 'dist', 'index.js')).href) as {
      manifest: unknown;
    };
    const hostedWebManifest = PluginManifestV2Schema.parse(hostedWebModule.manifest);
    expect(hostedWebManifest.contributes.actions.find(({ id }) => id === 'save-note')?.surfaces)
      .toContain('ui');
    expect(hostedWebManifest.contributes.actions.find(({ id }) => id === 'save-note'))
      .toHaveProperty('placementBindings', ['commandPalette']);
    expect(hostedWebManifest.contributes.ui.views).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'main',
        container: 'appPage',
        target: { kind: 'app' },
        renderer: 'main-renderer',
        title: { key: 'scaffold.main.title', fallback: 'Acme Template' },
      }),
    ]));
    expect(hostedWebManifest.contributes.ui?.translations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        locale: 'fr',
        resourceId: 'i18n-fr',
      }),
    ]));
    expect(hostedWebManifest.contributes.resources).toContainEqual({
      id: 'i18n-fr', kind: 'asset', path: 'assets/i18n/fr.json', contentType: 'application/json',
    });
    expect(await readJsonFile(join(targetDir, 'assets/i18n/fr.json'))).toMatchObject({
      'scaffold.main.greeting': 'Bonjour de Acme Template',
    });
    expect(hostedWebManifest.contributes.ui.renderers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'main-renderer',
        kind: 'hostedWeb',
        source: { kind: 'artifact', artifact: 'main-renderer' },
        requiredHostMethods: ['context', 'executeAction'],
      }),
    ]));

    await expect(readFile(join(targetDir, 'pluginUiBuild.ts'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }, 180_000);

  it('emits a semantic React Native surface and every declared Preview artifact', async () => {
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

    const source = await readFile(result.sourceEntryPath, 'utf8');
    expect(generatedUiDeclarationPropertyNames(source)).toEqual(['surfaces', 'translations']);
    const surfaceName = generatedUiSurfaceReference(source);
    expect(surfaceName).toBe('mainSurface');
    // The manifest projection and exact package export derive from this one
    // `defineUiSurfaceDefinition(...)` call.
    expect(generatedUiSurfaceUsesPublicDeclarationHelper(
      await readFile(join(targetDir, 'src', 'ui', 'surfaces.ts'), 'utf8'),
      surfaceName,
    )).toBe(true);
    expect(generatedUiSurfaceUsesPublicDeclarationHelper(source, surfaceName)).toBe(false);
    expect(source).toContain("locale: 'en'");
    expect(source).toContain("locale: 'fr'");
    expect(await readJsonFile(join(targetDir, 'assets/i18n/en.json'))).toMatchObject({
      'scaffold.main.greeting': 'Hello from Acme Template',
    });

    expect(result.uiEntryPath).toBe(join(targetDir, 'src', 'ui', 'renderSurface.tsx'));
    const uiSource = await readFile(result.uiEntryPath as string, 'utf8');
    // A beginner RN project is a public `plugin-ui` consumer, not a raw
    // react-native sample. `defineUiSurface` owns provider installation
    // so authors cannot accidentally introduce a second host/context owner.
    expect(uiSource).toContain("from '@happier-dev/plugin-ui';");
    expect(uiSource).toContain('defineUiSurface');
    expect(uiSource).toContain('usePluginTranslation');
    expect(uiSource).toContain("translate('scaffold.main.greeting'");
    expect(uiSource).toContain('<Action.Execute');
    expect(uiSource).toContain('export const renderSurface = defineUiSurface');
    expect(uiSource).not.toContain("from 'react-native'");
    await linkPublicPluginUi(targetDir);
    await linkInstalledDependency(
      targetDir,
      'react',
      fileURLToPath(new URL('../../../../../packages/plugins/inspector/node_modules/react', import.meta.url)),
    );
    await linkInstalledDependency(
      targetDir,
      'react-native',
      // The generated semantic test is a Node/RNW consumer; resolve the same
      // public imports through the RNW platform alias.
      fileURLToPath(new URL('../../../../../packages/plugins/inspector/node_modules/react-native-web', import.meta.url)),
    );
    await linkInstalledDependency(
      targetDir,
      '@types/react',
      fileURLToPath(new URL('../../../../../packages/plugins/inspector/node_modules/@types/react', import.meta.url)),
    );
    expect(await compileGeneratedPlugin(targetDir)).toEqual([]);
    const reactNativeModule = await import(pathToFileURL(join(targetDir, 'dist', 'index.js')).href) as {
      manifest: unknown;
    };
    const reactNativeManifest = PluginManifestV2Schema.parse(reactNativeModule.manifest);
    expect(reactNativeManifest.contributes.actions.find(({ id }) => id === 'save-note')?.surfaces)
      .toContain('ui');
    expect(reactNativeManifest.contributes.ui.views).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'main',
        container: 'appPage',
        target: { kind: 'app' },
        renderer: 'main-renderer',
        title: { key: 'scaffold.main.title', fallback: 'Acme Template' },
      }),
    ]));
    expect(reactNativeManifest.contributes.ui?.translations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        locale: 'fr',
        resourceId: 'i18n-fr',
      }),
    ]));
    expect(reactNativeManifest.contributes.resources).toContainEqual({
      id: 'i18n-fr', kind: 'asset', path: 'assets/i18n/fr.json', contentType: 'application/json',
    });
    expect(await readJsonFile(join(targetDir, 'assets/i18n/fr.json'))).toMatchObject({
      'scaffold.main.greeting': 'Bonjour de Acme Template',
    });
    expect(reactNativeManifest.contributes.ui.renderers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'main-renderer',
        kind: 'reactNative',
        artifact: 'main-renderer',
        requiredHostMethods: ['context', 'executeAction'],
      }),
    ]));

    const packageJson = await readJsonFile<Record<string, unknown>>(join(targetDir, 'package.json'));
    expect(packageJson).toMatchObject({
      scripts: {
        'build:ui': 'happier-plugin-build-ui --project-root .',
      },
      dependencies: {
        '@happier-dev/plugin-ui': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-ui'],
        react: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies.react,
        'react-dom': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-dom'],
        'react-native': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-native'],
        'react-native-web': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['react-native-web'],
      },
      devDependencies: {
        typescript: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.typescript,
        '@types/react': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/react'],
      },
    });
    await expect(readFile(join(targetDir, 'vite.config.mjs'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(targetDir, 'rspack.config.mjs'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(targetDir, 'react-native.config.cjs'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const uiSurfaceModule = await readFile(join(targetDir, 'src', 'ui', 'surfaces.ts'), 'utf8');
    expect(uiSurfaceModule).toContain('defineUiSurfaceDefinition');
    await expect(readFile(join(targetDir, 'pluginUiBuild.ts'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const testSource = await readFile(join(targetDir, 'test', 'index.test.mjs'), 'utf8');
    expect(testSource).toContain("import { activate, mainSurface, manifest } from '../dist/index.js';");
    expect(testSource).toContain("test('reactNative UI definition projects the public app surface and action launcher'");
    expect(testSource).toContain("surface: 'ui'");
    expect(testSource).toContain('createPluginUiTestkit');
    expect(testSource).toContain('createSurfaceContextFixture');
    // `happier plugins test` invokes this public test through Node's native
    // runner. The DOM-backed RNW semantic proof is owned by the established
    // jsdom scaffold harness, not by a template-local document substitute.
    expect(testSource).not.toContain("from '@happier-dev/plugin-ui/testing'");
    expect(testSource).not.toContain("from '../dist/ui/renderSurface.js'");
    expect(testSource).not.toContain('createPluginUiRnwSemanticSurfaceAdapter');
    expect(testSource).not.toContain('../src/');
    expect(testSource).not.toMatch(/(?:apps|packages)\//u);
    expect(testSource).not.toContain('react-test-renderer');
    const tsconfig = await readJsonFile<{ compilerOptions?: { jsx?: string }; include?: string[] }>(join(targetDir, 'tsconfig.json'));
    expect(tsconfig.compilerOptions?.jsx).toBe('react');
    expect(tsconfig.include).toContain('src/**/*.tsx');
    const generatedSuite = spawnSync(
      process.execPath,
      ['--test', 'test/index.test.mjs'],
      { cwd: targetDir, encoding: 'utf8' },
    );
    expect(
      generatedSuite.status,
      `${generatedSuite.stdout}\n${generatedSuite.stderr}`,
    ).toBe(0);
  });
});
