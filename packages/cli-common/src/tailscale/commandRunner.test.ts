import { describe, expect, it, vi } from 'vitest';

import {
  extractTailscaleServeApprovalUrl,
  resolveTailscaleBin,
  runTailscaleLogin,
  runTailscaleServeEnable,
  sanitizeTailscaleEnv,
  TailscaleCommandError,
  type TailscaleCommandRunner,
} from './commandRunner.js';

describe('sanitizeTailscaleEnv', () => {
  it('removes problematic inherited XPC state while preserving unrelated variables', () => {
    const env = sanitizeTailscaleEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      XPC_SERVICE_NAME: 'com.example.agent',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/tmp/home');
    expect(env.XPC_SERVICE_NAME).toBeUndefined();
  });
});

describe('resolveTailscaleBin', () => {
  it('prefers the unified explicit env override before legacy stack env', async () => {
    const resolved = await resolveTailscaleBin(
      {
        env: {
          HAPPIER_TAILSCALE_BIN: '/custom/tailscale',
          HAPPIER_STACK_TAILSCALE_BIN: '/legacy/tailscale',
        },
      },
      {
        resolveCommandOnPath: vi.fn(async () => null),
        isExecutable: vi.fn(async () => false),
      },
    );

    expect(resolved).toBe('/custom/tailscale');
  });

  it('falls back to the macOS app bundle CLI when PATH lookup misses', async () => {
    const isExecutable = vi.fn(async (path: string) => path === '/Applications/Tailscale.app/Contents/MacOS/tailscale');

    const resolved = await resolveTailscaleBin(
      {
        env: {},
      },
      {
        resolveCommandOnPath: vi.fn(async () => null),
        isExecutable,
      },
    );

    expect(resolved).toBe('/Applications/Tailscale.app/Contents/MacOS/tailscale');
  });
});

describe('runTailscaleLogin', () => {
  it('falls back from login --qr to login when the CLI does not support --qr', async () => {
    const runner = vi
      .fn<TailscaleCommandRunner>()
      .mockRejectedValueOnce(
        new TailscaleCommandError('tailscale login --qr failed', {
          command: '/bin/tailscale',
          args: ['login', '--qr'],
          exitCode: 1,
          stdout: '',
          stderr: 'flag provided but not defined: --qr',
        }),
      )
      .mockResolvedValueOnce({
        command: '/bin/tailscale',
        args: ['login'],
        exitCode: 0,
        stdout: 'logged in',
        stderr: '',
      });

    const result = await runTailscaleLogin(
      {
        env: {},
      },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: runner,
      },
    );

    expect(result.usedQr).toBe(false);
    expect(runner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: '/bin/tailscale', args: ['login', '--qr'] }),
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: '/bin/tailscale', args: ['login'] }),
    );
  });

  it('returns null actionUrl when the login output contains an unexpected https URL host', async () => {
    const runner = vi.fn<TailscaleCommandRunner>().mockResolvedValueOnce({
      command: '/bin/tailscale',
      args: ['login', '--qr'],
      exitCode: 0,
      stdout: 'To authenticate, visit https://evil.example.test/a/attack',
      stderr: '',
    });

    const result = await runTailscaleLogin(
      {
        env: {},
      },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: runner,
      },
    );

    expect(result.usedQr).toBe(true);
    expect(result.actionUrl).toBeNull();
  });
});

describe('runTailscaleServeEnable', () => {
  it('returns a structured approval URL instead of leaking raw logs when serve needs approval', async () => {
    const runner = vi.fn<TailscaleCommandRunner>().mockRejectedValueOnce(
      new TailscaleCommandError('tailscale serve --bg failed', {
        command: '/bin/tailscale',
        args: ['serve', '--bg', 'http://127.0.0.1:3005'],
        exitCode: 1,
        stdout: '',
        stderr: 'To authorize your tailnet, visit https://login.tailscale.com/f/serve?node=node-123',
      }),
    );

    const result = await runTailscaleServeEnable(
      {
        env: {},
        upstreamUrl: 'http://127.0.0.1:3005',
      },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: runner,
      },
    );

    expect(result.approvalUrl).toBe('https://login.tailscale.com/f/serve?node=node-123');
    expect(result.httpsUrl).toBeNull();
    expect(result.rawStatus).toContain('login.tailscale.com/f/serve?node=node-123');
  });
});

