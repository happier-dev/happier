import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as tar from 'tar';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { PLUGIN_UI_HOST_METHODS_V1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1,
} from '@happier-dev/plugin-sdk/ui/build';
import * as ts from 'typescript';
import { describe,
  expect,
  it } from 'vitest';

import { scaffoldLocalPlugin } from './scaffold';
import { packLocalPlugin } from '../packaging/pack';

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
  it('derives every generated dependency and compatibility fact from the public toolchain packet',
  async () => {
    const root = await mkdtemp(join(tmpdir(),
  'happier-plugin-scaffold-packed-author-'));
    const targetDir = join(root,
  'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
  pluginId: 'acme.packed-author',
  displayName: 'Acme Packed Author',
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
    expect(packageJson.dependencies).toMatchObject({
      '@happier-dev/plugin-sdk': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk'],
    });
    expect(packageJson.dependencies?.['@happier-dev/plugin-sdk']).not.toMatch(/^(?:file:|workspace:|link:|portal:)/u);
    expect(packageJson.devDependencies).toMatchObject({
      '@types/node': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/node'],
      '@typescript/native': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@typescript/native'],
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

  it('generates an external authoring skill from the public SDK packet instead of copied host contracts',
  async () => {
    const root = await mkdtemp(join(tmpdir(),
  'happier-plugin-scaffold-authoring-skill-'));
    const targetDir = join(root,
  'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
  pluginId: 'acme.authoring-skill',
  displayName: 'Acme Authoring Skill',
  });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const skill = await readFile(join(targetDir,
  '.agents',
  'skills',
  'happier-plugin-authoring',
  'SKILL.md'), 'utf8');
    const sdkVersion = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk'];
    expect(skill).toContain(`@happier-dev/plugin-sdk@${sdkVersion}`);
    expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/API.md');
    expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/capability-matrix.json');
    expect(skill).toContain('happier plugins dev');
    expect(skill).toContain('happier plugins change status <pendingChangeId>');
    expect(skill).toContain('same daemon lifetime');
    expect(skill).toContain('outcome_unknown');
    expect(skill).toContain('[cross-plugin contribution guide](/plugins/guides/cross-plugin-contributions)');
    expect(skill).not.toContain('defineContributionProtocol');
    expect(skill).not.toContain('protocol.operations');
    expect(skill).not.toMatch(/(?:^|[^A-Za-z])(?:apps|packages)\//mu);
    expect(skill).not.toContain("from '@/");
  });

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
      // while using a dependency-free author module.
      delete packageJson.dependencies;
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

  it('writes the final code-defined TypeScript dev-loop plugin template',
  async () => {
    const root = await mkdtemp(join(tmpdir(),
  'happier-plugin-scaffold-'));
    const targetDir = join(root,
  'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
  pluginId: 'acme.template',
  displayName: 'Acme Template',
  });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await expect(readFile(join(targetDir, '.happier-plugin', 'plugin.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(targetDir, '.happier-plugin', 'plugin.schema.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const source = await readFile(result.sourceEntryPath,
  'utf8');
    expect(result.sourceEntryPath).toBe(join(targetDir,
  'src',
  'index.ts'));
    expect(source).toContain("import { definePlugin } from '@happier-dev/plugin-sdk';");
    expect(source).toContain("import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';");
    expect(source).toContain('export const { manifest, activate } = definePlugin({');
    expect(source).toContain("'save-note': {");
    expect(source).toContain('inputSchema: defineProtocolObject({');
    expect(source).toContain('note: defineProtocolString()');
    expect(source).toContain('async run(input) {');
    expect(source).toContain('return { note: input.note };');
    expect(source).toContain("execution: { target: 'daemon' }");
    expect(source).toContain("placementBindings: ['commandPalette']");
    expect(source).not.toContain('engines: { happier:');
    expect(source).not.toMatch(/@happier-dev\/plugin-sdk\/runtime|export function activate|api\.actions\.register/u);
    const testSource = await readFile(join(targetDir, 'test', 'index.test.mjs'), 'utf8');
    expect(testSource).toContain("from '@happier-dev/plugin-sdk/testing'");
    expect(testSource).toContain("test('save-note returns the supplied note'");
    expect(testSource).toContain("invokeAction('save-note', { note: 'hello' })");
    const packageJson = await readJsonFile<Record<string, unknown>>(result.packageJsonPath);
    expect(packageJson).not.toHaveProperty('private');
    expect(packageJson).toMatchObject({
      happier: { manifest: '.happier-plugin/plugin.json' },
      keywords: ['happier-plugin'],
      files: ['.agents/skills/happier-plugin-authoring', 'dist'],
      dependencies: {
        '@happier-dev/plugin-sdk': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk'],
      },
    });
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
    expect(manifest.engines).toBeUndefined();
    expect(manifest.contributes.actions.find(({ id }) => id === 'save-note')?.surfaces)
      .toEqual(['agent', 'cli', 'mcp']);
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

    // `happier plugins author build` writes the self-contained daemon bundle to
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
    expect(generatedUiSurfaceUsesPublicDeclarationHelper(source, surfaceName)).toBe(true);
    expect(source).toContain("locale: 'en'");
    expect(source).toContain("locale: 'fr'");
    expect(source).toContain("'scaffold.main.greeting'");

    // The hosted-web arm must ship a real bridge application, not an inert
    // title-only stub: a client entry that negotiates the public host API and
    // creates the document shell needed by the SDK-owned operation-local Vite
    // config.
    expect(result.uiEntryPath).toBe(join(targetDir, 'src', 'ui', 'index.ts'));
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
    expect(uiSource).toContain(
      'await context.hostApi.watchContext((surface) => { render(root, surface); }, { signal: context.signal });',
    );
    expect(uiSource).toContain(
      "await context.hostApi.executeAction('save-note', { note: 'hello' }, { signal: context.signal });",
    );

    // Standard surfaces declare targets only. The SDK's one build owner
    // creates the operation-local Vite config and hosted HTML entry, so a
    // scaffold must not leave an ignored package-root document/config behind.
    await expect(readFile(join(targetDir, 'index.html'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(targetDir, 'vite.config.mjs'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const packageJson = await readJsonFile<Record<string, unknown>>(join(targetDir, 'package.json'));
    expect(packageJson).toMatchObject({
      scripts: { 'build:ui': 'happier-plugin-build-ui --project-root .' },
      devDependencies: {
        typescript: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.typescript,
        vite: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.vite,
        react: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies.react,
      },
    });

    const uiBuildConfigSource = await readFile(join(targetDir, 'pluginUiBuild.mjs'), 'utf8');
    expect(uiBuildConfigSource).toContain('defineBuildConfig');
    expect(uiBuildConfigSource).toContain("entry: 'src/ui/index.ts'");
    expect(uiBuildConfigSource).not.toContain('./dist/index.js');
    expect(uiBuildConfigSource).not.toContain('buildUiSurfaceTargets');
    expect(uiBuildConfigSource).not.toContain('createManagedRuntimeBundlerRunner');
    expect(uiBuildConfigSource).not.toContain('platforms:');
    expect(uiBuildConfigSource).not.toContain('module:');
    expect(uiBuildConfigSource).not.toContain('bundlerConfig');

    const testSource = await readFile(join(targetDir, 'test', 'index.test.mjs'), 'utf8');
    expect(testSource).toContain("import { activate, mainSurface, manifest } from '../dist/index.js';");
    expect(testSource).toContain("test('hostedWeb UI definition projects the public app surface and action launcher'");
    expect(testSource).toContain("surface: 'ui'");
    expect(testSource).toContain('createPluginUiTestkit');
    expect(testSource).toContain('createSurfaceContextFixture');
    expect(testSource).toContain("import('../dist/ui/index.js')");
    expect(testSource).toContain('bootstrapHostedWebSurface');
    expect(testSource).toContain('adapter:');
    expect(testSource).not.toMatch(/(?:apps|packages)\//u);
    expect(testSource).not.toContain('react-test-renderer');

    await linkInstalledDependency(targetDir, 'vite');
    expect(await compileGeneratedPlugin(targetDir)).toEqual([]);
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
    expect(hostedWebManifest.contributes.ui.translations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        locale: 'fr',
        messages: expect.objectContaining({
          'scaffold.main.greeting': 'Bonjour de Acme Template',
        }),
      }),
    ]));
    expect(hostedWebManifest.contributes.ui.renderers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'main-renderer',
        kind: 'hostedWeb',
        source: { kind: 'artifact', artifact: 'main-renderer' },
        requiredHostMethods: ['context', 'executeAction'],
      }),
    ]));

    const uiBuildConfigModule = await import(pathToFileURL(join(targetDir, 'pluginUiBuild.mjs')).href);
    expect(uiBuildConfigModule.default.targets).toEqual([
      { rendererId: 'main-renderer', entry: 'src/ui/index.ts', kind: 'hostedWeb' },
    ]);
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
    expect(generatedUiSurfaceUsesPublicDeclarationHelper(source, surfaceName)).toBe(true);
    expect(source).toContain("locale: 'en'");
    expect(source).toContain("locale: 'fr'");
    expect(source).toContain("'scaffold.main.greeting'");

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
      // The generated semantic test is a Node/RNW consumer. Production native
      // builds compile React Native through Re.Pack; the semantic author test
      // must resolve the same public imports through the RNW platform alias.
      fileURLToPath(new URL('../../../../../packages/plugins/inspector/node_modules/react-native-web', import.meta.url)),
    );
    await linkInstalledDependency(
      targetDir,
      '@types/react',
      fileURLToPath(new URL('../../../../../packages/plugins/inspector/node_modules/@types/react', import.meta.url)),
    );
    await linkInstalledDependency(targetDir, 'vite');
    await linkInstalledDependency(targetDir, '@vitejs/plugin-react');
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
    expect(reactNativeManifest.contributes.ui.translations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        locale: 'fr',
        messages: expect.objectContaining({
          'scaffold.main.greeting': 'Bonjour de Acme Template',
        }),
      }),
    ]));
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
        vite: PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies.vite,
        '@vitejs/plugin-react': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@vitejs/plugin-react'],
        '@types/react': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/react'],
        '@callstack/repack': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@callstack/repack'],
        '@react-native-community/cli': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@react-native-community/cli'],
        '@rspack/core': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@rspack/core'],
        '@swc/helpers': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@swc/helpers'],
      },
    });
    await expect(readFile(join(targetDir, 'vite.config.mjs'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(targetDir, 'rspack.config.mjs'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(targetDir, 'react-native.config.cjs'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const uiBuildConfig = await readFile(join(targetDir, 'pluginUiBuild.mjs'), 'utf8');
    expect(uiBuildConfig).toContain('defineBuildConfig');
    expect(uiBuildConfig).toContain("entry: 'src/ui/renderSurface.tsx'");
    expect(uiBuildConfig).not.toContain('./dist/index.js');
    expect(uiBuildConfig).not.toContain('buildUiSurfaceTargets');
    expect(uiBuildConfig).not.toContain('createManagedRuntimeBundlerRunner');
    expect(uiBuildConfig).not.toContain('bundlerConfig');
    expect(uiBuildConfig).toContain("rendererId: 'main-renderer'");
    expect(uiBuildConfig).toContain("platforms: ['web', 'ios', 'android']");
    expect(uiBuildConfig).toContain('module: {');
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
    await expect(readFile(join(targetDir, 'dist', 'index.js'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
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

      const source = await readFile(result.sourceEntryPath, 'utf8');
      expect(source).toContain("entrypoints: { daemon: './dist/index.js', development: './src/index.ts' }");
      expect(source).toContain('export const { manifest, activate } = definePlugin({');
      await expect(readFile(join(targetDir, '.happier-plugin', 'plugin.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
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
