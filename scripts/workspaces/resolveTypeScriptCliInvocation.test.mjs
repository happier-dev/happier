import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  resolveTypeScriptCliInvocation,
  shouldRouteTypeScriptCliThroughHstack,
} from './resolveTypeScriptCliInvocation.mjs';

test('routes direct no-emit compilation through hstack but executes an admitted payload directly', () => {
  assert.equal(shouldRouteTypeScriptCliThroughHstack({
    args: ['--noEmit', '-p', 'tsconfig.json'],
    env: {},
  }), true);
  assert.equal(shouldRouteTypeScriptCliThroughHstack({
    args: ['--noEmit'],
    env: { HAPPIER_DEV_TARGET_EXECUTION: '1' },
  }), false);
  assert.equal(shouldRouteTypeScriptCliThroughHstack({
    args: ['--noEmit'],
    env: { HAPPIER_HSTACK_EXECUTION: '1' },
  }), false);
  assert.equal(shouldRouteTypeScriptCliThroughHstack({
    args: ['-p', 'tsconfig.json', '--outDir', 'dist'],
    env: {},
  }), false);
});

test('resolves the native TypeScript CLI from its exported package manifest', () => {
  const resolutions = [];
  const invocation = resolveTypeScriptCliInvocation({
    processExecPath: '/managed/node',
    requireResolve(specifier) {
      resolutions.push(specifier);
      return '/repo/node_modules/@typescript/native/package.json';
    },
    readFileSyncImpl(path, encoding) {
      assert.equal(path, '/repo/node_modules/@typescript/native/package.json');
      assert.equal(encoding, 'utf8');
      return JSON.stringify({ bin: { tsc: './bin/tsc' } });
    },
  });

  assert.deepEqual(resolutions, ['@typescript/native/package.json']);
  assert.deepEqual(invocation, {
    command: '/managed/node',
    argsPrefix: ['/repo/node_modules/@typescript/native/bin/tsc'],
  });
});

test('fails closed when the native package does not declare a tsc entrypoint', () => {
  assert.throws(
    () => resolveTypeScriptCliInvocation({
      requireResolve: () => '/repo/node_modules/@typescript/native/package.json',
      readFileSyncImpl: () => JSON.stringify({ bin: {} }),
    }),
    /does not declare a tsc binary/i,
  );
});

test('checks every requested project sequentially even when source checking fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-typecheck-projects-'));
  try {
    writeFileSync(join(root, 'source.ts'), 'export const sourceValue: number = "wrong";\n');
    writeFileSync(join(root, 'case.test.ts'), 'export const testValue: number = "wrong";\n');
    for (const [name, file] of [['source', 'source.ts'], ['tests', 'case.test.ts']]) {
      writeFileSync(join(root, `${name}.json`), JSON.stringify({
        compilerOptions: { strict: true, types: [], noEmit: true },
        files: [file],
      }));
    }
    const runner = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      runner,
      '--project', join(root, 'source.json'),
      '--project', join(root, 'tests.json'),
      '--noEmit', '--pretty', 'false',
    ], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /source\.ts\(1,14\): error TS2322/u);
    assert.match(result.stdout, /case\.test\.ts\(1,14\): error TS2322/u);
    assert.ok(result.stdout.indexOf('source.ts(1,14)') < result.stdout.indexOf('case.test.ts(1,14)'));
    writeFileSync(join(root, 'case.test.ts'), 'export const testValue: number = 2;\n');
    const sourceFailure = spawnSync(process.execPath, [
      runner, '--project', join(root, 'source.json'),
      '--project', join(root, 'tests.json'), '--noEmit', '--pretty', 'false',
    ], { encoding: 'utf8' });
    assert.ifError(sourceFailure.error);
    assert.equal(sourceFailure.status, 1, 'a later passing project must not hide an earlier failure');
    assert.match(sourceFailure.stdout, /source\.ts\(1,14\): error TS2322/u);
    assert.doesNotMatch(sourceFailure.stdout, /case\.test\.ts\(1,14\): error TS2322/u);
    writeFileSync(join(root, 'source.ts'), 'export const sourceValue: number = 1;\n');
    const green = spawnSync(process.execPath, [
      runner, `--project=${join(root, 'source.json')}`,
      '-p', join(root, 'tests.json'), '--noEmit',
    ], { encoding: 'utf8' });
    assert.ifError(green.error);
    assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI source/test projects retain the full root-file and ambient coverage', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const isTest = (path) => /\.(?:test|spec)\.tsx?$/u.test(path)
    || path.replaceAll('\\', '/').includes('/__tests__/');
  for (const app of ['cli']) {
    const root = join(repoRoot, 'apps', app);
    const readProject = (name) => {
      const parsed = ts.getParsedCommandLineOfConfigFile(join(root, name), {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
          assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      });
      assert.deepEqual(parsed.errors, []);
      return parsed;
    };
    const original = readProject('tsconfig.json');
    assert.equal(original.fileNames.some(isTest), true, `${app} inherited base config lost test roots`);
    const source = readProject('tsconfig.source.json');
    assert.equal(source.fileNames.some(isTest), false, `${app} source roots still include tests`);
    const tests = readProject('tsconfig.test.json');
    const union = new Set([...source.fileNames, ...tests.fileNames]);
    const originalRoots = new Set(original.fileNames);
    assert.deepEqual({
      missing: [...originalRoots].filter((path) => !union.has(path)),
      added: [...union].filter((path) => !originalRoots.has(path)),
    }, { missing: [], added: [] }, `${app} root coverage changed`);
    for (const path of original.fileNames.filter((path) => path.endsWith('.d.ts'))) {
      assert.ok(source.fileNames.includes(path), `${app} source lost ambient ${path}`);
      assert.ok(tests.fileNames.includes(path), `${app} tests lost ambient ${path}`);
    }
    for (const option of ['strict', 'skipLibCheck', 'types', 'paths', 'lib', 'jsx', 'moduleResolution']) {
      assert.deepEqual(tests.options[option], source.options[option], `${app} ${option} changed`);
    }
    assert.notEqual(tests.options.tsBuildInfoFile, source.options.tsBuildInfoFile);
  }
});
