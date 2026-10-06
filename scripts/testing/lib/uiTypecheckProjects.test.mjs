import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { resolveTypeScriptCliInvocation } from '../../workspaces/resolveTypeScriptCliInvocation.mjs';

const uiDir = resolve('apps/ui');
function readProject(name, packageDir = uiDir) {
  const configPath = join(packageDir, name);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error && ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    undefined, `${name} must exist and parse`);
  const project = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir, undefined, configPath);
  assert.deepEqual(project.errors, []);
  return project;
}

function isSharedDeclaration(file) {
  if (!file.endsWith('.d.ts')) return false;
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return !ts.isExternalModule(source) || source.statements.some((statement) =>
    ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name)
      || Boolean(statement.flags & ts.NodeFlags.GlobalAugmentation)));
}

function publicFiniteCompiler(packageDir, fixtureDir, write, invocation) {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const [command, owner, ...compilerArgs] = pkg.scripts['typecheck:source:finite'].trim().split(/\s+/u);
  assert.equal(command, 'node');
  assert.equal(resolve(packageDir, owner), resolve('scripts/workspaces/runTypeScriptCli.mjs'));
  const projects = [];
  const fixtureArgs = compilerArgs.map((arg, index) => {
    if (!['--project', '-p'].includes(compilerArgs[index - 1])) return arg;
    projects.push(arg);
    return join(fixtureDir, arg);
  });
  const spawnLog = join(fixtureDir, 'compiler-spawns.jsonl');
  const preload = join(fixtureDir, 'record-compiler-spawns.cjs');
  // Observe only the genuine OS spawn boundary; execute the native compiler
  // unchanged, including the measured Linux adapter's compiler invocation.
  write('record-compiler-spawns.cjs', `
    const cp = require('node:child_process');
    const spawn = cp.spawn;
    cp.spawn = function(command, args, options) {
      const compilerArgs = command === process.execPath && args[0] === ${JSON.stringify(invocation.argsPrefix[0])}
        ? args.slice(1)
        : command === 'python3' && args[3] === ${JSON.stringify(invocation.argsPrefix[0])}
          ? args.slice(4) : null;
      if (compilerArgs) require('node:fs').appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(compilerArgs) + '\\n');
      return spawn(command, args, options);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  return {
    projects,
    run: () => spawnSync(process.execPath, [resolve(packageDir, owner), ...fixtureArgs], {
      cwd: fixtureDir, encoding: 'utf8',
      env: { ...process.env, CI: 'true', HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` },
    }),
    nativeCalls: () => readFileSync(spawnLog, 'utf8').trim().split('\n').map(JSON.parse),
  };
}

function assertOneCheckerInvocations(nativeCalls, projects) {
  assert.deepEqual(nativeCalls.map((args) => args[args.findIndex((arg) => arg === '--project' || arg === '-p') + 1]), projects);
  for (const args of nativeCalls) {
    const checkerOption = args.indexOf('--singleThreaded');
    assert.equal(args.filter((arg) => arg === '--singleThreaded').length, 1,
      'each host project must execute the native compiler with one checker');
    assert.ok(checkerOption >= 0 && args[checkerOption + 1] !== 'false',
      'each host project must execute the native compiler with one checker');
  }
}

function assertProjectCoverage(packageDir, sourceNames) {
  const original = readProject('tsconfig.json', packageDir);
  const sources = sourceNames.map((name) => readProject(name, packageDir));
  const tests = readProject('tsconfig.test.json', packageDir);
  const originalRoots = new Set(original.fileNames);
  const projects = [...sources, tests];
  const counts = new Map();
  for (const project of projects) {
    for (const file of project.fileNames.filter((file) => originalRoots.has(file))) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    const plumbing = new Set(['configFilePath', 'composite', 'noEmit', 'emitDeclarationOnly',
      'rootDir', 'outDir', 'tsBuildInfoFile', 'disableSourceOfProjectReferenceRedirect']);
    const strictOptions = (options) => Object.fromEntries(Object.entries(options)
      .filter(([key]) => !plumbing.has(key)));
    assert.deepEqual(strictOptions(project.options), strictOptions(original.options));
  }
  assert.deepEqual([...counts.keys()].sort(), [...originalRoots].sort());
  for (const [file, count] of counts) assert.equal(count, isSharedDeclaration(file) ? projects.length : 1, file);
  for (const source of sources) {
    assert.equal(source.options.composite, true);
    assert.equal(source.options.emitDeclarationOnly, true);
    assert.equal(source.options.noEmit, false);
  }
  assert.equal(tests.options.noEmit, true);
  assert.equal(tests.options.disableSourceOfProjectReferenceRedirect, true);
  assert.deepEqual(tests.projectReferences.map(({ path }) => path), [join(packageDir, 'tsconfig.source.json')]);
}

