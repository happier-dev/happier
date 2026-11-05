import { SystemTaskExecutionError } from '../runSystemTask.js';
import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  buildRemoteSelfDownloadFirstPartyInstallCommand,
  resolveRemoteSelfDownloadFirstPartyInstallPlan,
} from './remoteSelfDownloadFirstPartyInstallCommand.js';

describe('remote self-download first-party installer command', () => {
  it.each([403, 429])('preserves the API %s rate-limit refusal for task and managed bootstrap consumers', async status => {
    const failure = await resolveRemoteSelfDownloadFirstPartyInstallPlan({
      componentId: 'happier-cli', channel: 'stable', os: 'linux', arch: 'x64',
      githubToken: '',
      fetchImpl: async () => new Response('{"message":"API rate limit exceeded"}', { status,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' } }),
      runRemoteText: async () => { throw new Error('Rate-limited metadata must not start guest downloads'); },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SystemTaskExecutionError);
    expect(failure).toMatchObject({ code: 'github_rate_limited',
      message: expect.stringContaining('Try again after') });
  });

  it.each([null, 302, 307])('resolves signed checksums through the guest when controller asset fetch lacks CORS, metadata redirect %s', async (status) => {
    const checksums = `${'c'.repeat(64)}  happier-v1.2.3-linux-x64.tar.gz\n`;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const prefix = Buffer.from('45640000000000000000', 'hex');
    const publicBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const signature = sign(null, Buffer.from(checksums), privateKey);
    const trustedComment = 'test release';
    const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), privateKey);
    const minisignPublicKey = `untrusted comment: test key\n${Buffer.concat([prefix, publicBytes]).toString('base64')}\n`;
    const minisignSignature = `untrusted comment: test signature\n${Buffer.concat([prefix, signature]).toString('base64')}\ntrusted comment: ${trustedComment}\n${globalSignature.toString('base64')}\n`;
    const credentialsByPath: Array<{ path: string; credentialPresent: boolean }> = [];
    const server = createServer((request, response) => {
      credentialsByPath.push({ path: request.url ?? '', credentialPresent: Boolean(request.headers.authorization) });
      if (request.url === '/checksums.txt') return void response.end(checksums);
      if (request.url === '/checksums.txt.minisig') return void response.end(minisignSignature);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
      const origin = `http://127.0.0.1:${address.port}`;
      if (request.url === '/release' && status !== null) {
        response.writeHead(status, { location: `http://127.0.0.2:${address.port}/release-complete` }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ assets: [
        { name: 'checksums-happier-v1.2.3.txt', browser_download_url: `${origin}/checksums.txt` },
        { name: 'checksums-happier-v1.2.3.txt.minisig', browser_download_url: `${origin}/checksums.txt.minisig` },
        { name: 'happier-v1.2.3-linux-x64.tar.gz', browser_download_url: `${origin}/archive.tar.gz` },
      ] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
      const origin = `http://127.0.0.1:${address.port}`;
      const fetchImpl: typeof fetch = async (url, init) => {
        if (String(url).includes('/checksums.txt')) throw new TypeError('Asset download blocked by CORS');
        return await fetch(String(url).startsWith('https://api.github.com/')
          ? `http://127.0.0.1:${address.port}/release` : url, init);
      };
      const plan = await resolveRemoteSelfDownloadFirstPartyInstallPlan({
        componentId: 'happier-cli', os: 'linux', arch: 'x64', githubToken: 'synthetic-test-credential', fetchImpl, minisignPublicKey,
        // Guest command IO is an external boundary; model its HTTP download without controller CORS.
        runRemoteText: async command => {
          const url = command.includes('/checksums.txt.minisig') ? `${origin}/checksums.txt.minisig` : `${origin}/checksums.txt`;
          const response = await fetch(url);
          return { status: response.ok ? 0 : 1, stdout: await response.text(), stderr: '' };
        },
      });
      expect(plan.versionId).toBe('1.2.3');
      expect(credentialsByPath).toEqual([
        { path: '/release', credentialPresent: true },
        ...(status === null ? [] : [{ path: '/release-complete', credentialPresent: false }]),
        { path: '/checksums.txt', credentialPresent: false },
        { path: '/checksums.txt.minisig', credentialPresent: false },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('builds an install command that verifies a locally resolved checksum without remote minisign', async () => {
    const command = buildRemoteSelfDownloadFirstPartyInstallCommand({
      componentId: 'happier-cli',
      channel: 'stable',
      versionId: '1.2.3',
      expectedSha256: 'a'.repeat(64),
      archive: {
        name: 'happier-v1.2.3-linux-x64.tar.gz',
        url: 'https://downloads.example.test/happier.tar.gz',
      },
    });

    expect(command).not.toContain('command -v minisign');
    expect(command).not.toContain('minisign -Vm');
    expect(command).not.toContain('checksums.txt.minisig');
    expect(command).toContain(`expected_sha='${'a'.repeat(64)}'`);
    expect(command).toContain('checksum verification failed');
    expect(command).not.toMatch(/curl\b[^|]*\|\s*(?:sh|bash)/u);
  });

  it('stages and promotes a verified self-download in a remote HOME containing spaces', async () => {
    if (process.platform === 'win32') return; // The remote installer runs on POSIX targets.
    const root = await mkdtemp(join(tmpdir(), 'happier-self-download-'));
    const home = join(root, 'home with spaces');
    const payload = join(root, 'payload');
    const archivePath = join(root, 'payload.tar.gz');
    const run = promisify(execFile);
    try {
      await mkdir(home);
      await mkdir(payload);
      await writeFile(join(payload, 'happier'), '#!/bin/sh\nprintf "%s\\n" installed\n');
      await run('tar', ['-czf', archivePath, '-C', root, 'payload']);
      const command = buildRemoteSelfDownloadFirstPartyInstallCommand({
        componentId: 'happier-cli', channel: 'stable', versionId: '1.2.3',
        archive: { name: 'payload.tar.gz', url: pathToFileURL(archivePath).href },
        expectedSha256: createHash('sha256').update(await readFile(archivePath)).digest('hex'),
      });
      await run('/bin/sh', ['-c', command], { cwd: root, env: { ...process.env, HOME: home } });
      await run(join(home, '.happier', 'cli', 'current', 'happier'), []);
      expect(await readFile(join(home, '.happier', 'cli', 'current.version'), 'utf8')).toBe('1.2.3\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves release metadata locally before building the remote install command', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith('/checksums.txt')) {
        return {
          ok: true,
          status: 200,
          text: async () => `${'c'.repeat(64)}  happier-v1.2.3-linux-x64.tar.gz\n`,
        } satisfies Pick<Response, 'ok' | 'status' | 'text'> as Response;
      }
      if (textUrl.endsWith('/checksums.txt.minisig')) {
        return {
          ok: true,
          status: 200,
          text: async () => 'trusted minisign payload',
        } satisfies Pick<Response, 'ok' | 'status' | 'text'> as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          assets: [
            {
              name: 'checksums-happier-v1.2.3.txt',
              browser_download_url: 'https://downloads.example.test/checksums.txt',
            },
            {
              name: 'checksums-happier-v1.2.3.txt.minisig',
              browser_download_url: 'https://downloads.example.test/checksums.txt.minisig',
            },
            {
              name: 'happier-v1.2.3-linux-x64.tar.gz',
              browser_download_url: 'https://downloads.example.test/happier.tar.gz',
            },
          ],
        }),
      } satisfies Pick<Response, 'ok' | 'status' | 'json'> as Response;
    });

    const plan = await resolveRemoteSelfDownloadFirstPartyInstallPlan({
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
      minisignPublicKey: 'RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t',
      fetchImpl,
      verifyMinisign: vi.fn(() => true),
      runRemoteText: async command => ({ status: 0, stdout: command.includes('.minisig')
        ? 'trusted minisign payload' : `${'c'.repeat(64)}  happier-v1.2.3-linux-x64.tar.gz\n`, stderr: '' }),
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/happier-dev/happier/releases/tags/cli-stable',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'application/vnd.github+json',
        }),
      }),
    );
    expect(plan.binaryPath).toBe('$HOME/.happier/cli/current/happier');
    expect(plan.versionId).toBe('1.2.3');
    expect(plan.command).toContain('https://downloads.example.test/happier.tar.gz');
    expect(plan.command).not.toContain('https://downloads.example.test/checksums.txt.minisig');
    expect(plan.command).toContain(`expected_sha='${'c'.repeat(64)}'`);
  });

  it('fails closed when local minisign verification rejects the checksums', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith('/checksums.txt')) {
        return {
          ok: true,
          status: 200,
          text: async () => `${'c'.repeat(64)}  happier-v1.2.3-linux-x64.tar.gz\n`,
        } satisfies Pick<Response, 'ok' | 'status' | 'text'> as Response;
      }
      if (textUrl.endsWith('/checksums.txt.minisig')) {
        return {
          ok: true,
          status: 200,
          text: async () => 'invalid minisign payload',
        } satisfies Pick<Response, 'ok' | 'status' | 'text'> as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          assets: [
            {
              name: 'checksums-happier-v1.2.3.txt',
              browser_download_url: 'https://downloads.example.test/checksums.txt',
            },
            {
              name: 'checksums-happier-v1.2.3.txt.minisig',
              browser_download_url: 'https://downloads.example.test/checksums.txt.minisig',
            },
            {
              name: 'happier-v1.2.3-linux-x64.tar.gz',
              browser_download_url: 'https://downloads.example.test/happier.tar.gz',
            },
          ],
        }),
      } satisfies Pick<Response, 'ok' | 'status' | 'json'> as Response;
    });

    await expect(resolveRemoteSelfDownloadFirstPartyInstallPlan({
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
      fetchImpl,
      runRemoteText: async command => ({ status: 0, stdout: command.includes('.minisig')
        ? 'invalid minisign payload' : `${'c'.repeat(64)}  happier-v1.2.3-linux-x64.tar.gz\n`, stderr: '' }),
    })).rejects.toThrow('[native-ssh-bootstrap] release checksums signature verification failed');
  });
});
