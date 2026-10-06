import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
    const serial = spawnSync(process.execPath, [resolve('scripts/workspaces/runTypeScriptCli.mjs'),
      ...names.flatMap((name) => ['--project', join(fixtureDir, `tsconfig.${name}.json`)]),
      '--pretty', 'false', '--listFiles'], {
      cwd: fixtureDir, encoding: 'utf8',
      env: { ...process.env, CI: 'true', HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS: '1' },
    });
    assert.equal(serial.status, 0, serial.stdout + serial.stderr);
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
