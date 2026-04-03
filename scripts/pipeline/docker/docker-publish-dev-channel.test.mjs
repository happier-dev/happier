import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const pipelineEntrypoint = path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs');

test('docker-publish supports dev channel (dry-run) and uses preview policy env', () => {
  const res = spawnSync(
    process.execPath,
    [
      pipelineEntrypoint,
      'docker-publish',
      '--channel',
      'dev',
      '--registries',
      'ghcr',
      '--push-latest',
      'false',
      '--build-relay',
      'true',
      '--build-dev-box',
      'false',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      encoding: 'utf8',
    },
  );

  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  const output = `${stdout}\n${stderr}`;

  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\n${output}`);
  assert.match(output, /:dev\b/, 'expected at least one :dev tag in dry-run output');
  assert.match(
    output,
    /HAPPIER_EMBEDDED_POLICY_ENV=preview/,
    'dev images must use preview-like embedded policy env',
  );
});

