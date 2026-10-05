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
  assertProjectCoverage(resolve('apps/cli'), ['tsconfig.source.json']);
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
    if (process.platform === 'linux') {
      const measured = spawnSync(process.execPath, [
        resolve('scripts/workspaces/runTypeScriptCli.mjs'),
        '--project', join(fixtureDir, 'tsconfig.source.json'),
        '--project', join(fixtureDir, 'tsconfig.test.json'),
        '--pretty', 'false',
      ], {
        cwd: fixtureDir, encoding: 'utf8',
        env: { ...process.env, CI: 'true', HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS: '1' },
      });
      assert.equal(measured.status, 0, measured.stdout + measured.stderr);
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
    const files = { foundation: ['foundation.ts', 'flags.json'], core: ['left.ts', 'right.ts', downstreamImplementation],
      source: ['entry.ts'], test: ['entry.test.ts'] };
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const actual = ts.readConfigFile(join(uiDir, `tsconfig.${name}.json`), ts.sys.readFile).config;
      write(`tsconfig.${name}.json`, JSON.stringify({
        extends: join(uiDir, 'tsconfig.json'),
        compilerOptions: { ...actual.compilerOptions, types: [], paths: {}, rootDir: '.',
          outDir: `./cache/${name}`, tsBuildInfoFile: `./cache/${name}.tsbuildinfo` },
        ...(index ? { references: [{ path: `./tsconfig.${names[index - 1]}.json` }] } : {}),
        files: [...files[name], 'ambient.d.ts'],
        include: name === 'foundation' || name === 'core' ? actual.include
          : name === 'source' ? [moduleDeclaration] : [], exclude: [],
      }));
    }
    write('ambient.d.ts', 'declare const fixtureAmbient: string;\n');
    // A module declaration belongs to the downstream source project, not the
    // shared ambient roots: its type import must not pull core into foundation.
    write(moduleDeclaration, "import type { bridge } from './desktopActivityOverlayBridge'; export declare const fixtureBridge: typeof bridge;\n");
    write(downstreamImplementation, "export { left as bridge } from '../../../../../left';\n");
    write('flags.json', '{"enabled":true}');
    write('foundation.ts', "import flags from './flags.json'; export const label: string = 'ok'; export const enabled = flags.enabled;\n");
    write('left.ts', "import { label } from './foundation'; import { right } from './right'; export function left(): string { return label + right; }\n");
    write('right.ts', "import { left } from './left'; export const right: number = 'bad'; export const invoke = () => left();\n");
    write('entry.ts', "import { left } from './left'; import { label } from './foundation'; import { fixtureBridge } from './sources/activity/adapters/desktop/runtime/desktopActivityOverlayQaFixtures'; export const value = left() + label + fixtureAmbient + fixtureBridge();\n");
    write('entry.test.ts', "import { value } from './entry'; import { left } from './left'; import { label } from './foundation'; const result: number = value + left() + label;\n");
    const foundation = run('foundation');
    assert.equal(foundation.status, 0, foundation.stdout + foundation.stderr);
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
    const uiPackage = JSON.parse(readFileSync(join(uiDir, 'package.json'), 'utf8'));
    const [command, owner, ...compilerArgs] = uiPackage.scripts['typecheck:source:finite'].trim().split(/\s+/u);
    assert.equal(command, 'node');
    assert.equal(resolve(uiDir, owner), resolve('scripts/workspaces/runTypeScriptCli.mjs'));
    const projects = [];
    const fixtureArgs = compilerArgs.map((arg, index) => {
      if (compilerArgs[index - 1] !== '--project') return arg;
      projects.push(arg);
      return join(fixtureDir, arg);
    });
    assert.deepEqual(projects, names.map((name) => `tsconfig.${name}.json`));
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
    const runPublicCommand = () => spawnSync(process.execPath, [resolve(uiDir, owner), ...fixtureArgs], {
      cwd: fixtureDir, encoding: 'utf8',
      env: { ...process.env, CI: 'true', HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` },
    });
    write('right.ts', "import { left } from './left'; export const right: number = 'bad'; export const invoke = () => left();\n");
    write('entry.test.ts', "import { value } from './entry'; import { left } from './left'; import { label } from './foundation'; const result: number = value + left() + label;\n");
    const publicRed = runPublicCommand();
    assert.notEqual(publicRed.status, 0);
    assert.match(publicRed.stdout + publicRed.stderr, /right\.ts.*TS2322/u);
    assert.match(publicRed.stdout + publicRed.stderr, /entry\.test\.ts.*TS2322/u);
    write('right.ts', "import { left } from './left'; export const right: string = 'ok'; export const invoke = () => left();\n");
    write('entry.test.ts', "import { value } from './entry'; import { left } from './left'; import { label } from './foundation'; const result: string = value + left() + label;\n");
    write('compiler-spawns.jsonl', '');
    const serial = runPublicCommand();
    assert.equal(serial.status, 0, serial.stdout + serial.stderr);
    const nativeCalls = readFileSync(spawnLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(nativeCalls.map((args) => args[args.indexOf('--project') + 1]),
      projects.map((project) => join(fixtureDir, project)));
    for (const args of nativeCalls) {
      const checkerOption = args.indexOf('--singleThreaded');
      assert.equal(args.filter((arg) => arg === '--singleThreaded').length, 1);
      assert.ok(checkerOption >= 0 && args[checkerOption + 1] !== 'false',
        'each UI project must execute the native compiler with one checker');
    }
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
