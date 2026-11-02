import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('post-channel Latest promotion uses exact immutable identities and refuses invalid versions before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-latest-'));
  const log = join(root, 'gh.jsonl');
  const loader = join(root, 'without-installed-packages.mjs');
  writeFileSync(loader, `export function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@')) throw new Error('The post-channel job has no installed workspace packages');
    return nextResolve(specifier, context);
  }`);
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.LATEST_TEST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, LATEST_TEST_LOG: log, GH_REPO: 'test/test',
    CLI_VERSION: '1.2.3', STACK_VERSION: '', SERVER_VERSION: '2.3.4', RUNNER_VERSION: '', UI_WEB_VERSION: '3.4.5',
  };
  const script = new URL('../pipeline/github/promote-release-latest.mjs', import.meta.url).pathname;
  try {
    const run = spawnSync(process.execPath, ['--experimental-loader', loader, script], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [
      ['release', 'edit', 'cli-v1.2.3', '--repo', 'test/test', '--latest'],
      ['release', 'edit', 'server-v2.3.4', '--repo', 'test/test', '--latest'],
      ['release', 'edit', 'ui-web-v3.4.5', '--repo', 'test/test', '--latest'],
    ]);
    writeFileSync(log, '');
    const invalid = spawnSync(process.execPath, ['--experimental-loader', loader, script], { env: { ...env, SERVER_VERSION: '2.3.4-preview.1' }, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.equal(readFileSync(log, 'utf8'), '', 'validate the complete version selection before any Latest mutation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
