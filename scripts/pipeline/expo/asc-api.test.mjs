import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ascListAll, createAscRequest, readEasBuildIdentity, resolveAscBuildIdentity } from './asc-api.mjs';

test('canonical build identity resolves marketing version and build number across pages and ignores another train', async () => {
  const requests = [];
  const request = async ({ url }) => {
    requests.push(url);
    const second = new URL(url).searchParams.has('cursor');
    return { data: [{ id: second ? 'exact' : 'another-version', attributes: { version: '42', processingState: 'VALID' }, relationships: { preReleaseVersion: { data: { id: 'train' } } } }],
      included: [{ type: 'preReleaseVersions', id: 'train', attributes: { version: second ? '1.2.3' : '1.2.2' } }],
      links: { next: second ? null : 'https://api.appstoreconnect.apple.com/v1/builds?cursor=next' } };
  };
  assert.equal((await resolveAscBuildIdentity({ request, ascAppId: 'app', buildNumber: '42', appVersion: '1.2.3' })).id, 'exact');
  assert.equal(requests.length, 2);
});

test('ASC pagination refuses to forward credentials to a different origin', async () => {
  const requests = [];
  await assert.rejects(ascListAll({ url: 'https://api.appstoreconnect.apple.com/v1/builds', request: async ({ url }) => {
    requests.push(url);
    return { data: [], links: { next: 'https://other.example/builds' } };
  } }), /origin/);
  assert.equal(requests.length, 1);
});

test('production exact-build selection distinguishes iOS from another Apple platform with the same version and build number', async () => {
  const result = await resolveAscBuildIdentity({ ascAppId: 'app', buildNumber: '42', appVersion: '1.2.3', platform: 'IOS', request: async () => ({
    data: ['tv', 'ios'].map((id) => ({ id, attributes: { version: '42', processingState: 'VALID' }, relationships: { preReleaseVersion: { data: { id } } } })),
    included: ['tv', 'ios'].map((id) => ({ id, type: 'preReleaseVersions', attributes: { version: '1.2.3', platform: id === 'tv' ? 'TV_OS' : 'IOS' } })),
  }) });
  assert.equal(result.id, 'ios');
});

test('shared build selection preserves existing TestFlight normalization of ASC resource identifiers and versions', async () => {
  const build = { id: ' build ', attributes: { version: ' 42 ', uploadedDate: ' 2026-09-10T00:00:00Z ', processingState: ' VALID ' }, relationships: { preReleaseVersion: { data: { id: ' train ' } } } };
  const result = await resolveAscBuildIdentity({ ascAppId: 'app', buildNumber: '42', appVersion: '1.2.3', request: async () => ({ data: [build], included: [{ type: ' preReleaseVersions ', id: ' train ', attributes: { version: ' 1.2.3 ' } }] }) });
  assert.equal(result, build);
});

test('production EAS identity must bind an iOS artifact to the release source while preview retains its original identity contract', () => {
  const payload = { appVersion: '1.2.3', appBuildVersion: '42', platform: 'IOS', gitCommitHash: 'bound-source' };
  assert.deepEqual(readEasBuildIdentity(payload, { expectedSourceSha: 'bound-source' }), { buildNumber: '42', appVersion: '1.2.3' });
  assert.throws(() => readEasBuildIdentity({ ...payload, gitCommitHash: 'other' }, { expectedSourceSha: 'bound-source' }), { code: 'EAS_BUILD_SOURCE_MISMATCH' });
  assert.throws(() => readEasBuildIdentity({ ...payload, platform: 'ANDROID' }, { expectedSourceSha: 'bound-source' }), { code: 'EAS_BUILD_PLATFORM_MISMATCH' });
  assert.deepEqual(readEasBuildIdentity({ appVersion: '1.2.3', appBuildVersion: '42' }), { buildNumber: '42', appVersion: '1.2.3' });
});

test('shared ASC transport preserves structured HTTP failure and refreshes valid signed authorization per request', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokens = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    tokens.push(options.headers.Authorization.slice('Bearer '.length));
    return new Response(JSON.stringify({ errors: [{ code: 'FORBIDDEN', detail: 'Permission required' }] }), { status: 403 });
  });
  const request = createAscRequest({ issuerId: 'issuer', keyId: 'key', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  await assert.rejects(request({ url: 'https://api.appstoreconnect.apple.com/v1/apps' }), { name: 'AscApiError', status: 403 });
  await assert.rejects(request({ url: 'https://api.appstoreconnect.apple.com/v1/apps' }), (error) => error.body.errors[0].code === 'FORBIDDEN');
  for (const token of tokens) {
    const [header, payload, signature] = token.split('.');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).aud, 'appstoreconnect-v1');
    assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  }
  assert.equal(tokens.length, 2);
});
