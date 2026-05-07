import { describe, expect, it, vi } from 'vitest';

import {
  buildRemoteSelfDownloadFirstPartyInstallCommand,
  resolveRemoteSelfDownloadFirstPartyInstallPlan,
} from './remoteSelfDownloadFirstPartyInstallCommand.js';

describe('remote self-download first-party installer command', () => {
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

  it('creates the remote install root before staging under $HOME', () => {
    const command = buildRemoteSelfDownloadFirstPartyInstallCommand({
      componentId: 'happier-cli',
      channel: 'stable',
      versionId: '1.2.3',
      archive: {
        name: 'happier-v1.2.3-linux-x64.tar.gz',
        url: 'https://downloads.example.test/happier.tar.gz',
      },
      expectedSha256: 'b'.repeat(64),
    });

    expect(command).toContain('mkdir -p $HOME/.happier');
    expect(command).toContain('mktemp -d $HOME/.happier/bootstrap-self-download.XXXXXX');
    expect(command).not.toContain("mktemp -d '$HOME/.happier/bootstrap-self-download.XXXXXX'");
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
      verifyMinisign: vi.fn(() => false),
    })).rejects.toThrow('[native-ssh-bootstrap] release checksums signature verification failed');
  });
});
