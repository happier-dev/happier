import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
