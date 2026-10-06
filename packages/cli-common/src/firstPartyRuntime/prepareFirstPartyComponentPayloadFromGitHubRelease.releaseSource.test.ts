import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareFirstPartyComponentPayloadFromGitHubRelease, resolveFirstPartyComponentRelease } from './prepareFirstPartyComponentPayloadFromGitHubRelease.js';
import { ensureLocalFirstPartyComponentCommand } from '../systemTasks/executors/happierJsonExecutor.js';

const override = 'HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL';
const params = { componentId: 'happier-cli', channel: 'stable', os: 'darwin', arch: 'arm64' } as const;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function mirror() {
  let baseUrl = '';
  let authorization: string | undefined;
  const server = http.createServer((req, res) => {
    authorization = req.headers.authorization;
    if (req.url === '/repos/happier-dev/happier/releases/tags/cli-stable') {
      const archive = `happier-v99.0.0-${process.platform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
      res.end(JSON.stringify({ assets: [...new Set([
        'happier-v99.0.0-darwin-arm64.tar.gz', archive, 'checksums-happier-v99.0.0.txt', 'checksums-happier-v99.0.0.txt.minisig',
      ])].map((name) => ({ name, browser_download_url: `${baseUrl}/${name}` })) }));
    } else {
      res.end('not signed by the official publisher');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing mirror address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  // Only the external network boundary is intercepted; real lookup/download/verification stay intact.
  vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected public network request'); });
  syncBuiltinESMExports();
  return { baseUrl, authorization: () => authorization };
}

describe('development first-party release mirror', () => {
  it('resolves through loopback without forwarding GitHub credentials and keeps official signature verification', async () => {
    const fixture = await mirror();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(override, fixture.baseUrl);
    const release = await resolveFirstPartyComponentRelease({ ...params, githubToken: 'fixture-token' });
    expect(release.versionId).toBe('99.0.0');
    expect(fixture.authorization()).toBeUndefined();
    await expect(prepareFirstPartyComponentPayloadFromGitHubRelease(params)).rejects.toThrow(/signature verification failed/i);
    const home = await mkdtemp(join(tmpdir(), 'first-party-mirror-home-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    // The evolved 0.3 bootstrap consumes this shared executor, with its real acquisition path.
    const failure = await ensureLocalFirstPartyComponentCommand({
      componentId: 'happier-cli', releaseRing: 'stable',
      processEnv: { HAPPIER_HOME_DIR: home, HAPPIER_STACK_REPO_DIR: home, PATH: '' },
    }).then(() => null, (error: unknown) => error);
    expect(failure, failure instanceof Error ? failure.message : 'Missing acquisition failure').toMatchObject({ code: 'cli_acquisition_verifying_failed' });
    expect(existsSync(join(home, 'cli/current'))).toBe(false);
  });

  it.each(['production', 'test', undefined])('rejects the override outside development (%s)', async (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv(override, 'http://127.0.0.1:43388');
    await expect(resolveFirstPartyComponentRelease(params)).rejects.toThrow(/override.*development/i);
  });

  it.each(['', 'not a URL', 'https://mirror.example.test', 'file:///tmp/mirror', 'http://127.0.0.1.evil.test',
    'http://user:password@127.0.0.1', 'http://127.0.0.1/api', 'http://127.0.0.1?token=secret', 'http://127.0.0.1#fragment'])
  ('rejects a malformed or disallowed mirror visibly (%s)', async (value) => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(override, value);
    await expect(resolveFirstPartyComponentRelease(params)).rejects.toThrow(/override.*loopback/i);
  });
});
