import { describe, expect, it, vi } from 'vitest';

import {
  extractTailscaleServeApprovalUrl,
  resolveTailscaleBin,
  runTailscaleFunnelEnable,
  runTailscaleLogin,
  runTailscaleServeEnable,
  runTailscaleStatusJson,
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
        env: { PATH: '' },
      },
      {
        isExecutable,
      },
    );

    expect(resolved).toBe('/Applications/Tailscale.app/Contents/MacOS/tailscale');
  });

  it('does not fall back to the macOS app bundle CLI when a custom PATH resolver is provided', async () => {
    const resolveCommandOnPath = vi.fn(async () => null);
    const isExecutable = vi.fn(async () => true);

    await expect(
      resolveTailscaleBin(
        { env: { PATH: '' } },
        { resolveCommandOnPath, isExecutable },
      ),
    ).rejects.toThrow(/CLI not found/i);

    expect(isExecutable).not.toHaveBeenCalled();
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

  it('pins the https port and owned path when enabling serve', async () => {
    const runner = vi.fn<TailscaleCommandRunner>()
      .mockResolvedValueOnce({
        command: '/bin/tailscale',
        args: ['serve', '--bg', '--https=8443', '--set-path=/__happier/transfer', 'http://127.0.0.1:46001'],
        exitCode: 0,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: '/bin/tailscale',
        args: ['serve', 'status'],
        exitCode: 0,
        stdout: 'https://machine.tailnet.ts.net:8443\n|-- /__happier/transfer proxy http://127.0.0.1:46001',
        stderr: '',
      });

    const result = await runTailscaleServeEnable(
      {
        env: {},
        upstreamUrl: 'http://127.0.0.1:46001',
        httpsPort: 8443,
        servePath: '/__happier/transfer',
      },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: runner,
      },
    );

    expect(runner).toHaveBeenNthCalledWith(1, expect.objectContaining({
      command: '/bin/tailscale',
      args: ['serve', '--bg', '--https=8443', '--set-path=/__happier/transfer', 'http://127.0.0.1:46001'],
    }));
    expect(result).toEqual({
      approvalUrl: null,
      httpsUrl: 'https://machine.tailnet.ts.net:8443',
      rawStatus: 'https://machine.tailnet.ts.net:8443\n|-- /__happier/transfer proxy http://127.0.0.1:46001',
    });
  });

  it('returns the https URL for the owned path and https port when status includes other mappings for the same upstream', async () => {
    const runner = vi.fn<TailscaleCommandRunner>()
      .mockResolvedValueOnce({
        command: '/bin/tailscale',
        args: ['serve', '--bg', '--https=8443', '--set-path=/__happier/transfer', 'http://127.0.0.1:46001'],
        exitCode: 0,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: '/bin/tailscale',
        args: ['serve', 'status'],
        exitCode: 0,
        stdout: [
          'https://machine.tailnet.ts.net',
          '|-- / proxy http://127.0.0.1:46001',
          '',
          'https://machine.tailnet.ts.net:8443',
          '|-- /__happier/transfer proxy http://127.0.0.1:46001',
        ].join('\n'),
        stderr: '',
      });

    const result = await runTailscaleServeEnable(
      {
        env: {},
        upstreamUrl: 'http://127.0.0.1:46001',
        httpsPort: 8443,
        servePath: '/__happier/transfer',
      },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: runner,
      },
    );

    expect(result.httpsUrl).toBe('https://machine.tailnet.ts.net:8443');
  });

  it('does not fall back to a different serve path on the same upstream', async () => {
    const runner = vi.fn<TailscaleCommandRunner>()
      .mockResolvedValueOnce({
        command: '/bin/tailscale',
        args: ['serve', '--bg', '--https=8443', '--set-path=/__happier/transfer', 'http://127.0.0.1:46001'],
        exitCode: 0,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: '/bin/tailscale',
        args: ['serve', 'status'],
        exitCode: 0,
        stdout: [
          'https://other.tailnet.ts.net:8443',
          '|-- / proxy http://127.0.0.1:46001',
        ].join('\n'),
        stderr: '',
      });

    const result = await runTailscaleServeEnable(
      {
        env: {},
        upstreamUrl: 'http://127.0.0.1:46001',
        httpsPort: 8443,
        servePath: '/__happier/transfer',
      },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: runner,
      },
    );

    expect(result.httpsUrl).toBeNull();
  });
});

