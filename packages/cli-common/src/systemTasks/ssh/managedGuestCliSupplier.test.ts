import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, rm, mkdir, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { prepareManagedGuestCliBuildInput, resolveManagedGuestCliBuildIdentity, resolveManagedGuestCliSource, installManagedGuestCliViaRemoteDownload, selectManagedGuestCliPayload } from './managedGuestCliSupplier.js';
import { GuestCliIdentityV1Schema } from '@happier-dev/protocol/features';
import { createCliPayloadFixture } from '../testkit/createCliPayloadFixture.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import { installRemoteFirstPartyComponentPayload } from '../kinds/remoteFirstPartyPayloadInstaller.js';
import { safeBashSingleQuote } from '../../ssh/shellQuote.js';

const exec = promisify(execFile);
describe('managed guest CLI source supplier', () => {
  it('refuses a missing guest target or an archive from another Home without downloading a substitute', () => {
    const guestCli = GuestCliIdentityV1Schema.parse({ source: 'home-payload', line: '0.3', channel: 'stable', payloads: [{
      target: { os: 'linux', arch: 'x64' }, sha256: 'a'.repeat(64), url: 'https://other-home.example/payload.tar.gz',
    }] });
    for (const target of [{ os: 'linux', arch: 'arm64' }, { os: 'linux', arch: 'x64' }] as const) {
      expect(() => selectManagedGuestCliPayload({ guestCli, homeUrl: 'https://home.example', target }))
        .toThrow(expect.objectContaining({ code: 'guest_payload_missing' }));
    }
  });
  it.each([{ matching: false, transport: 'native' }, { matching: true, transport: 'native' },
    { matching: false, transport: 'ssh' }, { matching: true, transport: 'ssh' }])(
    'uses the admitted Home archive pin before extraction or execution ($transport matching=$matching)', async ({ matching, transport }) => {
    if (process.platform === 'win32') return; // Guest download/extraction is a POSIX remote boundary.
    const root = await mkdtemp(join(tmpdir(), 'happier-home-guest-export-'));
    const fixture = await createCliPayloadFixture();
    const home = join(root, 'home');
    const archivePath = join(root, 'payload.tar.gz');
    const requested: string[] = [];
    let archive = new Uint8Array();
    const server = createServer((request, response) => {
      requested.push(request.url ?? '');
      if (request.url === '/v1/runtime/guest-cli/payloads/linux/x64') response.end(archive);
      else response.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(home);
      await exec('tar', ['-czf', archivePath, '-C', dirname(fixture.payloadRoot), basename(fixture.payloadRoot)]);
      const tools = join(root, 'tools');
      const extraction = join(root, 'extracted');
      const actualTar = (await exec('/bin/sh', ['-c', 'command -v tar'])).stdout.trim();
      await mkdir(tools);
      await writeFile(join(tools, 'tar'), `#!/bin/sh\nprintf extracted > ${safeBashSingleQuote(extraction)}\nexec ${safeBashSingleQuote(actualTar)} "$@"\n`, { mode: 0o755 });
      archive = new Uint8Array(await readFile(archivePath));
      const sha256 = createHash('sha256').update(archive).digest('hex');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
      const homeUrl = `http://127.0.0.1:${address.port}`;
      // The Home descriptor is this supplier's network boundary; server minting is covered by the composed Add Machine test.
      const guestCli = GuestCliIdentityV1Schema.parse({ source: 'home-payload', line: '0.3', channel: 'publicdev', payloads: [
        { target: { os: 'linux', arch: 'arm64' }, sha256: 'b'.repeat(64), url: '/v1/runtime/guest-cli/payloads/linux/arm64' },
        { target: { os: 'linux', arch: 'x64' }, sha256, url: '/v1/runtime/guest-cli/payloads/linux/x64' },
      ] });
      // The admitted producer descriptor remains fixed while download bytes change.
      if (!matching) archive = new Uint8Array([...archive, 0]);
      const guestCliPayload = selectManagedGuestCliPayload({ guestCli, homeUrl, target: { os: 'linux', arch: 'x64' } });
      const runRemoteText = async (command: string) => {
          try { return { status: 0, ...await exec('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home, PATH: `${tools}:${process.env.PATH}` } }) }; }
          catch (error) {
            if (!(error instanceof Error) || !('stdout' in error) || !('stderr' in error)) throw error;
            return { status: 1, stdout: String(error.stdout), stderr: String(error.stderr) };
          }
        };
      const install = transport === 'native' ? installManagedGuestCliViaRemoteDownload({ homeUrl, channel: 'stable', os: 'linux', arch: 'x64', guestCliPayload,
        fetchImpl: async () => { throw new Error('Admitted export must not reread live Home metadata'); }, runRemoteText,
      }) : installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli', homeUrl, channel: 'stable', guestCli }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: request => runRemoteText(request.remoteCommand),
        copyLocalDirectoryToRemote: async () => { throw new Error('Admitted HTTP export must not upload local payload'); },
      });
      if (matching) {
        const result = await install;
        expect(await readFile(join(home, '.happier/cli/current.version'), 'utf8')).toBe(`${result.versionId}\n`);
        await exec(join(home, '.happier/cli/current/happier'), []);
        expect(await readFile(extraction, 'utf8')).toBe('extracted');
      } else {
        await expect(install).rejects.toMatchObject({ code: 'remote_command_failed' });
        await expect(access(join(home, '.happier/cli/current/happier'))).rejects.toThrow();
        await expect(access(extraction)).rejects.toThrow();
      }
      expect(requested).toEqual(['/v1/runtime/guest-cli/payloads/linux/x64']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fixture.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
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
    await expect(resolveManagedGuestCliBuildIdentity({ homeUrl: 'https://home.example', target, fetchImpl: http.boundary }))
      .rejects.toMatchObject({ code: 'guest_architecture_unsupported' });
    expect(http.urls).toEqual([]);
  });
  it('refuses a Home payload for another image target', async () => {
    const local = { identity: 'a'.repeat(64), versionId: '0.3.0', target: { os: 'linux', arch: 'x64' } as const,
      archive: { contentsBase64: 'cGF5bG9hZA==', rootDirectory: 'payload' } };
    await expect(prepareManagedGuestCliBuildInput({ homeUrl: 'https://home.example', target: { os: 'linux', arch: 'arm64' },
      fetchImpl: homeFetch('home-payload').boundary,
      prepareLocalPayload: async () => local,
    })).rejects.toMatchObject({ code: 'guest_payload_missing' });
    await expect(resolveManagedGuestCliBuildIdentity({ homeUrl: 'https://home.example', target: { os: 'linux', arch: 'arm64' },
      fetchImpl: homeFetch('home-payload').boundary, readLocalPayloadMetadata: async () => local,
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
    await expect(resolveManagedGuestCliBuildIdentity({ homeUrl: 'https://home.example', target: { os: 'linux', arch: 'x64' }, fetchImpl,
      readLocalPayloadMetadata: async () => { throw new Error('Public identity must not read controller payload files'); },
    })).resolves.toEqual({ identity: 'public-release:0.3.10-preview.1', versionId: '0.3.10-preview.1', target: { os: 'linux', arch: 'x64' } });
    await expect(prepareManagedGuestCliBuildInput({ homeUrl: 'https://home.example', target: { os: 'linux', arch: 'x64' }, fetchImpl,
      prepareLocalPayload: async () => { throw new Error('Public release preparation must not read controller payload files'); },
    }))
      .rejects.toThrow(/signature verification failed/u);
    expect(urls).toContain('https://api.github.com/repos/happier-dev/happier/releases/tags/cli-v0.3.10-preview.1');
    expect(urls).not.toContain('https://downloads.example/cli.tar.gz');
  });
  it.each([404, 429, 503])('reports signed integrity HTTP %s as release unavailable before producing image input', async status => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const url = String(input); requested.push(url);
      if (url.endsWith('/v1/features')) return Response.json({ capabilities: { guestCli: { source: 'public-release', line: '0.3', channel: 'stable' } } });
      if (new URL(url).pathname.endsWith('/releases')) return Response.json([{ tag_name: 'cli-v0.3.10', draft: false, prerelease: false }]);
      if (url.includes('/releases/tags/')) return Response.json({ assets: [
        { name: 'checksums-happier-v0.3.10.txt', browser_download_url: 'https://downloads.example/checksums.txt' },
        { name: 'checksums-happier-v0.3.10.txt.minisig', browser_download_url: 'https://downloads.example/checksums.txt.minisig' },
        { name: 'happier-v0.3.10-linux-x64.tar.gz', browser_download_url: 'https://downloads.example/cli.tar.gz' },
      ] });
      return new Response('upstream content must stay private', { status });
    };
    await expect(prepareManagedGuestCliBuildInput({ homeUrl: 'https://home.example', target: { os: 'linux', arch: 'x64' }, fetchImpl }))
      .rejects.toMatchObject({ code: 'managed_guest_cli_release_unavailable', message: expect.stringContaining(`HTTP ${status}`) });
    expect(requested).not.toContain('https://downloads.example/cli.tar.gz');
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
    await expect(resolveManagedGuestCliBuildIdentity({ homeUrl: 'https://home.example', target: { os: 'linux', arch: 'x64' }, fetchImpl: http.boundary }))
      .resolves.toEqual({ identity: `public-release:${versionId}`, versionId, target: { os: 'linux', arch: 'x64' } });
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
