import { describe, expect, it, vi } from 'vitest';

import { ensureTailscaleInstalled } from './ensureTailscaleInstalled.js';

type FetchResponse = Readonly<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

function createTextResponse(text: string, params: Readonly<{ ok?: boolean; status?: number; statusText?: string }> = {}): FetchResponse {
  return {
    ok: params.ok ?? true,
    status: params.status ?? 200,
    statusText: params.statusText ?? 'OK',
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function createBinaryResponse(bytes: Uint8Array, params: Readonly<{ ok?: boolean; status?: number; statusText?: string }> = {}): FetchResponse {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return {
    ok: params.ok ?? true,
    status: params.status ?? 200,
    statusText: params.statusText ?? 'OK',
    text: async () => '',
    arrayBuffer: async () => arrayBuffer,
  };
}

describe('ensureTailscaleInstalled', () => {
  it('returns ready immediately when tailscale is already available', async () => {
    const result = await ensureTailscaleInstalled({}, {
      platform: 'darwin',
      env: {},
      resolveTailscaleBin: async () => 'tailscale',
    });

    expect(result).toEqual({
      outcome: 'ready',
      installedNow: false,
      installerLaunched: false,
      tailscaleBin: 'tailscale',
    });
  });

  it('returns a manual-install prompt on Linux', async () => {
    const result = await ensureTailscaleInstalled({}, {
      platform: 'linux',
      env: {},
      resolveTailscaleBin: async () => {
        throw new Error('not found');
      },
      resolveInstallStrategy: () => ({
        kind: 'manual',
        platform: 'linux',
        docsUrl: 'https://tailscale.example.test/install',
      }),
    });

    expect(result).toEqual({
      outcome: 'prompt',
      installerLaunched: false,
      prompt: {
        platform: 'linux',
        url: 'https://tailscale.example.test/install',
        reason: 'manual_install_required',
      },
    });
  });

  it('downloads and launches the macOS installer, then resolves the CLI', async () => {
    const fetch = vi.fn(async (input: string) => {
      if (input === 'https://pkgs.tailscale.example.test/stable/') {
        return createTextResponse('<a href="tailscale-1.2.3-macos.pkg">download</a>');
      }
      if (input === 'https://pkgs.tailscale.example.test/stable/tailscale-1.2.3-macos.pkg') {
        return createBinaryResponse(new Uint8Array([1, 2, 3]));
      }
      throw new Error(`Unexpected fetch url: ${input}`);
    });
    const mkdir = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const runCommand = vi.fn(async () => ({ status: 0, stdout: '', stderr: '' }));

    let nowMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms;
    });
    const now = () => nowMs;

    let resolveCalls = 0;
    const resolveTailscaleBin = vi.fn(async () => {
      resolveCalls += 1;
      if (resolveCalls <= 2) {
        throw new Error('not found');
      }
      return 'tailscale';
    });

    const result = await ensureTailscaleInstalled({}, {
      platform: 'darwin',
      env: {},
      fetch,
      mkdir,
      writeFile,
      runCommand,
      now,
      sleep,
      resolveCacheDir: () => '/tmp/happier-cache',
      resolveTailscaleBin,
      resolveInstallStrategy: () => ({
        kind: 'downloadAndLaunch',
        platform: 'darwin',
        docsUrl: 'https://tailscale.example.test/download',
        manifestUrl: 'https://pkgs.tailscale.example.test/stable/',
        waitForCliTimeoutMs: 5_000,
        pollIntervalMs: 1_000,
        postInstallAppLaunch: null,
      }),
    });

    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/happier-cache/tailscale-1.2.3-macos.pkg',
      expect.any(Buffer),
    );
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'open',
      args: ['/tmp/happier-cache/tailscale-1.2.3-macos.pkg'],
    }));
    expect(result).toEqual({
      outcome: 'ready',
      installedNow: true,
      installerLaunched: true,
      tailscaleBin: 'tailscale',
    });
  });

  it('returns installer_unavailable when the manifest download fails', async () => {
    const result = await ensureTailscaleInstalled({}, {
      platform: 'darwin',
      env: {},
      resolveTailscaleBin: async () => {
        throw new Error('not found');
      },
      fetch: async () => createTextResponse('nope', { ok: false, status: 500, statusText: 'fail' }),
      resolveInstallStrategy: () => ({
        kind: 'downloadAndLaunch',
        platform: 'darwin',
        docsUrl: 'https://tailscale.example.test/download',
        manifestUrl: 'https://pkgs.tailscale.example.test/stable/',
        waitForCliTimeoutMs: 1_000,
        pollIntervalMs: 100,
        postInstallAppLaunch: null,
      }),
    });

    expect(result).toEqual({
      outcome: 'prompt',
      installerLaunched: false,
      prompt: {
        platform: 'darwin',
        url: 'https://tailscale.example.test/download',
        reason: 'installer_unavailable',
      },
    });
  });

  it('returns install_incomplete when the installer is launched but the CLI never becomes available', async () => {
    const fetch = vi.fn(async (input: string) => {
      if (input === 'https://pkgs.tailscale.example.test/stable/') {
        return createTextResponse('<a href="tailscale-1.2.3-macos.pkg">download</a>');
      }
      if (input === 'https://pkgs.tailscale.example.test/stable/tailscale-1.2.3-macos.pkg') {
        return createBinaryResponse(new Uint8Array([1, 2, 3]));
      }
      throw new Error(`Unexpected fetch url: ${input}`);
    });
    const runCommand = vi.fn(async () => ({ status: 0, stdout: '', stderr: '' }));

    let nowMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms;
    });
    const now = () => nowMs;

    const result = await ensureTailscaleInstalled({}, {
      platform: 'darwin',
      env: {},
      fetch,
      runCommand,
      now,
      sleep,
      resolveCacheDir: () => '/tmp/happier-cache',
      resolveTailscaleBin: async () => {
        throw new Error('not found');
      },
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      resolveInstallStrategy: () => ({
        kind: 'downloadAndLaunch',
        platform: 'darwin',
        docsUrl: 'https://tailscale.example.test/download',
        manifestUrl: 'https://pkgs.tailscale.example.test/stable/',
        waitForCliTimeoutMs: 2_000,
        pollIntervalMs: 1_000,
        postInstallAppLaunch: null,
      }),
    });

    expect(result).toEqual({
      outcome: 'prompt',
      installerLaunched: true,
      prompt: {
        platform: 'darwin',
        url: 'https://tailscale.example.test/download',
        reason: 'install_incomplete',
      },
    });
  });
});
