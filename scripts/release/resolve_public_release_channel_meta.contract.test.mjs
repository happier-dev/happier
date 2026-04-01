import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scriptPath = resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-public-release-channel-meta.mjs');

function run(args) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

test('resolve-public-release-channel-meta normalizes dev input to the publicdev ring metadata', () => {
  const raw = run(['--channel', 'dev']);
  const parsed = JSON.parse(raw);

  assert.equal(parsed.channel_id, 'publicdev');
  assert.equal(parsed.channel_label, 'dev');
  assert.equal(parsed.source_ref, 'dev');
  assert.equal(parsed.app_env, 'preview');
  assert.equal(parsed.embedded_policy_env, 'preview');
  assert.equal(parsed.expo_updates_channel, 'dev');
  assert.equal(parsed.rolling_release_suffix, 'dev');
});

test('resolve-public-release-channel-meta preserves explicit source refs', () => {
  const raw = run(['--channel', 'preview', '--source-ref', 'feature/my-sha']);
  const parsed = JSON.parse(raw);

  assert.equal(parsed.channel_id, 'preview');
  assert.equal(parsed.channel_label, 'preview');
  assert.equal(parsed.source_ref, 'feature/my-sha');
  assert.equal(parsed.app_env, 'preview');
  assert.equal(parsed.embedded_policy_env, 'preview');
  assert.equal(parsed.expo_updates_channel, 'preview');
  assert.equal(parsed.rolling_release_suffix, 'preview');
});