describe('runTailscaleStatusJson', () => {
  it('parses a logged-in status snapshot without exposing raw command output', async () => {
    const mod = await import('./commandRunner.js') as {
      runTailscaleStatusJson?: (
        params?: { env?: NodeJS.ProcessEnv },
        deps?: {
          resolveTailscaleBin?: (params: { env?: NodeJS.ProcessEnv }) => Promise<string>;
          runCommand?: TailscaleCommandRunner;
        },
      ) => Promise<{
        backendState: string | null;
        authUrl: string | null;
        dnsName: string | null;
        tailnetName: string | null;
        tailscaleIps: readonly string[];
        loggedIn: boolean;
      }>;
    };

    expect(mod.runTailscaleStatusJson).toBeTypeOf('function');

    const result = await mod.runTailscaleStatusJson!(
      { env: {} },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: vi.fn(async () => ({
          command: '/bin/tailscale',
          args: ['status', '--json'],
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: 'Running',
            AuthURL: '',
            HaveNodeKey: true,
            TailscaleIPs: ['100.64.0.10'],
            Self: {
              DNSName: 'relay.tailf00.ts.net.',
            },
            CurrentTailnet: {
              Name: 'example-tailnet',
            },
          }),
          stderr: '',
        })),
      },
    );

    expect(result).toEqual({
      backendState: 'Running',
      authUrl: null,
      dnsName: 'relay.tailf00.ts.net',
      tailnetName: 'example-tailnet',
      tailscaleIps: ['100.64.0.10'],
      loggedIn: true,
    });
  });

  it('treats login-required status as logged out when tailscale advertises an auth URL', async () => {
    const mod = await import('./commandRunner.js') as {
      runTailscaleStatusJson?: (
        params?: { env?: NodeJS.ProcessEnv },
        deps?: {
          resolveTailscaleBin?: (params: { env?: NodeJS.ProcessEnv }) => Promise<string>;
          runCommand?: TailscaleCommandRunner;
        },
      ) => Promise<{
        backendState: string | null;
        authUrl: string | null;
        dnsName: string | null;
        tailnetName: string | null;
        tailscaleIps: readonly string[];
        loggedIn: boolean;
      }>;
    };

    expect(mod.runTailscaleStatusJson).toBeTypeOf('function');

    const result = await mod.runTailscaleStatusJson!(
      { env: {} },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: vi.fn(async () => ({
          command: '/bin/tailscale',
          args: ['status', '--json'],
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: 'NeedsLogin',
            AuthURL: 'https://login.tailscale.com/a/example',
            HaveNodeKey: false,
          }),
          stderr: '',
        })),
      },
    );

    expect(result).toEqual({
      backendState: 'NeedsLogin',
      authUrl: 'https://login.tailscale.com/a/example',
      dnsName: null,
      tailnetName: null,
      tailscaleIps: [],
      loggedIn: false,
    });
  });
});

describe('extractTailscaleServeApprovalUrl', () => {
  it('extracts only the supported tailscale serve approval URL', () => {
    expect(
      extractTailscaleServeApprovalUrl(
        'Visit https://login.tailscale.com/f/serve?node=node-123 to continue, then retry.',
      ),
    ).toBe('https://login.tailscale.com/f/serve?node=node-123');
  });
});

describe('tailscale install strategy', () => {
  it('resolves the macOS installer strategy and extracts the current pkg download URL from the stable manifest', async () => {
    const mod = await import('./index.js') as {
      resolveTailscaleInstallStrategy?: (platform: NodeJS.Platform) => {
        kind: 'downloadAndLaunch' | 'manual';
        docsUrl: string;
      } | null;
      extractTailscaleInstallerDownloadUrl?: (params: {
        manifestText: string;
        manifestUrl: string;
        platform: NodeJS.Platform;
      }) => string | null;
    };

    expect(mod.resolveTailscaleInstallStrategy).toBeTypeOf('function');
    expect(mod.extractTailscaleInstallerDownloadUrl).toBeTypeOf('function');

    expect(mod.resolveTailscaleInstallStrategy?.('darwin')).toMatchObject({
      kind: 'downloadAndLaunch',
      docsUrl: 'https://tailscale.com/download/mac',
    });
    expect(
      mod.extractTailscaleInstallerDownloadUrl?.({
        platform: 'darwin',
        manifestUrl: 'https://pkgs.tailscale.com/stable/',
        manifestText: [
          '<a href="Tailscale-1.96.2-macos.zip">zip</a>',
          '<a href="Tailscale-1.96.2-macos.pkg">pkg</a>',
        ].join('\n'),
      }),
    ).toBe('https://pkgs.tailscale.com/stable/Tailscale-1.96.2-macos.pkg');
  });

  it('prefers the standard Windows installer exe over the full bundle or MSI variants', async () => {
    const mod = await import('./index.js') as {
      extractTailscaleInstallerDownloadUrl?: (params: {
        manifestText: string;
        manifestUrl: string;
        platform: NodeJS.Platform;
      }) => string | null;
    };

    expect(mod.extractTailscaleInstallerDownloadUrl).toBeTypeOf('function');
    expect(
      mod.extractTailscaleInstallerDownloadUrl?.({
        platform: 'win32',
        manifestUrl: 'https://pkgs.tailscale.com/stable/',
        manifestText: [
          '<a href="tailscale-setup-full-1.96.3.exe">full</a>',
          '<a href="tailscale-setup-1.96.3.exe">standard</a>',
          '<a href="tailscale-setup-1.96.3-amd64.msi">msi</a>',
        ].join('\n'),
      }),
    ).toBe('https://pkgs.tailscale.com/stable/tailscale-setup-1.96.3.exe');
  });
});
