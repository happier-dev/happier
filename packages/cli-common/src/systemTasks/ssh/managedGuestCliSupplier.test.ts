import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManagedGuestCliSource } from './managedGuestCliSupplier.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

const exec = promisify(execFile);
describe('managed guest CLI source supplier', () => {
  afterEach(() => vi.unstubAllGlobals());
  const homeFetch = (source: 'home-payload' | 'public-release', releases: readonly string[] = []) => {
    const urls: string[] = [];
    const boundary: typeof fetch = async input => {
      const url = String(input); urls.push(url);
      return Response.json(url.endsWith('/v1/features')
        ? { capabilities: { guestCli: { source, line: '0.3' } } }
        : releases.map(version => ({ tag_name: `cli-v${version}`, draft: false, prerelease: false, assets: [] })));
    };
    return { boundary, urls };
  };
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
      ? Response.json({ capabilities: { guestCli: { source: 'public-release', line: '0.3' } } })
      : new Response('', { status: 429, headers: { 'x-ratelimit-remaining': '0' } });
    await expect(resolveManagedGuestCliSource({ homeUrl: 'https://home.example', binaryPath: '/missing/happier', fetchImpl: boundary,
      runRemoteText: async () => ({ status: 0, stdout: 'managed_guest_cli_absent', stderr: '' }),
    })).rejects.toSatisfy(error => error instanceof SystemTaskExecutionError && error.code === 'github_rate_limited');
  });
});
