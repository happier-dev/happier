import { describe, expect, it, vi } from 'vitest';

import {
  extractTailscaleServeApprovalUrl,
  resolveTailscaleBin,
  runTailscaleFunnelEnable,
  runTailscaleLogin,
  runTailscaleServeEnable,
  runTailscaleServeStatus,
  runTailscaleStatusJson,
  runTailscaleStatus,
  runTailscaleOperatorObservation,
  runTailscaleDown,
  runTailscaleUp,
  runTailscaleFunnelDisable,
  runTailscaleServeDisable,
  runTailscaleServeReset,
  sanitizeTailscaleEnv,
  TailscaleCommandError,
  type TailscaleCommandRunner,
} from './commandRunner.js';

describe('runTailscaleStatus', () => {
  it('preserves capability URLs in raw JSON for native port selection', async () => {
    const stdout = JSON.stringify({ Self: { CapMap: { 'https://tailscale.com/cap/funnel-ports?ports=10000': [] } } });
    const runCommand: TailscaleCommandRunner = async request => ({ ...request, exitCode: 0,
      stdout: request.args.includes('--json') ? stdout : 'text status', stderr: '' });
    expect(await runTailscaleStatus({ tailscaleBin: '/bin/tailscale', json: true }, { runCommand })).toBe(stdout);
    expect(await runTailscaleStatus({ tailscaleBin: '/bin/tailscale' }, { runCommand })).toBe('text status');
  });
});

describe('runTailscaleServeStatus', () => {
  it('reads the native JSON inventory on the selected socket and preserves the text default', async () => {
    const requests: string[][] = [];
    const runCommand: TailscaleCommandRunner = async request => {
      requests.push([...request.args]);
      return { ...request, exitCode: 0, stdout: '{}', stderr: '' };
    };
    const params = { tailscaleBin: '/bin/tailscale', socketPath: '/run/relay/tailscaled.sock' };
    expect(await runTailscaleServeStatus({ ...params, json: true }, { runCommand })).toBe('{}');
    await runTailscaleServeStatus(params, { runCommand });
    expect(requests).toEqual([
      ['--socket=/run/relay/tailscaled.sock', 'serve', 'status', '--json'],
      ['--socket=/run/relay/tailscaled.sock', 'serve', 'status'],
    ]);
  });
});


