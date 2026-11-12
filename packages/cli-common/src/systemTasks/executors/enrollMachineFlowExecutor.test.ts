import { describe, expect, it, vi } from 'vitest';

import { createEnrollMachineFlowExecutorFromHappierJsonExecutor } from './enrollMachineFlowExecutor.js';
import { runEnrollMachineFlow } from '../flows/enrollMachineFlow.js';

describe('createEnrollMachineFlowExecutorFromHappierJsonExecutor', () => {
  it('settles an explicitly process-managed daemon from its healthy control observation without waiting for a user service', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let settled = false;
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor: {
      runHappierText: async () => ({ status: 0, stdout: '', stderr: '' }),
      runHappierJson: async () => {
        reads++;
        return { service: { installed: false }, daemon: { running: true, healthy: true }, auth: { needsAuth: false } };
      },
    } });
    const result = executor.waitForReadyDaemon!(Object.assign({ timeoutMs: 1_000, requireMachineControlReady: true },
      { requireServiceInstalled: false })).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(reads).toBe(1);
    } finally {
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      vi.useRealTimers();
    }
  });

  it('keeps waiting beyond the former phase cutoff until the daemon is ready', async () => {
    vi.useFakeTimers();
    let ready = false;
    let reads = 0;
    let settled = false;
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor: {
      runHappierText: async () => ({ status: 0, stdout: '', stderr: '' }),
      runHappierJson: async () => {
        reads += 1;
        return { service: { installed: true }, daemon: { running: ready, healthy: ready }, auth: { needsAuth: false, machineId: 'this-machine' } };
      },
    } });
    const result = executor.waitForReadyDaemon!({}).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(90_000);
      expect(settled).toBe(false);
      const readsBeforeReady = reads;
      ready = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toMatchObject({ daemonRunning: true, machineId: 'this-machine' });
      expect(reads).toBe(readsBeforeReady + 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      ready = true;
      await vi.runOnlyPendingTimersAsync();
      await result;
      vi.useRealTimers();
    }
  });

  it('settles a daemon exit before readiness with its existing log pointer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let running = true;
    let reads = 0;
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor: {
      runHappierText: async (args) => {
        expect(args).toEqual(['daemon', 'logs']);
        return { status: 0, stdout: '/tmp/this-daemon.log\n', stderr: '' };
      },
      runHappierJson: async () => {
        reads += 1;
        return { service: { installed: true }, daemon: { running, healthy: false, pid: 314 }, auth: { needsAuth: false } };
      },
    } });
    const result = executor.waitForReadyDaemon!({ signal: controller.signal, timeoutMs: null, requireMachineControlReady: true });
    // Attach the failure observer before the process-exit publication.
    const failed = expect(result).rejects.toMatchObject({ code: 'daemon_service_not_ready', message: expect.stringContaining('/tmp/this-daemon.log') });
    void failed.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      running = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(reads).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
      await failed;
    } finally { controller.abort(); await Promise.allSettled([result, failed]); vi.useRealTimers(); }
  });

  it('withdraws the managed readiness observation on cancellation without further native reads', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let reads = 0;
      const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor: {
        runHappierText: async () => ({ status: 0, stdout: '', stderr: '' }),
        runHappierJson: async () => {
          reads++;
          return { service: { installed: true }, daemon: { running: true, healthy: false }, auth: { needsAuth: false } };
        },
      } });
      const result = executor.waitForReadyDaemon!({ signal: controller.signal, timeoutMs: 60_000, requireMachineControlReady: true });
      const cancelled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await cancelled;
      const settledReads = reads;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toBe(settledReads);
    } finally { vi.useRealTimers(); }
  });

  it('repairs local-only registration by approving the complete pairing envelope over stdin', async () => {
    const request = {
      publicKey: 'repair-request',
      pairing: { secretB64Url: 'ephemeral-secret', createdAtMs: 100, expiresAtMs: 200 },
      supportsTokenOnly: true,
      url: 'https://home.test/pair',
    };
    let approved = false;
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierText: async () => ({ status: 0, stdout: '', stderr: '' }),
        // CLI process boundary: enforce the approver's request-envelope contract.
        runHappierJson: async (args, opts) => {
          if (args.includes('request')) return request;
          if (args.includes('approve')) {
            expect(args).toEqual(['auth', 'approve', '--public-key', request.publicKey, '--request-json-stdin', '--json']);
            expect(JSON.parse(opts?.input ?? 'null')).toEqual({
              publicKey: request.publicKey, pairing: request.pairing, supportsTokenOnly: true,
            });
            approved = true;
            return { ok: true };
          }
          if (args.includes('wait')) {
            expect(approved).toBe(true);
            return { machineId: 'machine-repaired' };
          }
          throw new Error('Unexpected CLI command');
        },
      },
    });
    const result = await runEnrollMachineFlow({
      executor,
      relayProfile: { serverUrl: 'https://home.test', webappUrl: 'https://home.test', localServerUrl: null },
      initialAuthStatus: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'local-only', machineId: null },
      steps: { configureRelay: false, installService: false, startService: false, verifyService: false },
      emit: () => undefined,
    });
    expect(result.machineId).toBe('machine-repaired');
  });
  it.each(['server-confirmed', 'local-only'] as const)('claims app-approved replacement pairing for a different account with %s registration', async (registrationState) => {
    const commands: string[][] = [];
    let paired = false;
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierText: async () => ({ status: 0, stdout: PROFILE_SCOPED_SERVER_HELP, stderr: '' }),
        runHappierJson: async (args) => {
          commands.push([...args]);
          if (args.includes('status')) return { ok: true, data: {
            authenticated: true, credentialState: 'valid', machineRegistrationState: paired ? 'server-confirmed' : registrationState,
            accountId: paired ? 'account-new' : 'account-old', machineId: paired ? 'machine-new' : 'machine-old',
          } };
          if (args.includes('request')) return { publicKey: 'replacement-request' };
          if (args.includes('wait')) { paired = true; return { machineId: 'machine-new' }; }
          return { ok: true };
        },
      },
      options: { scopeToConfiguredServer: true, knownServerScope: { serverId: 'home', activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' } },
    });
    let approved = false;
    const flow = {
      relayProfile: { serverUrl: 'https://home.test', webappUrl: 'https://home.test', localServerUrl: null },
      executor,
      expectedAccountId: 'account-new',
      approvePairingRequest: async () => { approved = true; },
      steps: { installService: false, startService: false, verifyService: false },
      emit: () => undefined,
    };
    const result = await runEnrollMachineFlow(flow);
    expect(approved).toBe(true);
    expect(commands).toContainEqual(['--server', 'home', 'auth', 'wait', '--public-key', 'replacement-request', '--json']);
    expect(commands.some((args) => args.includes('approve'))).toBe(false);
    expect(result.machineId).toBe('machine-new');
  });
  it('refuses to change the service when replacement pairing did not prove the selected account', async () => {
    const commands: string[][] = [];
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierText: async () => ({ status: 0, stdout: PROFILE_SCOPED_SERVER_HELP, stderr: '' }),
        runHappierJson: async (args) => {
          commands.push([...args]);
          if (args.includes('status')) return { ok: true, data: {
            authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed',
            accountId: 'account-old', machineId: 'machine-old',
          } };
          if (args.includes('request')) return { publicKey: 'replacement-request' };
          if (args.includes('wait')) return { machineId: 'machine-new' };
          return { ok: true };
        },
      },
    });
    const flow = {
      relayProfile: { serverUrl: 'https://home.test', webappUrl: 'https://home.test', localServerUrl: null },
      executor,
      expectedAccountId: 'account-new',
      approvePairingRequest: async () => undefined,
      steps: { verifyService: false },
      emit: () => undefined,
    };
    await expect(runEnrollMachineFlow(flow)).rejects.toMatchObject({ code: 'account_mismatch' });
    expect(commands.some((args) => args.includes('service'))).toBe(false);
  });
  it('uses the service takeover contract for install and start when manual relay takeover is enabled', async () => {
    const runHappierJson = vi.fn(async () => ({ ok: true }));
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierJson,
        runHappierText: vi.fn(),
      },
      options: {
        takeOverManualRelayRuntime: true,
      },
    });

    await executor.installDaemonService?.();
    await executor.startDaemonService?.();

    expect(runHappierJson).toHaveBeenNthCalledWith(1, ['service', 'install', '--takeover', '--json']);
    expect(runHappierJson).toHaveBeenNthCalledWith(2, ['service', 'start', '--takeover', '--json']);
  });
  it('keeps the terminal selection and scopes every later command to the configured Home profile', async () => {
    const calls: Array<{ args: readonly string[]; targetMode: string | undefined }> = [];
    const managedByRequests: Array<string | undefined> = [];
    const runHappierJson = vi.fn(async (args: readonly string[], opts?: Readonly<{ env?: NodeJS.ProcessEnv }>) => {
      calls.push({ args, targetMode: opts?.env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE });
      if (args.includes('install')) managedByRequests.push(opts?.env?.HAPPIER_DAEMON_SERVICE_MANAGED_BY);
      if (args[0] === 'server' && args[1] === 'set') {
        return { ok: true, kind: 'server_set', data: { profile: { id: 'home' }, active: { id: 'cloud' }, used: false } };
      }
      if (args.includes('auth')) {
        return { ok: true, data: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'm1' } };
      }
      return { ok: true };
    });
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierJson,
        runHappierText: vi.fn(async () => ({ status: 0, stdout: PROFILE_SCOPED_SERVER_HELP, stderr: '' })),
      },
      options: { scopeToConfiguredServer: true },
    });

    await executor.configureRelay({ serverUrl: 'http://127.0.0.1:43110', webappUrl: 'http://127.0.0.1:43110', localServerUrl: null });
    await executor.readAuthStatus();
    await executor.installDaemonService?.({ replaceExisting: true });
    await executor.restartDaemonService?.();

    expect(calls).toEqual([
      {
        args: ['server', 'set', '--server-url', 'http://127.0.0.1:43110', '--webapp-url', 'http://127.0.0.1:43110', '--no-use', '--json'],
        targetMode: undefined,
      },
      { args: ['--server', 'home', 'auth', 'status', '--json'], targetMode: 'pinned' },
      { args: ['--server', 'home', 'service', 'install', '--replace-existing=all', '--yes', '--json'], targetMode: 'pinned' },
      { args: ['--server', 'home', 'service', 'restart', '--json'], targetMode: 'pinned' },
    ]);
    // The pinned service this setup creates for the new Home is the desktop's (R15).
    expect(managedByRequests).toEqual(['desktop']);
  });
  it('keeps the service decided before the write for a Home that already had a profile', async () => {
    const targetModes: Array<string | undefined> = [];
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierText: vi.fn(async () => ({ status: 0, stdout: PROFILE_SCOPED_SERVER_HELP, stderr: '' })),
        runHappierJson: vi.fn(async (args: readonly string[], opts?: Readonly<{ env?: NodeJS.ProcessEnv }>) => {
          targetModes.push(opts?.env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE);
          return args[1] === 'set'
            ? { ok: true, kind: 'server_set', data: { profile: { id: 'home' }, active: { id: 'home' }, used: false } }
            : { ok: true };
        }),
      },
      options: {
        scopeToConfiguredServer: true,
        knownServerScope: { serverId: 'home', activeServerId: 'home', selectedService: null, targetMode: 'default-following' },
      },
    });

    await executor.configureRelay({ serverUrl: 'http://127.0.0.1:43110', webappUrl: 'http://127.0.0.1:43110', localServerUrl: null });
    await executor.startDaemonService?.();

    // No `server set` for a saved Home: its first command already addresses the decided service.
    expect(targetModes).toEqual(['default-following']);
  });
  it('uses the Home profile it resolved as saved, without rewriting it', async () => {
    // A resolved profile already points at this Home. Rewriting it would be wrong both ways: the
    // CLI's URL upsert never adopts an identity-bearing profile (it would save a second one), and
    // an in-place endpoint write would replace the Home's recorded canonical URL with the loopback
    // URL the app reaches it on (RV3-C2). Setup owns no field of an existing profile.
    const jsonCalls: string[][] = [];
    const textCalls: string[][] = [];
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierText: vi.fn(async (args: readonly string[]) => {
          textCalls.push([...args]);
          return { status: 0, stdout: PROFILE_SCOPED_SERVER_HELP, stderr: '' };
        }),
        runHappierJson: vi.fn(async (args: readonly string[]) => {
          jsonCalls.push([...args]);
          return { ok: true };
        }),
      },
      options: {
        scopeToConfiguredServer: true,
        knownServerScope: { serverId: 'home-2', activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' },
      },
    });

    await executor.configureRelay({ serverUrl: 'http://127.0.0.1:43110', webappUrl: 'http://127.0.0.1:43110', localServerUrl: 'http://127.0.0.1:43110' });
    await executor.readAuthStatus();

    expect(textCalls).toEqual([['server', 'help']]);
    expect(jsonCalls).toEqual([['--server', 'home-2', 'auth', 'status', '--json']]);
  });
  it('proves the CLI keeps the terminal selection before saving the Home, and refuses a released 0.2 CLI without writing', async () => {
    // A released 0.2 CLI (`cli-v0.2.12-preview.1`) ignores unknown `server set` flags: it would
    // select the Home (switching the terminal) and reply without a saved profile. Its own
    // `server help` usage line for `server set` is the read-only proof that it lacks `--no-use`.
    const calls: string[][] = [];
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierText: vi.fn(async (args: readonly string[]) => {
          calls.push([...args]);
          return { status: 0, stdout: RELEASED_0_2_SERVER_HELP, stderr: '' };
        }),
        runHappierJson: vi.fn(async (args: readonly string[]) => {
          calls.push([...args]);
          return RELEASED_0_2_SERVER_SET_REPLY;
        }),
      },
      options: { scopeToConfiguredServer: true },
    });

    await expect(executor.configureRelay({ serverUrl: 'http://127.0.0.1:43110', webappUrl: 'http://127.0.0.1:43110', localServerUrl: null }))
      .rejects.toMatchObject({ code: 'cli_capability_missing' });
    expect(calls).toEqual([['server', 'help']]);
  });
  it('names a server set reply without a saved, unselected profile as a missing capability', async () => {
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierText: vi.fn(async () => ({ status: 0, stdout: PROFILE_SCOPED_SERVER_HELP, stderr: '' })),
        runHappierJson: vi.fn(async () => RELEASED_0_2_SERVER_SET_REPLY),
      },
      options: { scopeToConfiguredServer: true },
    });

    await expect(executor.configureRelay({ serverUrl: 'http://127.0.0.1:43110', webappUrl: 'http://127.0.0.1:43110', localServerUrl: null }))
      .rejects.toMatchObject({ code: 'cli_capability_missing' });
  });
});

