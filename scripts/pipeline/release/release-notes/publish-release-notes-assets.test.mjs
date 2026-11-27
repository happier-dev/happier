import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('./publish-release-notes-assets.mjs', import.meta.url).pathname;

function publish(t, { releases, assets }) {
  const root = mkdtempSync(join(tmpdir(), 'happier-release-notes-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  const bin = join(root, 'bin');
  mkdirSync(bundle);
  mkdirSync(bin);
  writeFileSync(join(bundle, 'release-notes__manifest.json'), JSON.stringify({ releases }));
  writeFileSync(join(bundle, 'release-notes__assets-index.json'), JSON.stringify({ assets }));
  // GitHub CLI boundary: record calls; the rolling assets release does not exist yet.
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(root, 'calls')}"\n[ "$2" = view ] && exit 1\nexit 0\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const result = spawnSync(process.execPath, [script, '--in-dir', bundle], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  let calls = [];
  try { calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n'); } catch {}
  return { result, calls };
}

test('an empty generated bundle publishes nothing to GitHub', (t) => {
  const { result, calls } = publish(t, { releases: [], assets: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, []);
});

test('the rolling release-notes assets release is never marked Latest', (t) => {
  const { result, calls } = publish(t, { releases: [{ version: '0.3.0' }], assets: { 'a.png': {} } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls.find((call) => call.startsWith('release create')) ?? '', /--latest=false/);
  assert.ok(calls.some((call) => call.startsWith('release upload')));
});
