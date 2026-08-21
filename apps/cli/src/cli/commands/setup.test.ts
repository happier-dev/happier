import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/cli/commandRegistry';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

/**
 * `happier setup` orchestration, tested where it actually goes wrong.
 *
 * The planner has been tested since it was written; the handler had not been,
 * and every defect that shipped lived here — a relay choice that emitted no
 * command, a failed child that still reported success, and flags that were
 * honoured by the planner and then dropped on the way to `server add`,
 * `relay host install` and `auth login`.
 *
 * Mocks stop at the real boundaries: the spawned child command, the auth owner
 * that decides readiness, relay-profile storage, terminal prompts and agent-CLI
 * probing. Everything between them is the code under test.
 */

type SpawnedCommand = readonly string[];

const spawned: SpawnedCommand[] = [];
const spawnedEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
let installedServices: readonly import('@/daemon/service/cli').DaemonServiceListEntry[] = [];
let exitCodeByCommand = new Map<string, number>();
let activeProfile: { serverUrl: string } | null = null;
let readiness = { authenticated: false, machineRegistered: false };
let interactive = true;
let relayInstallResultUrl: string | null = null;
let tailscaleStatus: import('@happier-dev/cli-common/tailscale').TailscaleStatusSnapshot | null = null;
const multipleChoiceAnswers: string[] = [];
const promptInputAnswers: string[] = [];

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: (args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    spawned.push([...args]);
    spawnedEnvs.push(options?.env);
    if (args[0] === 'relay' && args[1] === 'host' && args[2] === 'install' && relayInstallResultUrl) {
      activeProfile = { serverUrl: relayInstallResultUrl };
    }
    const code = exitCodeByCommand.get(args.join(' ')) ?? 0;
    const handlers = new Map<string, (value: number) => void>();
    queueMicrotask(() => handlers.get('exit')?.(code));
    return {
      on(event: string, handler: (value: number) => void) {
        handlers.set(event, handler);
        return this;
      },
    };
  },
}));

vi.mock('@/auth/resolveActiveServerAuthReadiness', () => ({
  resolveActiveServerAuthReadiness: async () => ({
    credentials: readiness.authenticated ? { token: 't' } : null,
    authenticated: readiness.authenticated,
    unusableReason: readiness.authenticated ? null : 'credentials-rejected',
    machineId: readiness.machineRegistered ? 'machine-1' : null,
    machineRegistered: readiness.machineRegistered,
  }),
}));

vi.mock('@/server/serverProfiles', () => ({
  getActiveServerProfile: async () => activeProfile,
}));

vi.mock('@/runtime/managedTools/providerCliResolution', () => ({
  resolveProviderCliCommand: (agentId: string) => (agentId === 'claude' ? { command: 'claude' } : null),
}));

vi.mock('@/integrations/tailscale/tailscaleStatus', () => ({
  readTailscaleStatusSnapshot: async () => tailscaleStatus,
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/ownership/daemonServiceInventory')>();
  return {
    ...actual,
    resolveInstalledDaemonServiceInventoryForCurrentRelay: async () => installedServices,
  };
});

vi.mock('@/terminal/prompts/promptInput', () => ({
  isInteractiveTerminal: () => interactive,
  promptInput: async () => promptInputAnswers.shift() ?? '',
}));

vi.mock('@/terminal/prompts/promptMultipleChoice', () => ({
  promptMultipleChoice: async () => multipleChoiceAnswers.shift() ?? 'cloud',
}));

vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({
  promptConfirmYesNo: async () => false,
}));

vi.mock('@/ui/openBrowser', () => ({
  openBrowser: async () => false,
}));

const { handleSetupCliCommand } = await import('./setup');

function context(args: readonly string[]): CommandContext {
  return { args: ['setup', ...args], rawArgv: ['setup', ...args], terminalRuntime: null };
}

function commandsRun(): string[] {
  return spawned.map((args) => args.join(' '));
}

let output = captureConsoleText();
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  spawned.length = 0;
  spawnedEnvs.length = 0;
  multipleChoiceAnswers.length = 0;
  promptInputAnswers.length = 0;
  exitCodeByCommand = new Map();
  activeProfile = null;
  readiness = { authenticated: false, machineRegistered: false };
  interactive = true;
  relayInstallResultUrl = null;
  tailscaleStatus = null;
  installedServices = [];
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  output = captureConsoleText();
});

afterEach(() => {
  output.restore();
  process.exitCode = previousExitCode;
});

