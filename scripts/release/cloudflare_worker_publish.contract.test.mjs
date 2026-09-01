import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const publisher = path.join(repoRoot, 'scripts', 'pipeline', 'cloudflare', 'publish-worker.sh');

function runPublisher(mode, environment = 'preview') {
  const root = mkdtempSync(path.join(tmpdir(), 'happier-cloudflare-publish-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'commands.log');
  const count = path.join(root, 'count');
  spawnSync('mkdir', ['-p', bin]);
  const fakeNpx = path.join(bin, 'npx');
  writeFileSync(fakeNpx, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_LOG"
current=0
if [ -f "$FAKE_COUNT" ]; then current="$(cat "$FAKE_COUNT")"; fi
current=$((current + 1))
printf '%s' "$current" > "$FAKE_COUNT"
if [ "$FAKE_MODE" = missing ] && [ "$current" -eq 1 ]; then
  echo 'You cannot upload a new version of a Worker that does not yet exist. Please run the deploy command first.' >&2
  exit 1
fi
if [ "$FAKE_MODE" = denied ]; then
  echo 'Authentication error [code: 10000]' >&2
  exit 42
fi
`, 'utf8');
  chmodSync(fakeNpx, 0o755);
  const result = spawnSync('bash', [publisher, '--environment', environment, '--release-sha', 'a'.repeat(40)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_MODE: mode,
      FAKE_LOG: log,
      FAKE_COUNT: count,
    },
    encoding: 'utf8',
  });
  const commands = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  rmSync(root, { recursive: true, force: true });
  return { ...result, commands };
}

test('production publishes one deployment', () => {
  const result = runPublisher('ok', 'production');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands, [`--yes wrangler@4 deploy --message promote ${'a'.repeat(40)}`]);
});

test('preview uploads a version without changing the deployment when the Worker exists', () => {
  const result = runPublisher('ok');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands, [`--yes wrangler@4 versions upload --preview-alias preview --message promote ${'a'.repeat(40)}`]);
});

test('preview bootstraps only a Worker proven missing, then creates its preview alias', () => {
  const result = runPublisher('missing');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands, [
    `--yes wrangler@4 versions upload --preview-alias preview --message promote ${'a'.repeat(40)}`,
    `--yes wrangler@4 deploy --message bootstrap ${'a'.repeat(40)}`,
    `--yes wrangler@4 versions upload --preview-alias preview --message promote ${'a'.repeat(40)}`,
  ]);
});

test('preview does not bootstrap after an unrelated Wrangler failure', () => {
  const result = runPublisher('denied');
  assert.equal(result.status, 42);
  assert.deepEqual(result.commands, [`--yes wrangler@4 versions upload --preview-alias preview --message promote ${'a'.repeat(40)}`]);
});

test('website and docs delegate Cloudflare publication to the shared trusted helper', () => {
  for (const workflow of ['promote-website.yml', 'promote-docs.yml']) {
    const raw = readFileSync(path.join(repoRoot, '.github', 'workflows', workflow), 'utf8');
    assert.match(raw, /scripts\/pipeline\/cloudflare\/publish-worker\.sh/);
    assert.doesNotMatch(raw, /npx --yes wrangler@4 (?:deploy|versions upload)/);
  }
});