describe('runTailscaleFunnelEnable', () => {
  it('returns the https URL for the requested upstream instead of the first status entry', async () => {
    const runner = vi.fn<TailscaleCommandRunner>()
      .mockResolvedValueOnce({
        command: '/bin/tailscale',
        args: ['funnel', '--bg', 'http://127.0.0.1:46001'],
        exitCode: 0,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: '/bin/tailscale',
        args: ['funnel', 'status'],
        exitCode: 0,
        stdout: [
          'https://other.tailnet.ts.net',
          '|-- / proxy http://127.0.0.1:8080',
          '',
          'https://machine.tailnet.ts.net',
          '|-- / proxy http://127.0.0.1:46001',
        ].join('\n'),
        stderr: '',
      });

    const result = await runTailscaleFunnelEnable(
      {
        env: {},
        upstreamUrl: 'http://127.0.0.1:46001',
      },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: runner,
      },
    );

    expect(result).toEqual({
      approvalUrl: null,
      httpsUrl: 'https://machine.tailnet.ts.net',
      rawStatus: [
        'https://other.tailnet.ts.net',
        '|-- / proxy http://127.0.0.1:8080',
        '',
        'https://machine.tailnet.ts.net',
        '|-- / proxy http://127.0.0.1:46001',
      ].join('\n'),
    });
  });
});

describe('runTailscaleServeDisable', () => {
  it('disables only the owned https path instead of resetting all serve config', async () => {
    const mod = await import('./commandRunner.js');
    const runner = vi.fn<TailscaleCommandRunner>().mockResolvedValueOnce({
      command: '/bin/tailscale',
      args: ['serve', '--https=8443', '--set-path=/__happier/transfer', 'off'],
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    await mod.runTailscaleServeDisable(
      {
        env: {},
        httpsPort: 8443,
        servePath: '/__happier/transfer',
      },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: runner,
      },
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: '/bin/tailscale',
      args: ['serve', '--https=8443', '--set-path=/__happier/transfer', 'off'],
    }));
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
        running: boolean;
        daemonReachable: boolean;
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
      running: true,
      daemonReachable: true,
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
        running: boolean;
        daemonReachable: boolean;
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
      running: false,
      daemonReachable: true,
    });
  });
});

describe('runTailscaleStatusJson daemon reachability', () => {
  const daemonDownRunner: TailscaleCommandRunner = async () => {
    throw new TailscaleCommandError(
      "Command failed: tailscale status --json\nfailed to connect to local tailscaled; it doesn't appear to be running",
      {
        command: '/bin/tailscale',
        args: ['status', '--json'],
        exitCode: 1,
        stdout: '',
        stderr: "failed to connect to local tailscaled; it doesn't appear to be running (sock=/var/run/tailscale/tailscaled.sock)",
      },
    );
  };

  it('returns a daemon-down snapshot instead of throwing when tailscaled is not running', async () => {
    const result = await runTailscaleStatusJson(
      { env: {} },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: vi.fn(daemonDownRunner),
      },
    );

    expect(result.daemonReachable).toBe(false);
    expect(result.running).toBe(false);
    expect(result.loggedIn).toBe(false);
    expect(result.backendState).toBeNull();
  });

  it('reports a signed-in machine whose backend is stopped as reachable but not running', async () => {
    const result = await runTailscaleStatusJson(
      { env: {} },
      {
        resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
        runCommand: vi.fn(async () => ({
          command: '/bin/tailscale',
          args: ['status', '--json'],
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: 'Stopped',
            AuthURL: '',
            HaveNodeKey: true,
            TailscaleIPs: ['100.64.0.10'],
            Self: { DNSName: 'relay.tailf00.ts.net.' },
            CurrentTailnet: { Name: 'example-tailnet' },
          }),
          stderr: '',
        })),
      },
    );

    expect(result.daemonReachable).toBe(true);
    expect(result.loggedIn).toBe(true);
    expect(result.running).toBe(false);
  });

  it('still throws when the tailscale binary itself cannot be executed', async () => {
    await expect(
      runTailscaleStatusJson(
        { env: {} },
        {
          resolveTailscaleBin: vi.fn(async () => '/bin/tailscale'),
          runCommand: vi.fn(async () => {
            throw new TailscaleCommandError('spawn /bin/tailscale ENOENT', {
              command: '/bin/tailscale',
              args: ['status', '--json'],
              exitCode: 1,
              stdout: '',
              stderr: '',
            });
          }),
        },
      ),
    ).rejects.toThrow(/ENOENT/u);
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