describe('happier setup — choosing a relay', () => {
  it('switches a machine pointed at a custom relay back to Cloud before signing in', async () => {
    activeProfile = { serverUrl: 'https://relay.example.com' };

    await handleSetupCliCommand(context(['--cloud']));

    expect(commandsRun()[0]).toBe('server use cloud');
    expect(commandsRun()[1]).toMatch(/^auth login/);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not touch relay selection on a machine that has none', async () => {
    await handleSetupCliCommand(context(['--cloud']));

    expect(commandsRun().filter((command) => command.startsWith('server '))).toEqual([]);
    expect(commandsRun()[0]).toMatch(/^auth login/);
  });

  it('adds and activates a relay the user already runs', async () => {
    await handleSetupCliCommand(context(['--relay', 'https://relay.example.com']));

    expect(commandsRun()[0]).toBe('server add --server-url https://relay.example.com --name relay.example.com --use');
    expect(commandsRun()[1]).toMatch(/^auth login/);
    expect(spawnedEnvs[0]?.HAPPIER_DEFER_SERVER_SELECTION_FOLLOW_UP).toBe('1');
    expect(spawnedEnvs[1]?.HAPPIER_DEFER_SERVER_SELECTION_FOLLOW_UP).toBeUndefined();
  });

  it('installs a relay on this computer and lets the install own relay selection', async () => {
    relayInstallResultUrl = 'https://studio.example.ts.net';

    await handleSetupCliCommand(context(['--this-computer']));

    expect(commandsRun()[0]).toBe('relay host install');
    expect(commandsRun().filter((command) => command.startsWith('server add'))).toEqual([]);
    expect(commandsRun()[1]).toMatch(/^auth login/);
    expect(spawnedEnvs[0]?.HAPPIER_DEFER_SERVER_SELECTION_FOLLOW_UP).toBe('1');
  });
});

describe('happier setup — readiness', () => {
  it('leaves a fully configured machine alone', async () => {
    activeProfile = { serverUrl: 'https://api.happier.dev' };
    readiness = { authenticated: true, machineRegistered: true };

    await handleSetupCliCommand(context([]));

    expect(commandsRun()).toEqual([]);
    expect(output.text()).toContain('already set up');
  });

  it('does not call a machine with rejected credentials already set up', async () => {
    activeProfile = { serverUrl: 'https://api.happier.dev' };
    readiness = { authenticated: false, machineRegistered: true };
    multipleChoiceAnswers.push('cloud');

    await handleSetupCliCommand(context([]));

    expect(output.text()).not.toContain('already set up');
    expect(commandsRun().some((command) => command.startsWith('auth login'))).toBe(true);
  });

  it('does not call a machine with no registered machine identity already set up', async () => {
    activeProfile = { serverUrl: 'https://api.happier.dev' };
    readiness = { authenticated: true, machineRegistered: false };

    await handleSetupCliCommand(context([]));

    expect(output.text()).not.toContain('already set up');
    expect(commandsRun()).toHaveLength(1);
    expect(commandsRun()[0]).toMatch(/^auth login/);
  });
});

describe('happier setup — a relay only this computer can reach', () => {
  it('reports the address the install actually selected instead of assuming a running tailnet was published', async () => {
    relayInstallResultUrl = 'http://127.0.0.1:3005';
    tailscaleStatus = {
      backendState: 'Running',
      authUrl: null,
      dnsName: 'studio.example.ts.net',
      tailnetName: 'example.ts.net',
      tailscaleIps: ['100.64.0.1'],
      loggedIn: true,
      running: true,
      daemonReachable: true,
    };

    await handleSetupCliCommand(context(['--this-computer']));

    expect(output.text()).toContain('reachable from this computer only');
    expect(output.text()).not.toContain('Your phone reaches this relay');
  });

  it('signs in from this computer instead of recommending the phone', async () => {
    // Mobile links deliberately drop a loopback relay address, so the mobile
    // route the auth selector recommends cannot reach this relay at all.
    relayInstallResultUrl = 'http://127.0.0.1:3005';

    await handleSetupCliCommand(context(['--this-computer']));

    const authCommand = commandsRun().find((command) => command.startsWith('auth login'));
    expect(authCommand).toContain('--method web');
    expect(output.text().toLowerCase()).toContain('cannot reach this relay');
  });

  it('leaves the choice of sign-in route open once the relay is reachable', async () => {
    relayInstallResultUrl = 'https://studio.example.ts.net';

    await handleSetupCliCommand(context(['--this-computer']));

    const authCommand = commandsRun().find((command) => command.startsWith('auth login'));
    expect(authCommand).not.toContain('--method');
  });
});

