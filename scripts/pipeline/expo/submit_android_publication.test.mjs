import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpoSubmitFixture as submissionFixture } from './fixtures/expo-submit.mjs';

const submit = fileURLToPath(new URL('./submit.mjs', import.meta.url));

test('production Android refuses missing Play credentials before any EAS submission', () => {
  const result = spawnSync(process.execPath, [submit, '--environment', 'production', '--platform', 'android', '--dry-run'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, CI: '1', EXPO_TOKEN: 'fixture', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing_play_credential/);
  assert.doesNotMatch(result.stdout, /eas-cli@.*submit/);
});

test('misaligned native AAB fails before local or cloud upload and store writes', (t) => {
  for (const cloud of [false, true]) {
    const { result, calls, restored } = submissionFixture(t, { cloud, misaligned: true });
    assert.notEqual(result.status, 0, '4KB ELF must be rejected before submission');
    assert.match(result.stderr, /LOAD alignment 4096/u);
    assert.equal(calls.some((call) => call.kind === 'eas' && call.args.includes('submit')), false);
    assert.equal(calls.some((call) => call.url?.includes('androidpublisher')), false);
    assert.equal(restored, true);
  }
});

test('nonproduction local, exact cloud and latest cloud submissions cannot bypass native verification', (t) => {
  for (const options of [{}, { cloud: true }, { cloud: true, latest: true }]) {
    const { result, calls } = submissionFixture(t, { ...options, nonproduction: true, misaligned: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOAD alignment 4096/u);
    assert.equal(calls.some((call) => call.kind === 'eas' && call.args.includes('submit')), false);
  }
  const { result, calls } = submissionFixture(t, { nonproduction: true, cloud: true, latest: true });
  assert.equal(result.status, 0, result.stderr);
  const upload = calls.find((call) => call.kind === 'eas' && call.args.includes('submit'));
  assert.ok(upload.args.includes('--id') && upload.args.includes('exact-build'));
  assert.equal(upload.args.includes('--latest'), false);
  assert.equal(calls.some((call) => call.kind === 'http' && call.url.includes('androidpublisher')), false);
});

test('a newer pending latest build never causes upload of the older finished binary', (t) => {
  const { result, calls } = submissionFixture(t, { nonproduction: true, cloud: true, latest: true, pendingLatest: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must finish/u);
  assert.equal(calls.some((call) => call.kind === 'eas' && call.args.includes('submit')), false);
});

test('production submission stages exact AAB then commits approved notes with completed rollout', (t) => {
  for (const cloud of [false, true]) {
    const { result, calls, restored, whatsNew } = submissionFixture(t, { cloud });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status":"publication_submitted"/);
    const upload = calls.find((call) => call.kind === 'eas' && call.args.includes('submit'));
    assert.equal(upload.profile.releaseStatus, 'draft');
    assert.equal(upload.args.includes('--wait'), true);
    const update = calls.find((call) => call.method === 'PUT');
    const release = JSON.parse(update.body).releases[0];
    assert.deepEqual(release.versionCodes, ['4242']);
    assert.equal(release.status, 'completed');
    assert.deepEqual(release.releaseNotes, [{ language: 'en-US', text: whatsNew }]);
    assert.equal(calls.indexOf(upload) < calls.indexOf(update), true);
    assert.equal(restored, true);
  }
});

test('dry-run plans future exact artifacts without invoking EAS or HTTP', (t) => {
  for (const cloud of [false, true]) {
    const { result, calls, restored } = submissionFixture(t, { dryRun: true, cloud });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, 0);
    assert.equal(restored, true);
    assert.match(result.stdout, /releaseStatus=completed/);
  }
});

test('binary/source mismatches refuse submission; failed commit is nonzero and restores EAS profile', (t) => {
  for (const options of [{ cloud: true, sourceMismatch: true }, { versionMismatch: true }]) {
    const { result, calls, restored } = submissionFixture(t, options);
    assert.notEqual(result.status, 0);
    assert.equal(calls.some((call) => call.kind === 'eas' && call.args.includes('submit')), false);
    assert.equal(restored, true);
  }
  const { result, restored } = submissionFixture(t, { commitFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /play_api_error/);
  assert.equal(restored, true);
  assert.doesNotMatch(result.stdout, /publication_submitted/);
});

test('production cannot upload to a submit profile targeting another track', (t) => {
  const { result, calls } = submissionFixture(t, { wrongTrack: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production track/i);
  assert.equal(calls.length, 0);
});

test('production Android refuses a moving latest build even with bound notes and credentials', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'play-submit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'notes.json');
  const sourceSha = 'a'.repeat(40);
  writeFileSync(bundlePath, JSON.stringify({ schemaVersion: 2, kind: 'happier.release-notes.projection.v2', release: { id: 'r1', sourceSha, components: { ui: '1.2.3' } }, projections: { playStore: { whatsNew: 'Approved notes' } } }));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentialJson = JSON.stringify({ type: 'service_account', client_email: 'fixture@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const result = spawnSync(process.execPath, [submit, '--environment', 'production', '--platform', 'android', '--dry-run', '--android-version-code', '42', '--app-version', '1.2.3', '--source-sha', sourceSha, '--release-id', 'r1', '--release-notes-json', bundlePath], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, CI: '1', EXPO_TOKEN: 'fixture', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: credentialJson }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact.*(?:build|artifact)/i);
  assert.doesNotMatch(result.stdout, /eas-cli@.*submit/);
});
