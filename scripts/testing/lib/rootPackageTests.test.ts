import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRootScriptWorkspaceTargets } from './rootScriptWorkspaceTargets.ts';
import { selectSharedPackageTestCommands } from './sharedPackageTestCommands.ts';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));

test('root unit file selections dispatch only owning workspaces and preserve their runner prerequisites', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'happier-root-selection-'));
  try {
    const log = join(fixture, 'calls.jsonl');
    const pnpm = join(fixture, 'pnpm.cjs');
    // The package-manager process is the boundary; selection and command orchestration stay real.
    writeFileSync(pnpm, `const fs = require('node:fs');fs.appendFileSync(process.env.ROOT_TEST_CALLS, JSON.stringify(process.argv.slice(2))+'\\n');`);
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(join(fixture, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
    for (const [directory, name] of [['apps/stack', '@happier-dev/stack'], ['packages/protocol', '@happier-dev/protocol'], ['packages/channels-protocol', '@happier-dev/channels-protocol']]) {
      mkdirSync(join(fixture, directory), { recursive: true });
      writeFileSync(join(fixture, directory, 'package.json'), JSON.stringify({ name, scripts: { test: 'unused' } }));
      writeFileSync(join(fixture, directory, 'selected.test.mjs'), '');
    }
    const run = (files: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('scripts/testing/runRootTests.ts'), 'unit', ...files], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: pnpm, ROOT_TEST_CALLS: log },
    });
    const result = run(['--', 'apps/stack/selected.test.mjs', join(fixture, 'packages/protocol/selected.test.mjs'), 'packages/channels-protocol/selected.test.mjs', 'apps/stack/selected.test.mjs']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [
      ['--filter', '@happier-dev/protocol', '--silent', 'run', 'test', 'selected.test.mjs'],
      ['--filter', '@happier-dev/channels-protocol', '--silent', 'run', 'build'],
      ['--filter', '@happier-dev/channels-protocol', '--silent', 'run', 'test', 'selected.test.mjs'],
      ['--dir', 'apps/stack', '--silent', 'run', 'test:unit', 'selected.test.mjs'],
    ]);
    rmSync(log);
    for (const file of ['apps/stack/missing.test.mjs', 'apps/stack', '--unknown', '../outside.test.mjs']) {
      const rejected = run([file]);
      assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
      assert.equal(existsSync(log), false, `invalid selection must never dispatch a full suite: ${file}`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

for (const [lane, expectedCommands] of Object.entries({
  unit: [
    ...selectSharedPackageTestCommands('local').map(({ args }) => args),
    ...['@happier-dev/plugin-sdk', '@happier-dev/plugin-ui', '@happier-dev/sdk', '@happier-dev/app']
      .map((name) => ['--filter', name, '--silent', 'run', 'test']),
    ['--filter', '@happier-dev/cli', '--silent', 'run', 'test:unit'],
    ['--dir', 'apps/server', '--silent', 'run', 'test:unit'],
    ['--dir', 'apps/stack', '--silent', 'run', 'test:unit'],
  ],
  integration: [
    ['--filter', '@happier-dev/app', '--silent', 'run', 'test:integration'],
    ['--filter', '@happier-dev/cli', '--silent', 'run', 'test:integration'],
    ['--dir', 'apps/server', '--silent', 'run', 'test:integration'],
    ['--dir', 'apps/stack', '--silent', 'run', 'test:integration'],
  ],
  'shared-packages': selectSharedPackageTestCommands('ci').map(({ args }) => args),
})) {
  test(`root ${lane} preserves dispatch and attempts every selected command after failures`, () => {
    assert.equal(rootPackage.scripts[`test:${lane}`], `apps/stack/bin/hstack-exec --script=test:${lane}:local`);
    const scriptBody = rootPackage.scripts[`test:${lane}:local`] + (lane === 'shared-packages' ? ' --mode ci' : '');
    assert.deepEqual(
      resolveRootScriptWorkspaceTargets({ ...rootPackage.scripts, [`test:${lane}:local`]: scriptBody }, `test:${lane}`),
      expectedCommands.map(([selector, workspace, , , scriptName]) => ({
        packageName: selector === '--filter' ? workspace : null,
        workspaceDirectory: selector === '--dir' ? workspace : null,
        scriptName,
      })),
      'inventory and workflow parity must see every actually executed workspace',
    );
    const fixture = mkdtempSync(join(tmpdir(), 'happier-root-tests-'));
    try {
      const log = join(fixture, 'calls.jsonl');
      const pnpm = join(fixture, 'pnpm.cjs');
      // Only the package-manager process is stubbed; exercise the actual dispatched script.
      writeFileSync(pnpm, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.ROOT_TEST_CALLS, JSON.stringify(args) + '\\n');\nprocess.exit(args.includes('apps/stack') ? 0 : 1);\n`, { mode: 0o755 });
      if (process.platform === 'win32') {
        writeFileSync(join(fixture, 'pnpm.cmd'), `@"${process.execPath}" "${pnpm}" %*\r\n`);
      } else {
        writeFileSync(join(fixture, 'pnpm'), readFileSync(pnpm), { mode: 0o755 });
      }
      const result = spawnSync(scriptBody, {
        shell: true,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`, npm_execpath: pnpm, ROOT_TEST_CALLS: log },
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), expectedCommands);
      assert.match(result.stderr, lane === 'shared-packages' ? /Shared package test suite failures:/ : /Root .* test suite failures:/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test('the shared package entry dispatches through hstack to the canonical runner', () => {
  assert.equal(
    rootPackage.scripts['test:shared-packages'],
    'apps/stack/bin/hstack-exec --script=test:shared-packages:local',
  );
  assert.equal(
    rootPackage.scripts['test:shared-packages:local'],
    'node --experimental-strip-types scripts/testing/runSharedPackageTests.ts',
  );
  assert.deepEqual(
    resolveRootScriptWorkspaceTargets(rootPackage.scripts, 'test:shared-packages'),
    selectSharedPackageTestCommands('local').flatMap(({ args }) =>
      resolveRootScriptWorkspaceTargets({ test: `pnpm ${args.join(' ')}` }, 'test')),
  );
});
