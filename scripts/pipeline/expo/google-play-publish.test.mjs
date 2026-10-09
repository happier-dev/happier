import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { publishGooglePlayProduction, requireGooglePlayCredential } from './google-play-publish.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const credentialJson = JSON.stringify({ type: 'service_account', client_email: 'publisher@example.iam.gserviceaccount.com', private_key_id: 'fixture-key', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });
const target = { name: 'release-42', versionCodes: ['42'], status: 'inProgress', userFraction: 0.1, countryTargeting: { countries: ['CH'], includeRestOfWorld: false }, releaseNotes: [{ language: 'fr-FR', text: 'Conserver' }, { language: 'en-US', text: 'Old notes' }], inAppUpdatePriority: 2 };
const previous = { versionCodes: ['41'], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'Previous' }] };

function boundary({ releases = [previous, target], failAt, invalidUpdate = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url, ...init };
    calls.push(call);
    if (failAt === calls.length) return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED',
      message: `Production release access is required. ${credentialJson} ${calls.length > 1 ? 'fixture-token' : ''} ${new URLSearchParams(calls[0].body).get('assertion')}`,
      errors: [{ reason: 'forbidden' }],
    } }), { status: 403 });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-token', token_type: 'Bearer' });
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    if (url.endsWith('/edits')) return Response.json({ id: 'edit-1', expiryTimeSeconds: '123' });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith(':commit')) return Response.json({ id: 'edit-1' });
    if (init.method === 'PUT') {
      const update = JSON.parse(init.body);
      // Publisher v3 rejects a second completed release, as in production job 113992849435.
      if (update.releases.filter((release) => release.status === 'completed').length > 1) {
        return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Only one completed release is allowed.' } }, { status: 400 });
      }
      return Response.json(invalidUpdate ? { track: 'production', releases } : update);
    }
    return Response.json({ track: 'production', releases });
  };
  return { calls, fetchImpl };
}

const input = { packageName: 'dev.happier.app', versionCode: '42', whatsNew: 'Exact approved notes.\nWith authored spacing.', credentialJson };

test('Play edit supersedes the previous completed release with exact notes and full rollout and verifies JWT', async () => {
  const { calls, fetchImpl } = boundary();
  const result = await publishGooglePlayProduction({ ...input, fetchImpl });
  assert.equal(result.status, 'publication_submitted');
  assert.equal(result.publicAvailability, 'unverified');
  const assertion = new URLSearchParams(calls[0].body).get('assertion');
  const [header, payload, signature] = assertion.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: 'fixture-key' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, 'publisher@example.iam.gserviceaccount.com');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/androidpublisher');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
  const update = JSON.parse(calls.find((call) => call.method === 'PUT').body);
  assert.equal(update.releases.length, 1);
  assert.deepEqual(update.releases[0].versionCodes, ['42']);
  assert.equal(update.releases[0].status, 'completed');
  assert.equal(Object.hasOwn(update.releases[0], 'userFraction'), false);
  assert.equal(Object.hasOwn(update.releases[0], 'countryTargeting'), false);
  assert.deepEqual(update.releases[0].releaseNotes, [{ language: 'fr-FR', text: 'Conserver' }, { language: 'en-US', text: input.whatsNew }]);
  assert.equal(update.releases[0].inAppUpdatePriority, 2);
  assert.equal(calls.at(-1).url.endsWith('/edit-1:commit'), true);
});

test('store retry observes an already completed exact release and makes no update or commit', async () => {
  const releases = [{ ...target, status: 'completed', userFraction: undefined, countryTargeting: undefined, releaseNotes: [{ language: 'en-US', text: input.whatsNew }] }];
  const { calls, fetchImpl } = boundary({ releases });
  const result = await publishGooglePlayProduction({ ...input, fetchImpl });
  assert.equal(result.status, 'publication_already_submitted');
  assert.equal(calls.some((call) => call.method === 'PUT' || call.url.endsWith(':commit')), false);
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('a completed release with forbidden country targeting is repaired instead of accepted as already submitted', async () => {
  const releases = [previous, { ...target, status: 'completed', userFraction: undefined, releaseNotes: [{ language: 'en-US', text: input.whatsNew }] }];
  const { calls, fetchImpl } = boundary({ releases });
  const result = await publishGooglePlayProduction({ ...input, fetchImpl });
  assert.equal(result.status, 'publication_submitted');
  const update = JSON.parse(calls.find((call) => call.method === 'PUT').body);
  assert.equal(Object.hasOwn(update.releases[0], 'countryTargeting'), false);
  assert.equal(update.releases.length, 1);
  assert.equal(calls.at(-1).url.endsWith(':commit'), true);
});

test('missing or invalid credentials fail before any HTTP request and never expose their values', async () => {
  for (const [credentialJson, code] of [['', 'missing_play_credential'], ['private-not-json', 'invalid_play_credential'], [JSON.stringify({ type: 'service_account', private_key: 'secret' }), 'invalid_play_credential']]) {
    await assert.rejects(publishGooglePlayProduction({ ...input, credentialJson, fetchImpl: () => { throw new Error('HTTP must not run'); } }), (error) => error.code === code && !error.message.includes('private-not-json') && !error.message.includes('secret'));
  }
  assert.throws(() => requireGooglePlayCredential(JSON.stringify({ ...JSON.parse(credentialJson), token_uri: 'https://attacker.example' })), { code: 'invalid_play_credential' });
});

test('the exact version must be present once and alone in its release before changing the track', async () => {
  for (const [releases, code] of [[[previous], 'play_version_not_found'], [[target, target], 'play_version_not_found'], [[{ ...target, versionCodes: ['42', '43'] }], 'ambiguous_play_release']]) {
    const { calls, fetchImpl } = boundary({ releases });
    await assert.rejects(publishGooglePlayProduction({ ...input, fetchImpl }), { code });
    assert.equal(calls.some((call) => call.method === 'PUT' || call.url.endsWith(':commit')), false);
  }
});

test('API failures retain Google reason and message without exposing credentials or signed tokens', async () => {
  for (const [failAt, operation] of [[1, 'authorize'], [3, 'read_track'], [5, 'commit_edit']]) {
    const { fetchImpl } = boundary({ failAt });
    await assert.rejects(publishGooglePlayProduction({ ...input, fetchImpl }), (error) => {
      assert.equal(error.code, 'play_api_error');
      assert.equal(error.httpStatus, 403);
      assert.equal(error.operation, operation);
      assert.equal(error.apiStatus, 'PERMISSION_DENIED');
      assert.deepEqual(error.apiReasons, ['forbidden']);
      assert.match(error.apiMessage, /Production release access is required\./);
      assert.doesNotMatch(error.message + error.apiMessage, /publisher@example|fixture-token|BEGIN PRIVATE KEY|fixture-key|eyJ/);
      return true;
    });
  }
});

test('an unaccepted track update never commits', async () => {
  const { calls, fetchImpl } = boundary({ invalidUpdate: true });
  await assert.rejects(publishGooglePlayProduction({ ...input, fetchImpl }), { code: 'invalid_play_response' });
  assert.equal(calls.some((call) => call.url.endsWith(':commit')), false);
});
