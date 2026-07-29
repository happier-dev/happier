import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { runRepresentativeRuntimeFixture, runStrippedPathBinarySmoke } from './strippedPathBinarySmoke.ts';

function createFixtureRepo(): string {
  return mkdtempSync(join(tmpdir(), 'happier-stripped-path-smoke-'));
}

function writeFixtureFile(rootDir: string, filePath: string, content: string): void {
  const absolutePath = join(rootDir, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

test('stripped PATH smoke rejects direct package-manager runtime invocations in plugin code', () => {
  const rootDir = createFixtureRepo();
  writeFixtureFile(
    rootDir,
    'packages/plugins/acme/src/agent/runtime.ts',
    [
      "import { spawn } from 'node:child_process';",
      "export function run() {",
      "  return spawn('npx', ['acme-cli']);",
      "}",
      '',
    ].join('\n'),
  );

  const result = runStrippedPathBinarySmoke({ rootDir });

  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]?.message ?? '', /npx/);
  assert.match(result.violations[0]?.message ?? '', /managed runtime/i);
});

test('stripped PATH smoke rejects direct synchronous runtime invocations in plugin code', () => {
  const rootDir = createFixtureRepo();
  writeFixtureFile(
    rootDir,
    'packages/plugins/acme/src/agent/runtime.ts',
    [
      "import { execFileSync, execSync, spawnSync } from 'node:child_process';",
      "export function run() {",
      "  spawnSync('node', ['acme.js']);",
      "  execFileSync('npm', ['install']);",
      "  execSync('npx acme-cli');",
      "}",
      '',
    ].join('\n'),
  );

  const result = runStrippedPathBinarySmoke({ rootDir });

  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 3);
  assert.deepEqual(
    result.violations.map((violation) => violation.runtimeName),
    ['node', 'npm', 'npx'],
  );
});

test('stripped PATH smoke accepts managed-runtime policy code and tests that mention package managers', () => {
  const rootDir = createFixtureRepo();
  writeFixtureFile(
    rootDir,
    'apps/cli/src/plugins/runtime/context/exec/system/tools/runtimeDeny.ts',
    [
      "export const DENIED = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'bunx'];",
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    rootDir,
    'packages/plugins/acme/src/agent/runtime.test.ts',
    "expect(command).toBe('npx');\n",
  );
  writeFixtureFile(
    rootDir,
    'packages/plugins/acme/src/agent/runtime.ts',
    [
      "export async function run(ctx) {",
      "  return ctx.exec.spawn({ kind: 'systemTool', toolId: 'acme.cli', args: [] });",
      "}",
      '',
    ].join('\n'),
  );

  const result = runStrippedPathBinarySmoke({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('stripped PATH smoke executes the representative plugin runtime fixture without PATH access', async () => {
  const result = await runRepresentativeRuntimeFixture();

  assert.equal(result.ok, true);
  assert.notEqual(result.processId, process.pid);
  assert.deepEqual(result.processEnv, { PATH: '', Path: '' });
  assert.deepEqual(result.ctxEnv, { PATH: '', Path: '' });
  assert.equal(result.spawnClientCalls.length, 1);
  assert.equal(result.spawnClientCalls[0]?.launch.kind, 'managed-installable');
  assert.equal(result.fetchRequests.length, 1);
  assert.deepEqual(result.actionIds, ['representative-runtime.echo']);
  assert.deepEqual(result.subagentIds, ['representative-runtime.audit']);
  assert.deepEqual(result.secretKeys, ['REPRESENTATIVE_RUNTIME_TOKEN']);
});
