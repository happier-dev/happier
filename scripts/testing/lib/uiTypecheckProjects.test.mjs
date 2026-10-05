import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { resolveTypeScriptCliInvocation } from '../../workspaces/resolveTypeScriptCliInvocation.mjs';

const uiDir = resolve('apps/ui');
function readProject(name) {
  const configPath = join(uiDir, name);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error && ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    undefined, `${name} must exist and parse`);
  const project = ts.parseJsonConfigFileContent(config.config, ts.sys, uiDir, undefined, configPath);
  assert.deepEqual(project.errors, []);
  return project;
}

test('UI projects preserve every original root exactly once, except shared declarations', () => {
  const original = readProject('tsconfig.json');
  const source = readProject('tsconfig.source.json');
  const tests = readProject('tsconfig.test.json');
  const originalRoots = new Set(original.fileNames);
  const sourceRoots = new Set(source.fileNames.filter((file) => originalRoots.has(file)));
  const testRoots = new Set(tests.fileNames.filter((file) => originalRoots.has(file)));
  assert.deepEqual([...new Set([...sourceRoots, ...testRoots])].sort(), [...originalRoots].sort());
  assert.deepEqual([...sourceRoots].filter((file) => testRoots.has(file)).sort(),
    original.fileNames.filter((file) => file.endsWith('.d.ts')).sort());
  for (const project of [source, tests]) {
    for (const key of ['strict', 'skipLibCheck', 'target', 'module', 'moduleResolution', 'jsx',
      'isolatedModules', 'resolveJsonModule', 'allowJs', 'customConditions', 'lib', 'paths']) {
      assert.deepEqual(project.options[key], original.options[key], `preserve ${key}`);
    }
  }
  assert.equal(source.options.composite, true);
  assert.equal(source.options.emitDeclarationOnly, true);
  assert.equal(source.options.noEmit, false);
  assert.equal(tests.options.noEmit, true);
  assert.equal(tests.options.disableSourceOfProjectReferenceRedirect, true);
  assert.deepEqual(tests.projectReferences.map(({ path }) => path), [join(uiDir, 'tsconfig.source.json')]);
});

test('native UI project boundary checks source and test types without rechecking source implementations', () => {
  const sourceConfig = ts.readConfigFile(join(uiDir, 'tsconfig.source.json'), ts.sys.readFile).config;
  const testConfig = ts.readConfigFile(join(uiDir, 'tsconfig.test.json'), ts.sys.readFile).config;
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-ui-typecheck-'));
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: uiDir });
  const run = (project, extra = []) => spawnSync(invocation.command,
    [...invocation.argsPrefix, '--project', join(fixtureDir, project), '--pretty', 'false', ...extra],
    { encoding: 'utf8', cwd: fixtureDir });
  try {
    const options = { types: [], paths: { '@/*': ['./sources/*'] }, rootDir: '.' };
    write('tsconfig.source.json', JSON.stringify({
      extends: join(uiDir, 'tsconfig.json'),
      compilerOptions: { ...options, ...sourceConfig.compilerOptions,
        rootDir: '.', outDir: './cache/source', tsBuildInfoFile: './cache/source.tsbuildinfo' },
      files: ['node_modules/fixture-native-package/src/index.ts'],
      include: ['sources/**/*.ts', 'external/**/*.ts', 'external/**/*.json'], exclude: ['**/*.test.ts'],
    }));
    write('tsconfig.test.json', JSON.stringify({
      extends: join(uiDir, 'tsconfig.json'),
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
});
