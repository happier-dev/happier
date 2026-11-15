import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertManagedGuestCliVersion, ManagedGuestCliReleaseError, resolveManagedGuestCliRelease } from './resolveManagedGuestCliRelease.js';
import { resolveFirstPartyComponentRelease } from './prepareFirstPartyComponentPayloadFromGitHubRelease.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function releaseMirror(pages: readonly unknown[][]) {
  const requests: string[] = [];
  const credentials: Array<string | undefined> = [];
  let baseUrl = '';
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    credentials.push(req.headers.authorization);
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/repos/happier-dev/happier/releases') {
      res.end(JSON.stringify(pages[Number(url.searchParams.get('page')) - 1] ?? []));
      return;
    }
    const version = url.pathname.endsWith('/cli-v0.3.9') ? '0.3.9' : '0.2.20';
    const names = [`happier-v${version}-linux-x64.tar.gz`, `checksums-happier-v${version}.txt`, `checksums-happier-v${version}.txt.minisig`];
    res.end(JSON.stringify({ assets: names.map((name) => ({ name, browser_download_url: `${baseUrl}/${name}` })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing release mirror address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', baseUrl);
  return { requests, credentials };
}

const release = (version: string, extra: Record<string, unknown> = {}) => ({ tag_name: `cli-v${version}`, draft: false, ...extra });

describe('managed guest CLI release selection', () => {
  it('selects the newest exact release in the Home line across every page and acquires that exact tag', async () => {
    const firstPage = [release('0.3.2'), ...Array.from({ length: 99 }, (_, index) => release(`0.2.${index}`))];
    const fixture = await releaseMirror([firstPage, [release('0.3.9'), release('0.4.1'), release('0.3.99', { draft: true }), release('0.3.8-preview.1')]]);
    const selected = await resolveManagedGuestCliRelease({ line: '0.3', installedVersion: '0.3.1', githubToken: 'github-only-secret' });
    expect(selected.versionId).toBe('0.3.9');
    const exact = await resolveFirstPartyComponentRelease({ componentId: 'happier-cli', channel: 'stable', versionId: selected.versionId, os: 'linux', arch: 'x64' });
    expect(exact.versionId).toBe('0.3.9');
    expect(fixture.requests).toEqual([
      '/repos/happier-dev/happier/releases?per_page=100&page=1',
      '/repos/happier-dev/happier/releases?per_page=100&page=2',
      '/repos/happier-dev/happier/releases/tags/cli-v0.3.9',
    ]);
    expect(fixture.credentials.every((value) => value === undefined)).toBe(true);
  });

  it('orders numeric prereleases within the Home line', async () => {
    await releaseMirror([[release('0.3.0-preview.9'), release('0.3.0-preview.10'), release('0.3.0-dev.9'), release('0.3.0-dev.10'), release('0.4.0-preview.20')]]);
    await expect(resolveManagedGuestCliRelease({ line: '0.3' })).resolves.toEqual({ versionId: '0.3.0-preview.10' });
  });

  it('selects newest in the Home line independently of the controller installation channel', async () => {
    await releaseMirror([[release('0.3.9'), release('0.3.8-dev.1')]]);
    await expect(resolveManagedGuestCliRelease({ line: '0.3', channel: 'publicdev' })).resolves.toEqual({ versionId: '0.3.9' });
  });

  it('refuses a different release line instead of falling back to rolling latest', async () => {
    const fixture = await releaseMirror([[release('0.2.20'), release('0.4.0')]]);
    await expect(resolveManagedGuestCliRelease({ line: '0.3' })).rejects.toMatchObject({ code: 'managed_guest_cli_release_unavailable' });
    expect(fixture.requests).toEqual(['/repos/happier-dev/happier/releases?per_page=100&page=1']);
  });

  it.each(['0.3.10', '0.4.0'])('refuses to downgrade an installed %s guest', async (installedVersion) => {
    await releaseMirror([[release('0.3.9')]]);
    await expect(resolveManagedGuestCliRelease({ line: '0.3', installedVersion })).rejects.toMatchObject({ code: 'managed_guest_cli_release_downgrade' });
  });

  it('uses the supplied HTTP boundary and preserves cancellation and authentication', async () => {
    vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', undefined);
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe('https://api.github.com/repos/fixture/releases/releases?per_page=100&page=1');
      expect(init?.signal).toBe(controller.signal);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer github-only-secret');
      return Response.json([release('0.3.9')]);
    };
    await expect(resolveManagedGuestCliRelease({ line: '0.3', githubRepo: 'fixture/releases', githubToken: 'github-only-secret', fetchImpl, signal: controller.signal })).resolves.toEqual({ versionId: '0.3.9' });
    controller.abort(new Error('Guest update cancelled'));
    await expect(resolveManagedGuestCliRelease({ line: '0.3', fetchImpl, signal: controller.signal })).rejects.toThrow('Guest update cancelled');
  });

  it('preserves a later-page failure instead of selecting from an incomplete release listing', async () => {
    vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', undefined);
    const fetchImpl: typeof fetch = async (url) => String(url).endsWith('page=1')
      ? Response.json(Array.from({ length: 100 }, () => release('0.3.1')))
      : new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) } });
    await expect(resolveManagedGuestCliRelease({ line: '0.3', githubToken: '', fetchImpl })).rejects.toMatchObject({ code: 'github_rate_limited', status: 403 });
  });

  it('refuses an invalid release-list response without reporting an unavailable line', async () => {
    vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', undefined);
    const fetchImpl: typeof fetch = async () => Response.json({ message: 'invalid response' });
    const failure = await resolveManagedGuestCliRelease({ line: '0.3', githubToken: '', fetchImpl }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ManagedGuestCliReleaseError);
  });
});

describe('managed guest CLI version admission', () => {
  it('permits Home-owned payload version metadata from another line when no public line is requested', () => {
    expect(() => assertManagedGuestCliVersion({ candidateVersion: '0.2.20', installedVersion: '0.2.19' })).not.toThrow();
  });
  it('accepts the selected Home line and allows equality or an upgrade from an older line', () => {
    expect(() => assertManagedGuestCliVersion({ line: '0.3', candidateVersion: '0.3.9', installedVersion: '0.3.9' })).not.toThrow();
    expect(() => assertManagedGuestCliVersion({ line: '0.3', candidateVersion: '0.3.9', installedVersion: '0.2.20' })).not.toThrow();
  });

  it('refuses a Home payload from another line', () => {
    expect(() => assertManagedGuestCliVersion({ line: '0.3', candidateVersion: '0.2.20' })).toThrow(expect.objectContaining({ code: 'managed_guest_cli_release_line_mismatch' }));
  });

  it.each(['0.3.10', '0.4.0'])('refuses a local payload downgrade from %s', (installedVersion) => {
    expect(() => assertManagedGuestCliVersion({ line: '0.3', candidateVersion: '0.3.9', installedVersion })).toThrow(expect.objectContaining({ code: 'managed_guest_cli_release_downgrade' }));
  });

  it.each([
    { line: '0.3.0', candidateVersion: '0.3.9' },
    { line: '0.3', candidateVersion: 'latest' },
    { line: '0.3', candidateVersion: '0.3.9', installedVersion: 'unknown' },
  ])('refuses nonexact or unknown version facts (%j)', (input) => {
    expect(() => assertManagedGuestCliVersion(input)).toThrow(expect.objectContaining({ code: 'managed_guest_cli_release_invalid' }));
  });
});
