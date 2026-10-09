import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const appVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/ui/package.json'), 'utf8')).version;
  const bundlePath = path.join(dir, 'notes.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ schemaVersion: 2, kind: 'happier.release-notes.projection.v2',
    release: { id: '2026-10-07.1', sourceSha, components: { ui: appVersion } },
    projections: { appStore: { whatsNew: 'Approved Apple copy.' }, playStore: { whatsNew: 'Approved Play copy.' } } }));
  return (extra = []) => spawnSync(process.execPath, ['scripts/pipeline/expo/store-publish.mjs',
    '--release-notes-json', bundlePath, '--source-sha', sourceSha, '--release-id', '2026-10-07.1', '--app-version', appVersion,
    ...extra], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '', APPLE_API_PRIVATE_KEY: '' } });
}

test('store-only Android recovery reports missing Play credential without building or uploading', (t) => {
  const result = fixture(t)(['--platform', 'android', '--android-version-code', '501']);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'failed', code: 'missing_play_credential',
    message: 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is required for production Android publication.', platform: 'android', publicAvailability: 'unverified' });
});

test('store-only iOS dry run validates notes without requiring an artifact or upload command', (t) => {
  const result = fixture(t)(['--platform', 'ios', '--build-json', '/future/build.json', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.status, 'dry_run');
  assert.equal(observation.publicAvailability, 'unverified');
  assert.doesNotMatch(result.stdout + result.stderr, /eas submit|eas build/);
});

test('store-only recovery rejects preview targets before touching either store', (t) => {
  const result = fixture(t)(['--platform', 'ios', '--environment', 'preview']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 'invalid_store_target');
});
