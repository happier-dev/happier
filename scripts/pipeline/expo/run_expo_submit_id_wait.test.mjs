import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildReleaseNotesBundle } from '../release/release-notes/project-release-notes.mjs';

test('trusted pipeline expo-submit carries exact build identity and notes for a historical source checkout', (t) => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-expo-submit-binding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const releaseId = '2026-10-09.1';
  const sourceSha = 'a'.repeat(40);
  const appVersion = '1.2.3';
  const buildId = '123e4567-e89b-12d3-a456-426614174000';
  const notesPath = path.join(dir, 'notes.json');
  const candidateRoot = path.join(dir, 'historical-source');
  fs.mkdirSync(path.join(candidateRoot, 'apps/ui'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'apps/ui/eas.json'), path.join(candidateRoot, 'apps/ui/eas.json'));
  fs.writeFileSync(notesPath, JSON.stringify(buildReleaseNotesBundle(
    `## Release ${releaseId} - 2026-10-09\n\n<!-- happier-release-note-projections:v1\n${JSON.stringify({
      expo: { message: 'Approved notes.' }, playStore: { whatsNew: 'Approved Play notes.' },
    })}\n-->\n\nApproved public notes.\n`,
    { releaseId, sourceSha, componentVersions: { ui: appVersion } },
  )));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const result = spawnSync(process.execPath, [
    'scripts/pipeline/run.mjs', 'expo-submit', '--environment', 'production', '--platform', 'android',
    '--id', buildId, '--wait', 'true', '--release-notes-json', notesPath, '--source-sha', sourceSha,
    '--release-id', releaseId, '--app-version', appVersion, '--android-version-code', '123',
    '--dry-run', '--secrets-source', 'env',
  ], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HAPPIER_PIPELINE_REPO_ROOT: candidateRoot, EXPO_TOKEN: 'test-token', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account', client_email: 'publisher@example.test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /approved notes bound/);
  assert.ok(result.stdout.includes(`"--id" "${buildId}"`));
  assert.ok(result.stdout.includes(`"--source-sha" "${sourceSha}"`));
  assert.match(result.stdout, /--android-version-code" "123"/);
  assert.match(result.stdout, /--wait" "true"/);
  assert.doesNotMatch(result.stdout, /--latest/);
});