describe('runTailscaleOperatorObservation', () => {
  it('uses the same selected socket for membership and HTTPS effects including readback', async () => {
    const requests: { args: readonly string[] }[] = [];
    const params = { tailscaleBin: '/bin/tailscale', socketPath: '/run/private-tailscale/tailscaled.sock' };
    const deps = { runCommand: async (request: Parameters<TailscaleCommandRunner>[0]) => {
      requests.push(request);
      return { ...request, exitCode: 0, stdout: '', stderr: '' };
    } };
    await runTailscaleLogin(params, deps);
    await runTailscaleUp(params, deps);
    await runTailscaleDown(params, deps);
    await runTailscaleServeEnable({ ...params, upstreamUrl: 'http://localhost:3000' }, deps);
    await runTailscaleFunnelEnable({ ...params, upstreamUrl: 'http://localhost:3000' }, deps);
    await runTailscaleServeDisable(params, deps);
    await runTailscaleFunnelDisable(params, deps);
    await runTailscaleServeReset(params, deps);
    expect(requests.map(request => request.args)).toEqual([
      ['--socket=/run/private-tailscale/tailscaled.sock', 'login', '--qr'],
      ['--socket=/run/private-tailscale/tailscaled.sock', 'up'],
      ['--socket=/run/private-tailscale/tailscaled.sock', 'down'],
      ['--socket=/run/private-tailscale/tailscaled.sock', 'serve', '--bg', 'http://localhost:3000'],
      ['--socket=/run/private-tailscale/tailscaled.sock', 'serve', 'status'],
      ['--socket=/run/private-tailscale/tailscaled.sock', 'funnel', '--bg', 'http://localhost:3000'],
      ['--socket=/run/private-tailscale/tailscaled.sock', 'funnel', 'status'],
      ['--socket=/run/private-tailscale/tailscaled.sock', 'serve', '--https=443', '--set-path=/', 'off'],
      ['--socket=/run/private-tailscale/tailscaled.sock', 'funnel', '--https=443', '--set-path=/', 'off'],
      ['--socket=/run/private-tailscale/tailscaled.sock', 'serve', 'reset'],
    ]);
  });

  it.each([
    [{ OperatorUser: 'happier', Persist: { PrivateNodeKey: 'not-an-observation' } }, 'allowed'],
    [{ OperatorUser: 'another-user' }, 'denied'],
    [{ OperatorUser: '' }, 'denied'],
    [{ BackendState: 'Running' }, 'unknown'],
    [{ OperatorUser: null }, 'unknown'],
    [{ OperatorUser: ['happier'] }, 'unknown'],
    [null, 'unknown'],
  ] as const)('reads only native operator evidence: %j', async (prefs, authorization) => {
    const requests: unknown[] = [];
    const observation = await runTailscaleOperatorObservation({ daemonUsername: 'happier', tailscaleBin: '/bin/tailscale',
      socketPath: '/run/private-tailscale/tailscaled.sock' }, {
      runCommand: async request => {
        requests.push(request);
        return { ...request, exitCode: 0, stdout: JSON.stringify(prefs), stderr: '' };
      },
    });
    expect(observation).toEqual({ authorization });
    expect(requests).toEqual([expect.objectContaining({ command: '/bin/tailscale',
      args: ['--socket=/run/private-tailscale/tailscaled.sock', 'debug', 'prefs'] })]);
  });

  it('leaves malformed or unreadable native evidence unknown without a mutation or retry', async () => {
    for (const stdout of ['not json', '{"OperatorUser":"happier"}']) {
      const requests: unknown[] = [];
      const observation = await runTailscaleOperatorObservation({ daemonUsername: 'happier', tailscaleBin: '/bin/tailscale' }, {
        runCommand: async request => {
          requests.push(request);
          if (stdout.startsWith('{')) throw new TailscaleCommandError('read denied', { ...request, exitCode: 1, stdout, stderr: 'denied' });
          return { ...request, exitCode: 0, stdout, stderr: '' };
        },
      });
      expect(observation).toEqual({ authorization: 'unknown' });
      expect(requests).toEqual([expect.objectContaining({ args: ['debug', 'prefs'] })]);
    }
  });

  it('does no native work without the exact daemon identity', async () => {
    const runCommand = vi.fn<TailscaleCommandRunner>();
    expect(await runTailscaleOperatorObservation({ daemonUsername: null }, { runCommand })).toEqual({ authorization: 'unknown' });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('never treats successful-looking output from a failed native read as authority', async () => {
    const runCommand: TailscaleCommandRunner = async request => ({ ...request,
      exitCode: 1, stdout: '{"OperatorUser":"happier"}', stderr: 'permission denied' });
    expect(await runTailscaleOperatorObservation({ daemonUsername: 'happier', tailscaleBin: '/bin/tailscale' }, { runCommand }))
      .toEqual({ authorization: 'unknown' });
  });

  it('preserves cancellation instead of turning it into an operator fact', async () => {
    const controller = new AbortController(); controller.abort();
    const runCommand = vi.fn<TailscaleCommandRunner>();
    await expect(runTailscaleOperatorObservation({ daemonUsername: 'happier', signal: controller.signal }, { runCommand }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(runCommand).not.toHaveBeenCalled();
  });
});

// OS boundary: make accidental controller-local inference observable for SSH runners.
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: vi.fn(() => ({
    controllerOverlay: [{ address: '100.64.0.10', family: 'IPv4', internal: false }],
  })),
}));

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
  it('uses the documented pinned-port enable and scoped off forms for the relay', async () => {
    const requests: string[][] = [];
    const runCommand: TailscaleCommandRunner = async request => {
      requests.push([...request.args]);
      return { ...request, exitCode: 0, stdout: '', stderr: '' };
    };
    const params = { tailscaleBin: '/fixture/tailscale', httpsPort: 10000, servePath: '/' };
    await runTailscaleFunnelEnable({ ...params, upstreamUrl: 'http://127.0.0.1:3340' }, { runCommand });
    await runTailscaleFunnelDisable(params, { runCommand });
    expect(requests).toEqual([
      ['funnel', '--bg', '--https=10000', 'http://127.0.0.1:3340'],
      ['funnel', 'status'],
      ['funnel', '--https=10000', '--set-path=/', 'off'],
    ]);
  });
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
  it('never uses controller-local interfaces as evidence for an injected target transport', async () => {
    const snapshot = await runTailscaleStatusJson({ tailscaleBin: '/bin/tailscale', env: {} }, {
      runCommand: async (request) => ({
        command: request.command, args: request.args, exitCode: 0, stderr: '',
        stdout: JSON.stringify({ BackendState: 'Running', TUN: true, TailscaleIPs: ['100.64.0.10'] }),
      }),
    });
    expect(snapshot).toMatchObject({ running: true, interfaceName: null, sourceRanges: [] });
  });

  it('keeps membership readable when the same-target OS inspection fails', async () => {
    const snapshot = await runTailscaleStatusJson({ tailscaleBin: '/bin/tailscale', env: {} }, {
      runCommand: async (request) => ({
        command: request.command, args: request.args, exitCode: 0, stderr: '',
        stdout: JSON.stringify({ BackendState: 'Running', TUN: true, TailscaleIPs: ['100.64.0.10'] }),
      }),
      readNetworkInterfaces: () => { throw new Error('native interfaces unavailable'); },
    });
    expect(snapshot).toMatchObject({ loggedIn: true, running: true, interfaceName: null, sourceRanges: [] });
  });


  it('carries native scope and DNS facts through the actual status command owner', async () => {
    const readNetworkInterfaces = vi.fn(() => ({
      utun7: [{ address: '100.64.0.10', family: 'IPv4' as const, internal: false }],
    }));
    const runner = vi.fn<TailscaleCommandRunner>(async (request) => ({
      command: request.command, args: request.args, exitCode: 0, stderr: '',
      stdout: JSON.stringify({
        BackendState: 'Running', TUN: true, TailscaleIPs: ['100.64.0.10'],
        CurrentTailnet: { Name: 'example-tailnet', MagicDNSEnabled: false },
      }),
    }));
    expect(runner).not.toHaveBeenCalled();
    expect(readNetworkInterfaces).not.toHaveBeenCalled();
    const snapshot = await runTailscaleStatusJson({ env: {}, tailscaleBin: '/bin/tailscale' }, {
      runCommand: runner, readNetworkInterfaces,
    });
    expect(snapshot).toMatchObject({
      magicDnsEnabled: false, interfaceName: 'utun7', sourceRanges: ['100.64.0.0/10'],
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(readNetworkInterfaces).toHaveBeenCalledTimes(1);
  });


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
      magicDnsEnabled: null,
      interfaceName: null,
      sourceRanges: [],
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
      magicDnsEnabled: null,
      interfaceName: null,
      sourceRanges: [],
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
