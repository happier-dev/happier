import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';

import { describe, expect, it } from 'vitest';

import { createNpmRegistryHttpsClient } from './httpsClient';
import { npmHttpResponse, npmHttpRequestBoundary } from '../testkit/npmHttp';
import { checkNpmPublication, publishNpmPackage, readNpmPackageVersionHistory } from './publish';

const registryOrigin = 'https://registry.example.test';
const manifest = { name: '@scope/plugin', version: '1.2.3', description: 'A plugin', readme: '# Plugin' };
const tarball = Buffer.from('reviewed package bytes');
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;

function response(body: unknown, statusCode = 200, headers: Record<string, string> = {}): IncomingMessage {
  return npmHttpResponse(body, { statusCode, headers: { 'content-type': 'application/json', ...headers } });
}

function fixture(responses: (IncomingMessage | Error | (() => void))[], authorizationHeader = 'Bearer private-token') {
  const seen: RequestOptions[] = [];
  const bodies: (string | undefined)[] = [];
  const client = createNpmRegistryHttpsClient({ registryOrigin, authorizationHeader,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: npmHttpRequestBoundary({ responses, seen, bodies }) });
  return { client, seen, bodies };
}

describe('npm publication through the real HTTPS client', () => {
  it('uploads one public package with npm metadata, attachments and sha512/sha1 facts', async () => {
    const { client, seen, bodies } = fixture([response('', 201)]);
    const result = await publishNpmPackage({ registryOrigin, manifest, tarball, client });
    expect(result).toMatchObject({ status: 'published', packageName: manifest.name, version: manifest.version, integrity });
    expect(seen).toHaveLength(1);
    expect(seen[0]!).toMatchObject({ method: 'PUT', path: '/@scope%2fplugin', headers: { authorization: 'Bearer private-token' } });
    expect(JSON.parse(bodies[0]!)).toMatchObject({ name: manifest.name, access: 'public', 'dist-tags': { latest: '1.2.3' },
      versions: { '1.2.3': { ...manifest, dist: { integrity, shasum: createHash('sha1').update(tarball).digest('hex') } } },
      _attachments: { '@scope/plugin-1.2.3.tgz': { data: tarball.toString('base64'), length: tarball.length } } });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('reports a staged upload as awaiting maintainer, retaining only its stage identity', async () => {
    const { client, seen } = fixture([response({ stageId: 'stage-123', token: 'private-token', url: 'https://secret.test/?token=private-token' }, 201)]);
    const result = await publishNpmPackage({ registryOrigin, manifest, tarball, mode: 'staged', client });
    expect(result).toMatchObject({ status: 'awaiting_maintainer', stageId: 'stage-123', reviewUrl: registryOrigin });
    expect(seen[0]!).toMatchObject({ method: 'POST', path: '/-/stage/package/@scope%2fplugin' });
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('secret.test');
  });

  it.each([
    [401, { error: 'unauthorized private-token' }, {}, 'authentication_failed'],
    [403, { error: 'forbidden private-token' }, {}, 'authentication_failed'],
    [401, { error: 'private-token' }, { 'www-authenticate': 'OTP' }, 'challenge'],
    [401, { error: 'one-time pass required private-token' }, {}, 'challenge'],
    [409, { error: 'conflict private-token' }, {}, 'version_conflict'],
    [403, { error: 'EPUBLISHCONFLICT', reason: 'private-token' }, {}, 'version_conflict'],
  ] as const)('classifies HTTP %s without projecting registry bodies', async (statusCode, body, headers, status) => {
    const { client, seen } = fixture([response(body, statusCode, headers)]);
    const result = await publishNpmPackage({ registryOrigin, manifest, tarball, client });
    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(seen).toHaveLength(1);
  });

  it('never replays an upload after a lost reply and checks the exact version once explicitly', async () => {
    const { client, seen } = fixture([new Error('connection lost private-token'), response({ name: manifest.name, version: manifest.version, dist: { integrity } })]);
    expect(await publishNpmPackage({ registryOrigin, manifest, tarball, client })).toMatchObject({ status: 'outcome_unknown' });
    expect(seen).toHaveLength(1);
    expect(await checkNpmPublication({ registryOrigin, packageName: manifest.name, version: manifest.version, integrity, client })).toMatchObject({ status: 'published' });
    expect(seen).toHaveLength(2);
    expect(seen[1]!).toMatchObject({ method: 'GET', path: '/@scope%2fplugin/1.2.3' });
  });

  it.each([
    [response({}, 404), 'missing'],
    [response({ name: manifest.name, version: manifest.version, dist: { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } }), 'version_conflict'],
    [response({ name: 'different', version: manifest.version, dist: { integrity } }), 'failed'],
  ] as const)('distinguishes missing, different bytes and mismatched identity in recovery', async (reply, status) => {
    const { client, seen } = fixture([reply]);
    expect((await checkNpmPublication({ registryOrigin, packageName: manifest.name, version: manifest.version, integrity, client })).status).toBe(status);
    expect(seen).toHaveLength(1);
  });

  it('does not follow write redirects or upload a second copy', async () => {
    const { client, seen } = fixture([response('', 307, { location: '/redirected' }), response({}, 201)]);
    expect(await publishNpmPackage({ registryOrigin, manifest, tarball, client })).toMatchObject({ status: 'outcome_unknown' });
    expect(seen).toHaveLength(1);
  });

  it('does not wait for an ignored successful direct response body', async () => {
    const reply = response('', 201);
    reply[Symbol.asyncIterator] = async function* () { throw new Error('unused response body'); };
    const { client } = fixture([reply]);
    expect(await publishNpmPackage({ registryOrigin, manifest, tarball, client })).toMatchObject({ status: 'published' });
  });

  it('cancels before sending without a write and reports cancellation after sending as unknown', async () => {
    const before = new AbortController();
    before.abort(new Error('private-token'));
    const early = fixture([]);
    expect(await publishNpmPackage({ registryOrigin, manifest, tarball, client: early.client, signal: before.signal })).toMatchObject({ status: 'cancelled' });
    expect(early.seen).toHaveLength(0);
    const during = new AbortController();
    const late = fixture([() => during.abort(new Error('private-token'))]);
    const result = await publishNpmPackage({ registryOrigin, manifest, tarball, client: late.client, signal: during.signal });
    expect(result.status).toBe('outcome_unknown');
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('reads selected package version history once and ignores malformed version entries', async () => {
    const { client, seen } = fixture([response({ name: manifest.name, versions: { '1.0.0': {}, '1.2.3': {}, '2.0.0-beta.1': {}, invalid: {} }, 'dist-tags': { latest: '1.2.3' } })]);
    expect(await readNpmPackageVersionHistory({ registryOrigin, packageName: manifest.name, client })).toMatchObject({ status: 'available', versions: ['2.0.0-beta.1', '1.2.3', '1.0.0'], latestVersion: '1.2.3' });
    expect(seen).toHaveLength(1);
  });
});
