import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const stackRoot = fileURLToPath(new URL('..', import.meta.url));

function runProvidersCommand(args, { env = process.env } = {}) {
  const res = spawnSync(process.execPath, [join('scripts', 'providers_cmd.mjs'), ...args], {
    cwd: stackRoot,
    env,
    encoding: 'utf-8',
    timeout: 15000,
  });
  if (res.error) throw res.error;
  return res;
}

test('hstack providers install --dry-run --json plans codex + claude installs', () => {
  const res = runProvidersCommand(['install', '--providers=codex,claude', '--dry-run', '--json']);
  assert.equal(res.status, 0, res.stderr);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.deepEqual(data.providers, ['codex', 'claude']);

  assert.equal(data.plan[0].installMode, 'github_release_binary');
  assert.equal(data.plan[1].installMode, 'vendor_recipe');
  assert.equal(data.plan[0].commands.length, 0);
  assert.ok(JSON.stringify(data.plan[1].commands).includes('claude.ai/install.sh'));
});

test('hstack providers install accepts comma-separated positional list', () => {
  const res = runProvidersCommand(['install', 'claude,codex', '--dry-run', '--json']);
  assert.equal(res.status, 0, res.stderr);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.deepEqual(data.providers, ['claude', 'codex']);
});

test('hstack providers install supports --force to reinstall even if already installed', () => {
  const res = runProvidersCommand(['install', '--providers=codex', '--dry-run', '--force', '--json']);
  assert.equal(res.status, 0, res.stderr);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.deepEqual(data.providers, ['codex']);
  assert.equal(data.dryRun, true);
  assert.equal(data.skipIfInstalled, false);
});

test('hstack providers install shows progress output in non-json mode', () => {
  const res = runProvidersCommand(['install', '--providers=codex', '--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout ?? '', /\-\s*\[[^\]]+\]\s+install/i);
  assert.match(res.stdout ?? '', /codex/i);
});

test('hstack providers install rejects unknown provider id', () => {
  const res = runProvidersCommand(['install', '--providers=not-a-provider', '--dry-run', '--json']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr ?? '', /unknown provider/i);
});
