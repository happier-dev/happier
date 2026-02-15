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

  const planText = JSON.stringify(data.plan);
  assert.ok(planText.includes('npm'), planText);
  assert.ok(planText.includes('@openai/codex'), planText);
  assert.ok(planText.includes('claude.ai/install.sh'), planText);
});

test('hstack providers install accepts comma-separated positional list', () => {
  const res = runProvidersCommand(['install', 'claude,codex', '--dry-run', '--json']);
  assert.equal(res.status, 0, res.stderr);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.deepEqual(data.providers, ['claude', 'codex']);
});

test('hstack providers install rejects unknown provider id', () => {
  const res = runProvidersCommand(['install', '--providers=not-a-provider', '--dry-run', '--json']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr ?? '', /unknown provider/i);
});
