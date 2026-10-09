import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { main } from './store-publish.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
function fixtureArgs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const appVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/ui/package.json'), 'utf8')).version;
  const bundlePath = path.join(dir, 'notes.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ schemaVersion: 2, kind: 'happier.release-notes.projection.v2',
    release: { id: '2026-10-07.1', sourceSha, components: { ui: appVersion } },
    projections: { appStore: { whatsNew: 'Approved Apple copy.' }, playStore: { whatsNew: 'Approved Play copy.' } } }));
  return [
    '--release-notes-json', bundlePath, '--source-sha', sourceSha, '--release-id', '2026-10-07.1', '--app-version', appVersion,
  ];
}
function fixture(t) {
  const args = fixtureArgs(t);
  return (extra = []) => spawnSync(process.execPath, ['scripts/pipeline/expo/store-publish.mjs', ...args, ...extra],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '', APPLE_API_PRIVATE_KEY: '' } });
}

test('store-only retry emits typed Apple review-readiness status and associated validation errors', async (t) => {
  const args = fixtureArgs(t);
  const appVersion = args[args.indexOf('--app-version') + 1];
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const previousKey = process.env.APPLE_API_PRIVATE_KEY;
  const previousExitCode = process.exitCode;
  const previousArgv = process.argv;
  process.argv = [process.execPath, 'store-publish.mjs', ...args, '--platform', 'ios', '--build-number', '37'];
  process.env.APPLE_API_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  t.after(() => {
    if (previousKey === undefined) delete process.env.APPLE_API_PRIVATE_KEY;
    else process.env.APPLE_API_PRIVATE_KEY = previousKey;
    process.exitCode = previousExitCode;
    process.argv = previousArgv;
  });
  const associated = { resource: '/v1/appStoreVersionLocalizations/fr', code: 'ENTITY_ERROR.ATTRIBUTE.REQUIRED', pointer: '/data/attributes/whatsNew' };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const route = new URL(url).pathname;
    if (route === '/v1/builds') return Response.json({ data: [{ type: 'builds', id: 'exact', attributes: { version: '37', processingState: 'VALID' },
      relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'train' } } } }],
      included: [{ type: 'preReleaseVersions', id: 'train', attributes: { version: appVersion, platform: 'IOS' } }] });
    if (/^\/v1\/apps\/[^/]+\/appStoreVersions$/u.test(route)) return Response.json({ data: [{ type: 'appStoreVersions', id: 'version',
      attributes: { platform: 'IOS', versionString: appVersion, appStoreState: 'PREPARE_FOR_SUBMISSION', releaseType: 'AFTER_APPROVAL' },
      relationships: { build: { data: { type: 'builds', id: 'exact' } } } }] });
    if (route === '/v1/appStoreVersions/version/appStoreVersionLocalizations') return Response.json({ data: [{ type: 'appStoreVersionLocalizations',
      id: 'en', attributes: { locale: 'en-US', whatsNew: 'Approved Apple copy.' } }] });
    if (route === '/v1/appStoreVersions/version/appStoreVersionPhasedRelease') return Response.json({ data: null });
    if (route === '/v1/reviewSubmissions') return Response.json({ data: [{ type: 'reviewSubmissions', id: 'submission', attributes: { state: 'READY_FOR_REVIEW' } }] });
    if (route === '/v1/reviewSubmissions/submission/items') return Response.json({ data: [] });
    if (route === '/v1/reviewSubmissionItems' && init.method === 'POST') return Response.json({ errors: [{ status: '409', code: 'STATE_ERROR.ENTITY_STATE_INVALID',
      detail: 'This resource cannot be reviewed, please check associated errors to see why.', meta: { associatedErrors: {
        [associated.resource]: [{ code: associated.code, source: { pointer: associated.pointer } }],
      } } }] }, { status: 409 });
    throw new Error(`Unexpected HTTP: ${init.method} ${route}`);
  });
  const result = await main([...args, '--platform', 'ios', '--build-number', '37']);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'asc_review_not_ready');
  assert.equal(result.httpStatus, 409);
  assert.equal(result.apiStatus, 'STATE_ERROR.ENTITY_STATE_INVALID');
  assert.deepEqual(result.associatedErrors, [associated]);
  assert.equal(process.exitCode, 1);
});

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