describe('happier setup — handing the terminal back', () => {
  it('bounds the sign-in wait so setup cannot own the terminal forever', async () => {
    await handleSetupCliCommand(context(['--cloud']));

    expect(commandsRun()[0]).toMatch(/^auth login .*--wait-timeout \d+/);
  });

  it('reports a failed step as a failure and runs nothing after it', async () => {
    activeProfile = { serverUrl: 'https://relay.example.com' };
    exitCodeByCommand.set('server use cloud', 1);

    await handleSetupCliCommand(context(['--cloud']));

    expect(commandsRun()).toEqual(['server use cloud']);
    expect(process.exitCode).toBe(1);
  });
});

describe('happier setup — unattended runs (--yes)', () => {
  it('does the relay work it can and stops at the sign-in a person has to approve', async () => {
    activeProfile = { serverUrl: 'https://relay.example.com' };

    await handleSetupCliCommand(context(['--cloud', '--yes']));

    expect(commandsRun()).toEqual(['server use cloud']);
    expect(output.text()).toContain('happier auth login');
    // Setup did not finish, and the installer reads a zero exit as "you're ready".
    expect(process.exitCode).toBe(1);
  });

  it('adds a relay the user already runs without stopping to ask for a profile name', async () => {
    // `server add` demands `--name` the moment it cannot prompt, and prompts for
    // one whenever it can — which is how an unattended setup stopped dead on a
    // question nobody was there to answer.
    await handleSetupCliCommand(context(['--relay', 'https://relay.example.com', '--yes']));

    expect(commandsRun()).toEqual([
      'server add --server-url https://relay.example.com --name relay.example.com --use',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('installs a relay on this computer and still stops before signing in', async () => {
    relayInstallResultUrl = 'https://studio.example.ts.net';

    await handleSetupCliCommand(context(['--this-computer', '--yes']));

    expect(commandsRun()).toEqual(['relay host install']);
    expect(process.exitCode).toBe(1);
  });

  it('never spawns a child that could stop on a question', async () => {
    // A script that runs `happier setup --yes` from a shell still has a
    // controlling terminal, so a child asked to decide for itself will happily
    // prompt into a terminal nobody is watching.
    await handleSetupCliCommand(context(['--relay', 'https://relay.example.com', '--yes']));

    expect(spawnedEnvs).not.toEqual([]);
    for (const env of spawnedEnvs) {
      expect(env?.HAPPIER_NONINTERACTIVE).toBe('1');
      // Handing a child a bare environment is how a spawned CLI loses its PATH
      // and fails for a reason that has nothing to do with setup.
      expect(env?.PATH ?? env?.Path).toBe(process.env.PATH ?? process.env.Path);
    }
  });

  it('leaves an interactive run\'s children free to ask their own questions', async () => {
    await handleSetupCliCommand(context(['--relay', 'https://relay.example.com']));

    for (const env of spawnedEnvs) {
      expect(env?.HAPPIER_NONINTERACTIVE).not.toBe('1');
    }
  });

  it('chooses no relay for a run that named none', async () => {
    await handleSetupCliCommand(context(['--yes']));

    expect(commandsRun()).toEqual([]);
    expect(output.text()).toContain('--cloud');
    expect(process.exitCode).toBe(1);
  });

  it('does the work even when the terminal is gone, because --yes said so', async () => {
    interactive = false;

    await handleSetupCliCommand(context(['--cloud', '--yes']));

    expect(commandsRun()).toEqual([]);
    expect(output.text()).toContain('happier auth login');
    expect(process.exitCode).toBe(1);
  });
});

describe('happier setup — unattended and malformed invocations', () => {
  it('creates nothing when there is no terminal to ask in', async () => {
    interactive = false;

    await handleSetupCliCommand(context([]));

    expect(commandsRun()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('creates nothing for --non-interactive even when a relay was named', async () => {
    activeProfile = { serverUrl: 'https://relay.example.com' };

    await handleSetupCliCommand(context(['--cloud', '--non-interactive']));

    expect(commandsRun()).toEqual([]);
    expect(output.text()).toContain('--yes');
    expect(process.exitCode).toBe(1);
  });

  it('refuses --yes together with --non-interactive', async () => {
    await handleSetupCliCommand(context(['--cloud', '--yes', '--non-interactive']));

    expect(commandsRun()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('refuses two different answers to the relay question', async () => {
    await handleSetupCliCommand(context(['--cloud', '--relay', 'https://relay.example.com']));

    expect(commandsRun()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('refuses an option it does not know instead of ignoring it', async () => {
    await handleSetupCliCommand(context(['--this-comptuer']));

    expect(commandsRun()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
