import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareManagedGuestCliBuildInput, resolveManagedGuestCliSource } from './managedGuestCliSupplier.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

const exec = promisify(execFile);
describe('managed guest CLI source supplier', () => {
  afterEach(() => vi.unstubAllGlobals());
  const homeFetch = (source: 'home-payload' | 'public-release', releases: readonly string[] = [], channel = 'stable') => {
    const urls: string[] = [];
    const boundary: typeof fetch = async input => {
      const url = String(input); urls.push(url);
      return Response.json(url.endsWith('/v1/features')
        ? { capabilities: { guestCli: { source, line: '0.3', channel } } }
        : releases.map(version => ({ tag_name: `cli-v${version}`, draft: false, prerelease: false, assets: [] })));
    };
    return { boundary, urls };
  };
  it('retains the actual development payload identity and projects only installation material', async () => {
    const prepare = (identity: string) => prepareManagedGuestCliBuildInput({ homeUrl: 'https://home.example',
      target: { os: 'linux', arch: 'x64' }, fetchImpl: homeFetch('home-payload').boundary,
      prepareLocalPayload: async () => ({ identity, target: { os: 'linux', arch: 'x64' }, versionId: '0.3.0',
        archive: { contentsBase64: 'cGF5bG9hZA==', rootDirectory: 'payload' },
        ...{ accountToken: 'must-not-enter-image', homeUrl: 'https://private-home.example' } }),
    });
    const first = await prepare('a'.repeat(64));
    const next = await prepare('b'.repeat(64));
    expect(first.identity).not.toBe(next.identity);
    expect(first.files).toEqual([{ path: 'happier-cli-payload.tar.gz', contentsBase64: 'cGF5bG9hZA==' }]);
    expect(JSON.stringify(first)).not.toContain('must-not-enter-image');
    expect(JSON.stringify(first)).not.toContain('private-home');
    expect(JSON.stringify(first)).not.toContain('home.example');
  });
  it.each([undefined, { os: 'windows', arch: 'x64' }])('requires an explicit supported image target before source lookup: %j', async target => {
    const http = homeFetch('public-release');
    await expect(prepareManagedGuestCliBuildInput({ homeUrl: 'https://home.example', target, fetchImpl: http.boundary }))
      .rejects.toMatchObject({ code: 'guest_architecture_unsupported' });
    expect(http.urls).toEqual([]);
  });
  it('refuses a Home payload for another image target', async () => {
    await expect(prepareManagedGuestCliBuildInput({ homeUrl: 'https://home.example', target: { os: 'linux', arch: 'arm64' },
      fetchImpl: homeFetch('home-payload').boundary,
      prepareLocalPayload: async () => ({ identity: 'a'.repeat(64), versionId: '0.3.0', target: { os: 'linux', arch: 'x64' },
        archive: { contentsBase64: 'cGF5bG9hZA==', rootDirectory: 'payload' } }),
    })).rejects.toMatchObject({ code: 'guest_payload_missing' });
  });
  it('selects the Home public channel and exact version, then refuses unsigned image input', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input); urls.push(url);
      if (url.endsWith('/v1/features')) return Response.json({ capabilities: { guestCli: { source: 'public-release', line: '0.3', channel: 'preview' } } });
      if (new URL(url).pathname.endsWith('/releases')) return Response.json(['0.3.9', '0.3.10-preview.1', '0.4.0-preview.1'].map(version => ({ tag_name: `cli-v${version}`, draft: false, prerelease: true })));
      if (url.includes('/releases/tags/')) return Response.json({ assets: [
        { name: 'checksums-happier-v0.3.10-preview.1.txt', browser_download_url: 'https://downloads.example/checksums.txt' },
        { name: 'checksums-happier-v0.3.10-preview.1.txt.minisig', browser_download_url: 'https://downloads.example/checksums.txt.minisig' },
        { name: 'happier-v0.3.10-preview.1-linux-x64.tar.gz', browser_download_url: 'https://downloads.example/cli.tar.gz' },
      ] });
      expect(init?.credentials).toBe('omit');
      return new Response(url.endsWith('.minisig') ? 'invalid signature' : `${'a'.repeat(64)}  happier-v0.3.10-preview.1-linux-x64.tar.gz\n`);
    };
    await expect(prepareManagedGuestCliBuildInput({ homeUrl: 'https://home.example', target: { os: 'linux', arch: 'x64' }, fetchImpl,
      prepareLocalPayload: async () => { throw new Error('Public release preparation must not read controller payload files'); },
    }))
      .rejects.toThrow(/signature verification failed/u);
    expect(urls).toContain('https://api.github.com/repos/happier-dev/happier/releases/tags/cli-v0.3.10-preview.1');
    expect(urls).not.toContain('https://downloads.example/cli.tar.gz');
  });
  it('requires the dev payload before guest mutation or public release lookup', async () => {
    const http = homeFetch('home-payload'); let guestCommands = 0;
    await expect(resolveManagedGuestCliSource({ homeUrl: 'https://home.example', binaryPath: '$HOME/.happier/cli/current/happier', fetchImpl: http.boundary,
      runRemoteText: async () => { guestCommands++; return { status: 0, stdout: '', stderr: '' }; },
    })).rejects.toMatchObject({ code: 'guest_payload_missing' });
    expect(guestCommands).toBe(0);
    expect(http.urls).toEqual(['https://home.example/v1/features']);
  });
  it('selects the newest same-line public version for a fresh release Home', async () => {
    const http = homeFetch('public-release', ['0.2.99', '0.3.2', '0.4.0', '0.3.10']);
    const source = await resolveManagedGuestCliSource({ homeUrl: 'https://home.example', binaryPath: '/nonexistent/happier', fetchImpl: http.boundary,
      runRemoteText: async command => { const result = await exec('/bin/sh', ['-c', command]); return { status: 0, ...result }; },
    });
    expect(source).toEqual({ kind: 'public-release', versionId: '0.3.10' });
  });
  it.each([
    ['stable', 'preview', '0.3.10'],
    ['preview', 'stable', '0.3.20-preview.1'],
    ['publicdev', 'stable', '0.3.30-dev.1'],
  ])('uses Home channel %s instead of controller channel %s', async (homeChannel, channel, versionId) => {
    const http = homeFetch('public-release', ['0.3.10', '0.3.20-preview.1', '0.3.30-dev.1'], homeChannel);
    await expect(resolveManagedGuestCliSource({ homeUrl: 'https://home.example', channel,
      binaryPath: '/missing/happier', fetchImpl: http.boundary,
      runRemoteText: async () => ({ status: 0, stdout: 'managed_guest_cli_absent', stderr: '' }),
    })).resolves.toEqual({ kind: 'public-release', versionId });
  });
  it('refuses an identity without a channel before guest commands or public lookup', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      urls.push(String(input));
      return Response.json({ capabilities: { guestCli: { source: 'public-release', line: '0.3' } } });
    };
    let guestCommands = 0;
    await expect(resolveManagedGuestCliSource({ homeUrl: 'https://home.example', binaryPath: '/missing/happier', fetchImpl,
      runRemoteText: async () => { guestCommands++; return { status: 0, stdout: 'managed_guest_cli_absent', stderr: '' }; },
    })).rejects.toMatchObject({ code: 'guest_cli_identity_unavailable' });
    expect(guestCommands).toBe(0);
    expect(urls).toEqual(['https://home.example/v1/features']);
  });
  it('refuses a lower local payload than the installed CLI through the real version command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed-guest-version-'));
    try {
      const binaryPath = join(root, 'happier');
      await writeFile(binaryPath, '#!/bin/sh\nprintf "0.3.5\\n"\n'); await chmod(binaryPath, 0o755);
      await expect(resolveManagedGuestCliSource({ homeUrl: 'https://home.example', binaryPath, fetchImpl: homeFetch('home-payload').boundary,
        localPayloadAvailable: true, localPayloadVersion: '0.3.4',
        runRemoteText: async command => { const result = await exec('/bin/sh', ['-c', command]); return { status: 0, ...result }; },
      })).rejects.toSatisfy(error => error instanceof SystemTaskExecutionError && error.code === 'managed_guest_cli_release_downgrade');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains the installed-version failure instead of treating the CLI as absent', async () => {
    await expect(resolveManagedGuestCliSource({ homeUrl: 'https://home.example', binaryPath: '$HOME/.happier/cli/current/happier',
      fetchImpl: homeFetch('public-release', ['0.3.5']).boundary,
      runRemoteText: async () => ({ status: 1, stdout: '', stderr: 'private output' }),
    })).rejects.toMatchObject({ code: 'guest_cli_version_unavailable' });
  });
  it('preserves release rate-limit recovery as a typed task failure', async () => {
    const boundary: typeof fetch = async input => String(input).endsWith('/v1/features')
      ? Response.json({ capabilities: { guestCli: { source: 'public-release', line: '0.3', channel: 'stable' } } })
      : new Response('', { status: 429, headers: { 'x-ratelimit-remaining': '0' } });
    await expect(resolveManagedGuestCliSource({ homeUrl: 'https://home.example', binaryPath: '/missing/happier', fetchImpl: boundary,
      runRemoteText: async () => ({ status: 0, stdout: 'managed_guest_cli_absent', stderr: '' }),
    })).rejects.toSatisfy(error => error instanceof SystemTaskExecutionError && error.code === 'github_rate_limited');
  });
});