test('UI projects preserve every original root exactly once, except shared declarations', () => {
  assertProjectCoverage(uiDir, ['tsconfig.foundation.json', 'tsconfig.core.json', 'tsconfig.source.json']);
});

test('native UI source emission leaves test-only Protocol and SDK fixtures in the noEmit project', () => {
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: uiDir });
  const inputs = (name) => {
    const result = spawnSync(invocation.command, [...invocation.argsPrefix,
      '--project', join(uiDir, `tsconfig.${name}.json`), '--listFilesOnly'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim().split(/\r?\n/u).map((file) => resolve(file.trim()));
  };
  const sourceInputs = inputs('source');
  const protocolDir = resolve('packages/protocol/src') + '/';
  const authorFixtureDirs = ['packages/plugin-sdk/examples/', 'packages/plugin-sdk/fixtures/']
    .map((dir) => resolve(dir) + '/');
  assert.deepEqual(sourceInputs.filter((file) => file.startsWith(protocolDir)), [],
    'Protocol authored schemas reached only from UI tests/configuration must not be declaration-emitted by UI');
  assert.deepEqual(sourceInputs.filter((file) => authorFixtureDirs.some((dir) => file.startsWith(dir))), [],
    'authoring examples and test fixtures belong to semantic checking, not app declaration publication');
  const testOnlyRoots = [
    'vitest.config.ts', 'vitest.integration.config.ts',
    'vitest.legend-native.config.ts', 'vitest.legend-fabric.config.ts',
    'sources/dev/testkit/fixtures/pluginWidgetProjectionFixtures.ts',
  ].map((file) => join(uiDir, file));
  assert.ok(testOnlyRoots.every((file) => !sourceInputs.includes(file)));
  const testInputs = inputs('test');
  assert.ok(testOnlyRoots.every((file) => testInputs.includes(file)),
    'each original test/configuration root must still be checked');
  assert.ok(testInputs.some((file) => file.startsWith(protocolDir)));
  assert.ok(testInputs.some((file) => authorFixtureDirs.some((dir) => file.startsWith(dir))));
  const verifiedEmail = resolve('packages/protocol/src/auth/verifiedEmail.ts');
  assert.ok(testInputs.includes(verifiedEmail),
    'the retained Board testkit imports must still check verified-mailbox normalization');
  const ambientRoots = readProject('tsconfig.test.json').fileNames
    .filter((file) => file.startsWith(protocolDir) && isSharedDeclaration(file));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-ui-test-protocol-ambient-'));
  try {
    const config = join(fixtureDir, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({
      extends: join(uiDir, 'tsconfig.test.json'),
      compilerOptions: { tsBuildInfoFile: join(fixtureDir, 'types.tsbuildinfo') },
      references: [], include: [], files: [verifiedEmail, ...ambientRoots],
    }));
    // Check the real reachable owner with the test project's canonical ambient roots,
    // without declaration emission or the app's full semantic graph.
    const semantic = spawnSync(invocation.command, [...invocation.argsPrefix,
      '--noEmit', '--project', config, '--pretty', 'false'], { encoding: 'utf8' });
    assert.equal(semantic.status, 0, semantic.stdout + semantic.stderr);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

for (const name of ['foundation', 'core']) {
  test(`native UI ${name} partition loads shared theme and breakpoint augmentation`, () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-ui-theme-types-'));
    const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: uiDir });
    const actual = ts.readConfigFile(join(uiDir, `tsconfig.${name}.json`), ts.sys.readFile).config;
    const base = ts.readConfigFile(join(uiDir, 'tsconfig.json'), ts.sys.readFile).config;
    const write = (file, content) => {
      mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
      writeFileSync(join(fixtureDir, file), content);
    };
    const run = () => spawnSync(invocation.command,
      [...invocation.argsPrefix, '--project', join(fixtureDir, 'tsconfig.json'), '--pretty', 'false'],
      { encoding: 'utf8', cwd: fixtureDir });
    try {
      // Keep the installed library's real augmentation seam and the partition's
      // real include rules; only replace the app Theme's large runtime closure.
      const paths = Object.fromEntries(Object.entries(base.compilerOptions.paths)
        .map(([key, values]) => [key, values.map((value) => resolve(uiDir, value))]));
      paths['@/*'] = ['./sources/*'];
      write('tsconfig.json', JSON.stringify({
        extends: join(uiDir, 'tsconfig.json'),
        compilerOptions: { ...actual.compilerOptions, types: [], paths, rootDir: '.',
          outDir: './cache', tsBuildInfoFile: './cache/types.tsbuildinfo' },
        files: ['sources/theme.ts', 'sources/consumer.ts', 'sources/adapter.ts'], include: actual.include, exclude: [],
      }));
      for (const file of readdirSync(join(uiDir, 'sources/types')).filter((file) => file.endsWith('.d.ts'))) {
        const content = readFileSync(join(uiDir, 'sources/types', file), 'utf8');
        const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
        if (source.statements.some((statement) => ts.isModuleDeclaration(statement)
          && ts.isStringLiteral(statement.name) && statement.name.text === 'react-native-unistyles')) {
          write(`sources/types/${file}`, content);
        }
      }
      write('sources/theme.ts', 'export type Theme = { dark: boolean; colors: { surface: { base: string } } };\n');
      // Compile the actual owner expression and its public adapter type without
      // importing the app's persistence and theme-profile runtime graph.
      const runtimePath = join(uiDir, 'sources/theme/profiles/themeProfileRuntime.ts');
      const runtimeSource = ts.createSourceFile(runtimePath, readFileSync(runtimePath, 'utf8'), ts.ScriptTarget.Latest, true);
      const adapterType = runtimeSource.statements.find((statement) => ts.isTypeAliasDeclaration(statement)
        && statement.name.text === 'ThemeRuntimeUnistylesAdapter');
      const adapter = runtimeSource.statements.filter(ts.isVariableStatement)
        .flatMap((statement) => [...statement.declarationList.declarations])
        .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'defaultUnistylesRuntimeAdapter');
      const getTheme = adapter.initializer.properties.find((property) => property.name.getText(runtimeSource) === 'getTheme');
      write('sources/adapter.ts', "import { UnistylesRuntime } from 'react-native-unistyles'; import type { Theme } from './theme';\n"
        + "type AppThemeName = 'light' | 'dark';\n" + adapterType.getText(runtimeSource)
        + "\nexport const adapter: Pick<ThemeRuntimeUnistylesAdapter, 'getTheme'> = { " + getTheme.getText(runtimeSource) + ' };\n');
      const consumer = "import { StyleSheet, UnistylesRuntime, type UnistylesThemes, type UnistylesBreakpoints } from 'react-native-unistyles';\n"
        + "import { adapter } from './adapter'; export const color: string = adapter.getTheme('light').colors.surface.base;\n"
        + "export const styles = StyleSheet.create(theme => ({ root: { backgroundColor: theme.colors.surface.base } }));\n"
        + "export const light: keyof UnistylesThemes = 'light'; export const dark: keyof UnistylesThemes = 'dark';\n"
        + "export const lg: UnistylesBreakpoints['lg'] = 800; UnistylesRuntime.setTheme(light);\n";
      write('sources/consumer.ts', consumer);
      const green = run();
      assert.equal(green.status, 0, green.stdout + green.stderr);
      write('sources/consumer.ts', consumer + "export const unsupported: keyof UnistylesThemes = 'unknown'; adapter.getTheme('unknown');\n");
      const invalidTheme = run();
      assert.notEqual(invalidTheme.status, 0);
      assert.match(invalidTheme.stdout + invalidTheme.stderr, /consumer\.ts.*TS2322/u);
      assert.match(invalidTheme.stdout + invalidTheme.stderr, /consumer\.ts.*TS2345/u);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
}

test('CLI projects preserve every original root and compiler strictness', () => {
  const packageDir = resolve('apps/cli');
  assertProjectCoverage(packageDir, ['tsconfig.source.json']);
  const original = readProject('tsconfig.json', packageDir);
  const source = readProject('tsconfig.source.json', packageDir);
  const tests = readProject('tsconfig.test.json', packageDir);
  const isTest = (path) => /\.(?:test|spec)\.tsx?$/u.test(path)
    || path.replaceAll('\\', '/').includes('/__tests__/');
  assert.equal(original.fileNames.some(isTest), true, 'inherited CLI project must contain test roots');
  assert.equal(source.fileNames.some(isTest), false, 'CLI source must not declaration-emit test roots');
  for (const file of original.fileNames.filter(isTest)) {
    assert.ok(tests.fileNames.includes(file), `CLI test project lost ${file}`);
  }
  assert.notEqual(tests.options.tsBuildInfoFile, source.options.tsBuildInfoFile);
});

function assertNativeProjectBoundary(packageDir) {
  const sourceConfig = ts.readConfigFile(join(packageDir, 'tsconfig.source.json'), ts.sys.readFile).config;
  const testConfig = ts.readConfigFile(join(packageDir, 'tsconfig.test.json'), ts.sys.readFile).config;
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-ui-typecheck-'));
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: packageDir });
  const run = (project, extra = []) => spawnSync(invocation.command,
    [...invocation.argsPrefix, '--project', join(fixtureDir, project), '--pretty', 'false', ...extra],
    { encoding: 'utf8', cwd: fixtureDir });
  try {
    const options = { types: [], paths: { '@/*': ['./sources/*'] }, rootDir: '.' };
    write('tsconfig.source.json', JSON.stringify({
      extends: join(packageDir, 'tsconfig.json'),
      compilerOptions: { ...options, ...sourceConfig.compilerOptions,
        rootDir: '.', outDir: './cache/source', tsBuildInfoFile: './cache/source.tsbuildinfo' },
      files: ['node_modules/fixture-native-package/src/index.ts'],
      include: ['sources/**/*.ts', 'external/**/*.ts', 'external/**/*.json'], exclude: ['**/*.test.ts'],
    }));
    write('tsconfig.test.json', JSON.stringify({
      extends: join(packageDir, 'tsconfig.json'),
      compilerOptions: { ...options, ...testConfig.compilerOptions,
        rootDir: '.', tsBuildInfoFile: './cache/test.tsbuildinfo' },
      references: [{ path: './tsconfig.source.json' }],
      include: ['sources/**/*.test.ts', 'sources/**/*.d.ts'],
    }));
    write('external/value.ts', "export const label = 'ok';\n");
    write('external/value.json', '{"enabled":true}');
    // Several installed UI packages expose authored TypeScript as their types.
    // Direct test imports must consume the same declaration boundary as UI code.
    write('node_modules/fixture-native-package/package.json', JSON.stringify({
      name: 'fixture-native-package', types: './src/index.ts',
    }));
    write('node_modules/fixture-native-package/src/index.ts', "export const dependencyLabel: string = 'dependency';\n");
    write('sources/model.ts', 'export interface Model { label: string }; export const model: Model = { label: 42 };\n');
    write('sources/augment.d.ts', "import './model'; declare module './model' { interface Model { enabled?: boolean } }\n");
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; const valid: Model = { label: 'ok', enabled: true }; const label: string = model.label;\n");
    const sourceRed = run('tsconfig.source.json');
    assert.notEqual(sourceRed.status, 0);
    assert.match(sourceRed.stdout + sourceRed.stderr, /model\.ts.*TS2322/u);
    write('sources/model.ts', "import { label } from '../external/value'; import flags from '../external/value.json'; import { dependencyLabel } from 'fixture-native-package'; export interface Model { label: string }; export const model: Model = { label }; export const enabled = flags.enabled; export const dependency = dependencyLabel;\n");
    const sourceGreen = run('tsconfig.source.json');
    assert.equal(sourceGreen.status, 0, sourceGreen.stdout + sourceGreen.stderr);
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; const valid: Model = { label: 'ok', enabled: true }; const label: number = model.label;\n");
    const testRed = run('tsconfig.test.json');
    assert.notEqual(testRed.status, 0);
    assert.match(testRed.stdout + testRed.stderr, /model\.test\.ts.*TS2322/u);
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; import { dependencyLabel } from 'fixture-native-package'; const valid: Model = { label: 'ok', enabled: true }; const label: string = model.label; const dependency: string = dependencyLabel;\n");
    const testGreen = run('tsconfig.test.json', ['--listFiles']);
    assert.equal(testGreen.status, 0, testGreen.stdout + testGreen.stderr);
    const files = testGreen.stdout.split(/\r?\n/u).map((file) => resolve(file.trim()));
    assert.ok(files.includes(join(fixtureDir, 'cache/source/sources/model.d.ts')));
    assert.ok(files.includes(join(fixtureDir, 'sources/augment.d.ts')));
    assert.ok(!files.includes(join(fixtureDir, 'sources/model.ts')));
    assert.ok(!files.includes(join(fixtureDir, 'external/value.ts')));
    assert.ok(!files.includes(join(fixtureDir, 'node_modules/fixture-native-package/src/index.ts')),
      'authored dependency TypeScript must not be checked in both projects');
    const publicCompiler = publicFiniteCompiler(packageDir, fixtureDir, write, invocation);
    assert.deepEqual(publicCompiler.projects, ['tsconfig.source.json', 'tsconfig.test.json']);
    write('sources/model.ts', 'export interface Model { label: string }; export const model: Model = { label: 42 };\n');
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; const valid: Model = { label: 'ok', enabled: true }; const label: number = model.label;\n");
    const publicRed = publicCompiler.run();
    assert.notEqual(publicRed.status, 0);
    assert.match(publicRed.stdout + publicRed.stderr, /model\.ts.*TS2322/u);
    assert.match(publicRed.stdout + publicRed.stderr, /model\.test\.ts.*TS2322/u);
    write('sources/model.ts', "import { label } from '../external/value'; import flags from '../external/value.json'; import { dependencyLabel } from 'fixture-native-package'; export interface Model { label: string }; export const model: Model = { label }; export const enabled = flags.enabled; export const dependency = dependencyLabel;\n");
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; import { dependencyLabel } from 'fixture-native-package'; const valid: Model = { label: 'ok', enabled: true }; const label: string = model.label; const dependency: string = dependencyLabel;\n");
    write('compiler-spawns.jsonl', '');
    const measured = publicCompiler.run();
    assert.equal(measured.status, 0, measured.stdout + measured.stderr);
    assertOneCheckerInvocations(publicCompiler.nativeCalls(),
      publicCompiler.projects.map((project) => join(fixtureDir, project)));
    if (process.platform === 'linux') {
      const reports = measured.stderr.split('\n').filter((line) => line.startsWith('[typescript] {'))
        .map((line) => JSON.parse(line.slice('[typescript] '.length)));
      assert.deepEqual(reports.map(({ project, status, signal }) => ({ project, status, signal })), [
        { project: join(fixtureDir, 'tsconfig.source.json'), status: 0, signal: null },
        { project: join(fixtureDir, 'tsconfig.test.json'), status: 0, signal: null },
      ]);
      assert.ok(reports.every(({ maxRssKiB }) => maxRssKiB > 0));
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test('native UI projects redirect direct and transitive imports across the complete serial boundary', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-ui-transitive-'));
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: uiDir });
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  const run = (name, extra = []) => spawnSync(invocation.command,
    [...invocation.argsPrefix, '--project', join(fixtureDir, `tsconfig.${name}.json`),
      '--pretty', 'false', ...extra], { encoding: 'utf8', cwd: fixtureDir });
  try {
    const names = ['foundation', 'core', 'source', 'test'];
    const moduleDeclaration = 'sources/activity/adapters/desktop/runtime/desktopActivityOverlayQaFixtures.d.ts';
    const downstreamImplementation = 'sources/activity/adapters/desktop/runtime/desktopActivityOverlayBridge.ts';
    const files = { foundation: ['foundation.ts', 'flags.json', 'theme.ts'], core: ['left.ts', 'right.ts', downstreamImplementation],
      source: ['entry.ts'], test: ['entry.test.ts'] };
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const actual = ts.readConfigFile(join(uiDir, `tsconfig.${name}.json`), ts.sys.readFile).config;
      write(`tsconfig.${name}.json`, JSON.stringify({
        extends: join(uiDir, 'tsconfig.json'),
        compilerOptions: { ...actual.compilerOptions, types: [], paths: {
          'react-native-unistyles': ['./node_modules/fixture-unistyles/index.d.ts'],
          '@/theme': ['./theme.ts'],
        }, rootDir: '.',
          outDir: `./cache/${name}`, tsBuildInfoFile: `./cache/${name}.tsbuildinfo` },
        ...(index ? { references: [{ path: `./tsconfig.${names[index - 1]}.json` }] } : {}),
        files: [...files[name], 'ambient.d.ts'],
        include: name === 'foundation' || name === 'core' ? actual.include
          : name === 'source' ? [moduleDeclaration] : [], exclude: [],
      }));
    }
    write('ambient.d.ts', 'declare const fixtureAmbient: string;\n');
    write('node_modules/fixture-unistyles/index.d.ts', 'export interface UnistylesThemes {}\nexport type Theme = UnistylesThemes[keyof UnistylesThemes];\n');
    // Shared augmentation must be present even before downstream runtime setup
    // entrypoints are compiled, without importing those implementations.
    write('sources/types/unistyles.d.ts', readFileSync(join(uiDir, 'sources/types/unistyles.d.ts'), 'utf8'));
    write('theme.ts', 'export interface Theme { colors: { primary: string } }\n');
    // A module declaration belongs to the downstream source project, not the
    // shared ambient roots: its type import must not pull core into foundation.
    write(moduleDeclaration, "import type { bridge } from './desktopActivityOverlayBridge'; export declare const fixtureBridge: typeof bridge;\n");
    write(downstreamImplementation, "export { left as bridge } from '../../../../../left';\n");
    write('flags.json', '{"enabled":true}');
    write('foundation.ts', "import flags from './flags.json'; import type { Theme } from 'react-native-unistyles'; export const label: string = 'ok'; export const enabled = flags.enabled; export function themeColor(theme: Theme): string { return theme.colors.primary; }\n");
    write('left.ts', "import { label } from './foundation'; import { right } from './right'; export function left(): string { return label + right; }\n");
    write('right.ts', "import { left } from './left'; export const right: number = 'bad'; export const invoke = () => left();\n");
    write('entry.ts', "import { left } from './left'; import { label } from './foundation'; import { fixtureBridge } from './sources/activity/adapters/desktop/runtime/desktopActivityOverlayQaFixtures'; export const value = left() + label + fixtureAmbient + fixtureBridge();\n");
    write('entry.test.ts', "import { value } from './entry'; import { left } from './left'; import { label } from './foundation'; const result: number = value + left() + label;\n");
    const foundation = run('foundation');
    assert.equal(foundation.status, 0, foundation.stdout + foundation.stderr);
    const foundationText = readFileSync(join(fixtureDir, 'foundation.ts'), 'utf8');
    write('foundation.ts', foundationText.replace('themeColor(theme: Theme): string', 'themeColor(theme: Theme): number'));
    const themeRed = run('foundation');
    assert.notEqual(themeRed.status, 0);
    assert.match(themeRed.stdout + themeRed.stderr, /foundation\.ts.*TS2322/u);
    write('foundation.ts', foundationText);
    const themeGreen = run('foundation');
    assert.equal(themeGreen.status, 0, themeGreen.stdout + themeGreen.stderr);
    const coreRed = run('core');
    assert.notEqual(coreRed.status, 0);
    assert.match(coreRed.stdout + coreRed.stderr, /right\.ts.*TS2322/u);
    write('right.ts', "import { left } from './left'; export const right: string = 'ok'; export const invoke = () => left();\n");
    for (const name of ['core', 'source']) {
      const green = run(name, ['--listFiles']);
      assert.equal(green.status, 0, green.stdout + green.stderr);
      const inputs = green.stdout.split(/\r?\n/u).map((file) => resolve(file.trim()));
      assert.ok(inputs.includes(join(fixtureDir, 'cache/foundation/foundation.d.ts')));
      assert.ok(!inputs.includes(join(fixtureDir, 'foundation.ts')));
      if (name === 'source') {
        assert.ok(inputs.includes(join(fixtureDir, 'cache/core/left.d.ts')));
        assert.ok(!inputs.includes(join(fixtureDir, 'left.ts')));
      }
    }
    const testRed = run('test');
    assert.notEqual(testRed.status, 0);
    assert.match(testRed.stdout + testRed.stderr, /entry\.test\.ts.*TS2322/u);
    write('entry.test.ts', "import { value } from './entry'; import { left } from './left'; import { label } from './foundation'; const result: string = value + left() + label;\n");
    const publicCompiler = publicFiniteCompiler(uiDir, fixtureDir, write, invocation);
    assert.deepEqual(publicCompiler.projects, names.map((name) => `tsconfig.${name}.json`));
    write('right.ts', "import { left } from './left'; export const right: number = 'bad'; export const invoke = () => left();\n");
    write('entry.test.ts', "import { value } from './entry'; import { left } from './left'; import { label } from './foundation'; const result: number = value + left() + label;\n");
    const publicRed = publicCompiler.run();
    assert.notEqual(publicRed.status, 0);
    assert.match(publicRed.stdout + publicRed.stderr, /right\.ts.*TS2322/u);
    assert.match(publicRed.stdout + publicRed.stderr, /entry\.test\.ts.*TS2322/u);
    write('right.ts', "import { left } from './left'; export const right: string = 'ok'; export const invoke = () => left();\n");
    write('entry.test.ts', "import { value } from './entry'; import { left } from './left'; import { label } from './foundation'; const result: string = value + left() + label;\n");
    write('compiler-spawns.jsonl', '');
    const serial = publicCompiler.run();
    assert.equal(serial.status, 0, serial.stdout + serial.stderr);
    assertOneCheckerInvocations(publicCompiler.nativeCalls(),
      publicCompiler.projects.map((project) => join(fixtureDir, project)));
    const testGreen = run('test', ['--listFiles']);
    assert.equal(testGreen.status, 0, testGreen.stdout + testGreen.stderr);
    const inputs = testGreen.stdout.split(/\r?\n/u).map((file) => resolve(file.trim()));
    for (const [name, file] of [['foundation', 'foundation'], ['core', 'left'], ['source', 'entry']]) {
      assert.ok(inputs.includes(join(fixtureDir, `cache/${name}/${file}.d.ts`)));
      assert.ok(!inputs.includes(join(fixtureDir, `${file}.ts`)));
    }
    if (process.platform === 'linux') {
      const reports = serial.stderr.split('\n').filter((line) => line.startsWith('[typescript] {'))
        .map((line) => JSON.parse(line.slice('[typescript] '.length)));
      assert.deepEqual(reports.map(({ project }) => project),
        names.map((name) => join(fixtureDir, `tsconfig.${name}.json`)));
      assert.ok(reports.every(({ maxRssKiB, status }) => maxRssKiB > 0 && status === 0));
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('native CLI project boundary checks source and test types without rechecking source implementations', () => {
  assertNativeProjectBoundary(resolve('apps/cli'));
});

test('native test-package checker keeps source, suite and configuration semantic coverage with one checker', () => {
  const packageDir = resolve('packages/tests');
  const actual = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile).config;
  const cacheDir = resolve('node_modules/.cache');
  mkdirSync(cacheDir, { recursive: true });
  const fixtureDir = mkdtempSync(join(cacheDir, 'happier-tests-typecheck-'));
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: packageDir });
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  try {
    write('tsconfig.json', JSON.stringify({
      ...actual,
      compilerOptions: { ...actual.compilerOptions, types: [], paths: {},
        tsBuildInfoFile: './cache/tests.tsbuildinfo' },
    }));
    write('src/model.ts', "export const label: string = 'ok';\n");
    write('src/environment.d.ts', 'declare const fixtureEnvironment: string;\n');
    write('suites/model.test.ts', "import { label } from '../src/model'; export const value: string = label + fixtureEnvironment;\n");
    write('scripts/environment.d.mts', 'declare const fixtureScriptEnvironment: string;\n');
    write('vitest.fixture.ts', 'export const label: string = fixtureScriptEnvironment;\n');
    const publicCompiler = publicFiniteCompiler(packageDir, fixtureDir, write, invocation);
    assert.deepEqual(publicCompiler.projects, ['tsconfig.json']);
    const green = publicCompiler.run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    for (const [file, content] of [
      ['src/model.ts', 'export const label: string = 42;\n'],
      ['suites/model.test.ts', "import { label } from '../src/model'; export const value: number = label + fixtureEnvironment;\n"],
      ['vitest.fixture.ts', 'export const label: number = fixtureScriptEnvironment;\n'],
    ]) {
      const original = readFileSync(join(fixtureDir, file), 'utf8');
      write(file, content);
      const red = publicCompiler.run();
      assert.notEqual(red.status, 0, file);
      assert.match(red.stdout + red.stderr, new RegExp(`${file.replaceAll('.', '\\.')}.*TS2322`, 'u'));
      write(file, original);
    }
    const restored = publicCompiler.run();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assertOneCheckerInvocations(publicCompiler.nativeCalls().slice(-1), [join(fixtureDir, 'tsconfig.json')]);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('native CLI source project includes the workspace resolver imported by UI configuration', () => {
  const packageDir = resolve('apps/cli');
  const actual = ts.readConfigFile(join(packageDir, 'tsconfig.source.json'), ts.sys.readFile).config;
  assert.ok(readProject('tsconfig.source.json', packageDir).fileNames.includes(resolve('scripts/testing/vitestWorkspacePackageResolution.ts')),
    'the composite CLI source project must explicitly own the shared resolver import');
  const cacheDir = resolve('node_modules/.cache');
  mkdirSync(cacheDir, { recursive: true });
  const fixtureDir = mkdtempSync(join(cacheDir, 'happier-cli-config-closure-'));
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  try {
    const uiConfig = ts.createSourceFile('vitest.config.ts', readFileSync(join(uiDir, 'vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const resolverImport = uiConfig.statements.find((statement) => ts.isImportDeclaration(statement)
      && statement.moduleSpecifier.text === '../../scripts/testing/vitestWorkspacePackageResolution');
    assert.ok(resolverImport, 'fixture must retain the real UI configuration import');
    write('apps/ui/vitest.config.ts', resolverImport.getText(uiConfig)
      + "\nexport const workspacePackages: readonly WorkspacePackageSpec[] = readBundledPluginWorkspacePackageSpecs('.');\n"
      + 'export const workspacePlugin = createWorkspacePackageSourcesPlugin(workspacePackages);\n');
    for (const file of ['scripts/testing/vitestWorkspacePackageResolution.ts', 'apps/cli/scripts/build-owned/bundledPluginMembership.ts']) {
      write(file, readFileSync(resolve(file), 'utf8'));
    }
    const closureFiles = new Set(['../ui/vitest.config.ts', '../../scripts/testing/vitestWorkspacePackageResolution.ts',
      'scripts/build-owned/bundledPluginMembership.ts']);
    write('apps/cli/tsconfig.source.json', JSON.stringify({
      ...actual, extends: join(packageDir, 'tsconfig.json'),
      compilerOptions: { ...actual.compilerOptions, rootDir: '../..',
        outDir: '../../cache/source', tsBuildInfoFile: '../../cache/source.tsbuildinfo' },
      files: actual.files.filter((file) => closureFiles.has(file)),
    }));
    const result = spawnSync(process.execPath, [resolve('scripts/workspaces/runTypeScriptCli.mjs'),
      '--singleThreaded', '--project', join(fixtureDir, 'apps/cli/tsconfig.source.json'), '--pretty', 'false'],
    { encoding: 'utf8', cwd: fixtureDir });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('native CLI compilation uses one SDK declaration identity across package roots and public subpaths', () => {
  const packageDir = resolve('apps/cli');
  const actual = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile).config;
  const project = readProject('tsconfig.json', packageDir);
  const sdkDir = resolve('packages/plugin-sdk');
  const sdkPackage = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
  for (const [subpath, entry] of Object.entries(sdkPackage.exports)) {
    const specifier = '@happier-dev/plugin-sdk' + (subpath === '.' ? '' : subpath.slice(1));
    const module = ts.resolveModuleName(specifier, join(packageDir, 'src/index.ts'), project.options, ts.sys).resolvedModule;
    assert.equal(module?.resolvedFileName, resolve(sdkDir, entry.types),
      `CLI must preserve the public declaration owner for ${specifier}`);
  }
  const cacheDir = resolve('node_modules/.cache');
  mkdirSync(cacheDir, { recursive: true });
  const fixtureDir = mkdtempSync(join(cacheDir, 'happier-cli-sdk-identity-'));
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  try {
    // Packaging materializes a physical CLI dependency copy. Reproduce that OS
    // layout rather than relying on the development overlay's collapsing symlink.
    const sdkManifest = { name: '@happier-dev/plugin-sdk', version: '0.0.0', type: 'module',
      exports: { '.': { types: './dist/index.d.ts' }, './ui': { types: './dist/ui/index.d.ts' },
        './ui/client': { types: './dist/ui/client/index.d.ts' } } };
    const sdkApi = 'export interface PluginApi { label: string };\n';
    for (const root of ['apps/cli/node_modules/@happier-dev/plugin-sdk', 'packages/plugin-sdk']) {
      write(`${root}/package.json`, JSON.stringify(sdkManifest));
      write(`${root}/dist/index.d.ts`, sdkApi);
      write(`${root}/dist/ui/index.d.ts`, "export type { PluginApi } from '../index.js';\n");
      write(`${root}/dist/ui/client/index.d.ts`, "export type { PluginApi } from '../../index.js';\n");
    }
    write('apps/cli/tsconfig.json', JSON.stringify({
      extends: join(packageDir, 'tsconfig.json'),
      compilerOptions: { types: [], paths: actual.compilerOptions.paths, rootDir: '../..',
        tsBuildInfoFile: '../../cache/cli.tsbuildinfo' },
      files: ['src/consumer.ts'], include: [],
    }));
    const consumer = "import type { PluginApi } from '@happier-dev/plugin-sdk';\n"
      + "import type { PluginApi as UiApi } from '@happier-dev/plugin-sdk/ui';\n"
      + "import type { PluginApi as ClientApi } from '@happier-dev/plugin-sdk/ui/client';\n"
      + "import type { PluginApi as WorkspaceApi } from '../../../packages/plugin-sdk/dist/index';\n"
      + 'declare const workspace: WorkspaceApi; export const host: PluginApi = workspace;\n'
      + 'export const ui: UiApi = host; export const client: ClientApi = ui;\n';
    write('apps/cli/src/consumer.ts', consumer);
    const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: packageDir });
    const run = () => spawnSync(invocation.command, [...invocation.argsPrefix, '--singleThreaded',
      '--project', join(fixtureDir, 'apps/cli/tsconfig.json'), '--pretty', 'false', '--listFiles'],
    { encoding: 'utf8', cwd: fixtureDir });
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    const sdkFiles = green.stdout.split(/\r?\n/u).map((file) => resolve(file.trim()))
      .filter((file) => file.includes('plugin-sdk/dist/'));
    assert.deepEqual(sdkFiles.sort(), ['index.d.ts', 'ui/index.d.ts', 'ui/client/index.d.ts']
      .map((file) => join(fixtureDir, 'packages/plugin-sdk/dist', file)).sort(),
    'all SDK imports must consume the canonical workspace declarations once');
    write('apps/cli/src/consumer.ts', consumer + 'export const invalid: number = client.label;\n');
    const red = run();
    assert.notEqual(red.status, 0);
    assert.match(red.stdout + red.stderr, /consumer\.ts.*TS2322/u);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
