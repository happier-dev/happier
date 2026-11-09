import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MUTAGEN_ENGINE_VERSION, resolveMutagenEngineReleaseAssetBundle } from './mutagenEngineArtifact.js';
import { prepareMutagenEnginePayloadFromGitHubRelease } from './prepareMutagenEnginePayloadFromGitHubRelease.js';

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe('pinned Mutagen release acquisition without REST metadata', () => {
  it.each([
    ['linux-amd64', 'tar.gz'],
    ['linux-arm64', 'tar.gz'],
    ['darwin-amd64', 'tar.gz'],
    ['darwin-arm64', 'tar.gz'],
    ['windows-amd64', 'zip'],
  ] as const)('resolves the published %s payload directly', (targetTriple, extension) => {
    const params = { githubRepo: 'happier-dev/mutagen', engineVersion: MUTAGEN_ENGINE_VERSION, targetTriple };
    const bundle = resolveMutagenEngineReleaseAssetBundle(params);
    const base = `https://github.com/happier-dev/mutagen/releases/download/mutagen-v${MUTAGEN_ENGINE_VERSION}/`;
    expect(bundle.archive).toEqual({
      name: `happier-mutagen-v${MUTAGEN_ENGINE_VERSION}-${targetTriple}.${extension}`,
      url: `${base}happier-mutagen-v${MUTAGEN_ENGINE_VERSION}-${targetTriple}.${extension}`,
    });
    expect(bundle.checksums.url).toBe(`${base}checksums-happier-mutagen-v${MUTAGEN_ENGINE_VERSION}.txt`);
    expect(bundle.checksumsSig.url).toBe(`${bundle.checksums.url}.minisig`);
  });

  it.each(['signature', 'digest'] as const)('still rejects an invalid %s when REST quota is exhausted', async (invalid) => {
    const archiveName = `happier-mutagen-v${MUTAGEN_ENGINE_VERSION}-linux-amd64.tar.gz`;
    const checksumsName = `checksums-happier-mutagen-v${MUTAGEN_ENGINE_VERSION}.txt`;
    const checksums = `${'0'.repeat(64)}  ${archiveName}\n`;
    // A real ephemeral signing key exercises the production Minisign verifier.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawKey = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
    const keyId = Buffer.alloc(8, 1);
    const pubkeyFile = `untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'), keyId, rawKey]).toString('base64')}\n`;
    const signature = sign(null, Buffer.from(checksums), privateKey);
    const trusted = 'test';
    const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
    const sigFile = invalid === 'signature' ? 'invalid signature' : [
      'untrusted comment: test',
      Buffer.concat([Buffer.from('Ed'), keyId, signature]).toString('base64'),
      `trusted comment: ${trusted}`,
      globalSignature.toString('base64'),
      '',
    ].join('\n');
    const requested: URL[] = [];
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/repos/')) {
        res.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) });
        res.end('{"message":"API rate limit exceeded"}');
      } else if (req.url?.endsWith(`${checksumsName}.minisig`)) {
        res.end(sigFile);
      } else if (req.url?.endsWith(checksumsName)) {
        res.end(checksums);
      } else if (req.url?.endsWith(archiveName)) {
        res.end('tampered archive');
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected test server TCP address');
    // Mock only the OS HTTPS boundary; all acquisition and verification logic is real.
    vi.spyOn(https, 'request').mockImplementation((...args: Parameters<typeof https.request>) => {
      const url = new URL(String(args[0]));
      requested.push(url);
      const options = typeof args[1] === 'object' ? args[1] : {};
      const callback = typeof args[1] === 'function' ? args[1] : args[2];
      return http.request(`http://127.0.0.1:${address.port}${url.pathname}`, options, callback);
    });
    syncBuiltinESMExports();
    try {
      const error = await prepareMutagenEnginePayloadFromGitHubRelease({
        channel: 'stable', engineVersion: MUTAGEN_ENGINE_VERSION, os: 'linux', arch: 'x64', minisignPubkeyFile: pubkeyFile,
      }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: 'mutagen_engine_artifact_untrusted' });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(invalid === 'signature' ? /signature/i : /checksum verification/i);
      expect(requested.filter((url) => url.hostname === 'api.github.com')).toHaveLength(0);
      expect(requested.map((url) => url.pathname)).toEqual([
        `/happier-dev/mutagen/releases/download/mutagen-v${MUTAGEN_ENGINE_VERSION}/${checksumsName}`,
        `/happier-dev/mutagen/releases/download/mutagen-v${MUTAGEN_ENGINE_VERSION}/${checksumsName}.minisig`,
        ...(invalid === 'digest' ? [`/happier-dev/mutagen/releases/download/mutagen-v${MUTAGEN_ENGINE_VERSION}/${archiveName}`] : []),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