// `happier server help` stdout of the released `cli-v0.2.12-preview.1` CLI (help.ts at that tag).
const RELEASED_0_2_SERVER_HELP = `
happier server - Manage relay profiles

Usage:
  happier server list
  happier server current
  happier server add [--name <name>] [--server-url <url>] [--public-server-url <url>] [--webapp-url <url>] [--use] [--no-use] [--yes] [--start-daemon] [--install-service]
  happier server use <name-or-id>
  happier server remove <name-or-id> [--force]
  happier server test [<name-or-id>]
  happier server set [--server-id <id>] --server-url <url> [--public-server-url <url>] [--webapp-url <url>]
`;

const PROFILE_SCOPED_SERVER_HELP = `
Usage:
  happier server set [--server-id <id>] --server-url <url> [--local-server-url <url>] [--webapp-url <url>] [--no-use]
`;

// `server set --json` reply of the released `cli-v0.2.12-preview.1` CLI: it selected the profile.
const RELEASED_0_2_SERVER_SET_REPLY = {
  ok: true,
  kind: 'server_set',
  data: {
    active: {
      id: 'custom',
      name: 'custom',
      serverUrl: 'http://127.0.0.1:43110',
      comparableKey: 'http://127.0.0.1:43110',
      webappUrl: 'http://127.0.0.1:43110',
      lastUsedAt: 1_758_000_000_000,
    },
  },
};
