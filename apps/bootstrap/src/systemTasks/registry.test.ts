import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeSystemTask, type BackgroundServiceSetupGuidance } from '@happier-dev/cli-common/systemTasks';
import { createFakeTailscaleCli } from '@happier-dev/tests/testkit/tailscale/fakeTailscaleCli';
import { describe, expect, it, vi } from 'vitest';

import { createHsetupSystemTaskRegistry } from './registry.js';

function createFakeHappierCli(scenario: Readonly<{
  serverCurrent?: Record<string, unknown>;
  authStatus?: Record<string, unknown>;
  authRequests?: readonly Record<string, unknown>[];
  authWaits?: readonly Record<string, unknown>[];
  serviceStatuses?: readonly Record<string, unknown>[];
  daemonStatuses?: readonly Record<string, unknown>[];
}>): Readonly<{
  cliPath: string;
  cleanup: () => void;
  readInvocations: () => string[][];
}> {
  const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-'));
  const cliPath = join(rootDir, 'fake-happier');
  const statePath = join(rootDir, 'scenario.json');
  const logPath = join(rootDir, 'invocations.log');

  writeFileSync(statePath, JSON.stringify({
    serverCurrent: scenario.serverCurrent ?? {
      ok: true,
      kind: 'server_current',
      data: {
        active: {
          id: 'cloud',
          serverUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
      },
    },
    authStatus: scenario.authStatus ?? {
      ok: true,
      kind: 'auth_status',
      data: {
        authenticated: true,
        machineRegistered: true,
        machineId: 'machine-local-1',
      },
    },
    authRequests: scenario.authRequests ?? [
      {
        publicKey: 'public-key-local-1',
      },
    ],
    authWaits: scenario.authWaits ?? [
      {
        success: true,
        machineId: 'machine-local-1',
      },
    ],
    serviceStatuses: scenario.serviceStatuses ?? [
      {
        ok: true,
        platform: process.platform,
        installed: true,
        daemon: { running: true, pid: 4321 },
        system: { ok: true, output: 'service ready' },
      },
    ],
    daemonStatuses: scenario.daemonStatuses ?? [
      {
        server: {
          serverUrl: 'https://relay.example.test',
          localServerUrl: null,
          publicServerUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
        daemon: {
          running: true,
          pid: 4321,
        },
        service: {
          installed: true,
          running: true,
        },
        auth: {
          authenticated: true,
          machineRegistered: true,
          machineId: 'machine-local-1',
          needsAuth: false,
        },
      },
    ],
  }, null, 2));

  writeFileSync(cliPath, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const statePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
const logPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
const argv = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(argv) + '\\n');

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const command = argv.join(' ');

function printJson(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}

if (command === 'server current --json') {
  printJson(state.serverCurrent);
  process.exit(0);
}

if (command === 'auth status --json') {
  printJson(state.authStatus);
  process.exit(0);
}

if (command === 'auth request --json') {
  const requests = Array.isArray(state.authRequests) ? state.authRequests : [];
  const next = requests.length > 0
    ? requests.shift()
    : {
        publicKey: 'public-key-local-default',
      };
  state.authRequests = requests;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  printJson(next);
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'approve' && argv.includes('--json')) {
  printJson({ success: true });
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'wait' && argv.includes('--json')) {
  const waits = Array.isArray(state.authWaits) ? state.authWaits : [];
  const next = waits.length > 0
    ? waits.shift()
    : {
        success: true,
        machineId: 'machine-local-default',
      };
  state.authWaits = waits;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  printJson(next);
  process.exit(0);
}

if (command === 'daemon service status --json' || command === 'service status --json') {
  const statuses = Array.isArray(state.serviceStatuses) ? state.serviceStatuses : [];
  const next = statuses.length > 0
    ? statuses.shift()
    : {
        ok: true,
        platform: process.platform,
        installed: true,
        daemon: { running: true, pid: 1234 },
        system: { ok: true, output: 'service ready' },
      };
  state.serviceStatuses = statuses;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  printJson(next);
  process.exit(0);
}

if (command === 'daemon status --json') {
  const statuses = Array.isArray(state.daemonStatuses) ? state.daemonStatuses : [];
  const next = statuses.length > 0
    ? statuses.shift()
    : {
        server: {
          serverUrl: 'https://relay.example.test',
          localServerUrl: null,
          publicServerUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
        daemon: {
          running: true,
          pid: 1234,
        },
        service: {
          installed: true,
          running: true,
        },
        auth: {
          authenticated: true,
          machineRegistered: true,
          machineId: 'machine-local-default',
          needsAuth: false,
        },
      };
  state.daemonStatuses = statuses;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  printJson(next);
  process.exit(0);
}

if (argv[0] === 'server' && argv[1] === 'set' && argv.includes('--json')) {
  printJson({ ok: true, kind: 'server_set' });
  process.exit(0);
}

if (
  argv.includes('--json')
  && (
    (
      argv[0] === 'service'
      && (argv[1] === 'install' || argv[1] === 'start' || argv[1] === 'stop' || argv[1] === 'restart')
    )
    || (
      argv[0] === 'daemon'
      && argv[1] === 'service'
      && (argv[2] === 'install' || argv[2] === 'start' || argv[2] === 'stop' || argv[2] === 'restart')
    )
  )
) {
  printJson({ ok: true, platform: process.platform });
  process.exit(0);
}

process.stderr.write('Unexpected fake happier args: ' + command + '\\n');
process.exit(1);
`);
  chmodSync(cliPath, 0o755);
  writeFileSync(logPath, '');

  return {
    cliPath,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
    readInvocations() {
      const raw = readFileSync(logPath, 'utf8').trim();
      if (!raw) {
        return [];
      }
      return raw.split('\n').map((line) => JSON.parse(line) as string[]);
    },
  };
}

function restoreEnvVar(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previousValue;
}

type LifecycleEventSummary = Readonly<{
  type: 'progress' | 'prompt';
  stepId: string;
}>;

function summarizeSetupLifecycleEvents(events: readonly unknown[]): LifecycleEventSummary[] {
  const summary: LifecycleEventSummary[] = [];

  for (const event of events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      continue;
    }

    const record = event as Record<string, unknown>;
    if (typeof record.stepId !== 'string') {
      continue;
    }

    if (record.type === 'prompt') {
      summary.push({ type: 'prompt', stepId: record.stepId });
      continue;
    }

    if (record.type === 'progress' && !('data' in record)) {
      summary.push({ type: 'progress', stepId: record.stepId });
    }
  }

  return summary;
}

function createDefaultSetupThisComputerGuidance(
  overrides: Readonly<Partial<BackgroundServiceSetupGuidance>> = {},
): BackgroundServiceSetupGuidance {
  return {
    targetReleaseChannel: 'stable' as const,
    targetServerUrl: 'https://relay.example.test',
    currentHappierHomeDir: null,
    currentDefaultReleaseChannel: 'stable' as const,
    managedReleaseChannels: [],
    manualRelayOwner: null,
    exactDefaultServiceExists: false,
    conflictingServices: [],
    foreignHomeConflictingServices: [],
    shouldOfferDefaultReleaseChannelSwitch: false,
    shouldPromptForManualRelayTakeover: false,
    shouldPromptForServiceReplacement: false,
    ...overrides,
  };
}

async function executeSetupThisComputerTask(): Promise<Awaited<ReturnType<typeof executeSystemTask>>> {
  return await executeSystemTask({
    spec: {
      protocolVersion: 1,
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
      },
    },
    taskId: 'task_setup_1',
    registry: createHsetupSystemTaskRegistry({
      setupThisComputer: {
        readBackgroundServiceSetupGuidance: async () => createDefaultSetupThisComputerGuidance(),
      },
    }),
    now: () => 1700000000000,
    emitEvent() {},
  });
}

async function executeSetupRepairThisComputerTask(): Promise<Awaited<ReturnType<typeof executeSystemTask>>> {
  return await executeSystemTask({
    spec: {
      protocolVersion: 1,
      kind: 'setup.repairThisComputer.v1',
      params: {},
    },
    taskId: 'task_repair_1',
    registry: createHsetupSystemTaskRegistry(),
    now: () => 1700000000000,
    emitEvent() {},
  });
}

describe('createHsetupSystemTaskRegistry', () => {
  it('uses the publicdev release ring when setup.thisComputer.v1 specifies channel publicdev', async () => {
    const fakeCli = createFakeHappierCli({});
    const homeDir = join(fakeCli.cliPath, '..');
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousRepoDir = process.env.HAPPIER_STACK_REPO_DIR;
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_STACK_REPO_DIR = homeDir;
      delete process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(homeDir, 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(homeDir, 'invocations.log');

      const stablePath = join(homeDir, 'cli', 'current', 'happier');
      mkdirSync(join(homeDir, 'cli', 'current'), { recursive: true });
      writeFileSync(stablePath, `#!/bin/sh\nexit 1\n`);
      chmodSync(stablePath, 0o755);

      const devPath = join(homeDir, 'cli-dev', 'current', 'happier');
      mkdirSync(join(homeDir, 'cli-dev', 'current'), { recursive: true });
      writeFileSync(devPath, readFileSync(fakeCli.cliPath, 'utf8'));
      chmodSync(devPath, 0o755);

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'setup.thisComputer.v1',
          params: {
            surface: 'desktop.ui',
            target: 'thisComputer',
            channel: 'publicdev',
          },
        },
        taskId: 'task_setup_release_ring_publicdev',
        registry: createHsetupSystemTaskRegistry({
          setupThisComputer: {
            readBackgroundServiceSetupGuidance: async () => createDefaultSetupThisComputerGuidance({
              targetReleaseChannel: 'preview',
              currentDefaultReleaseChannel: 'stable',
              managedReleaseChannels: [
                {
                  releaseChannel: 'stable',
                  label: 'stable',
                  version: '1.0.0',
                  installationId: 'stable-install',
                  installationPath: '/managed/stable',
                  invokerName: 'happier',
                  isDefault: true,
                  onPath: true,
                },
                {
                  releaseChannel: 'preview',
                  label: 'dev',
                  version: '2.0.0-dev.1',
                  installationId: 'dev-install',
                  installationPath: '/managed/dev',
                  invokerName: 'hdev',
                  isDefault: false,
                  onPath: true,
                },
              ],
              exactDefaultServiceExists: true,
              shouldOfferDefaultReleaseChannelSwitch: true,
            }),
          },
        }),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_setup_release_ring_publicdev',
        ok: false,
        error: {
          code: 'prompt_required',
          message: 'Make preview the default release-channel before installing the default background service targeting https://relay.example.test?',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'current', '--json'],
        ['auth', 'status', '--json'],
        ['service', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_HOME_DIR', previousHomeDir);
      restoreEnvVar('HAPPIER_STACK_REPO_DIR', previousRepoDir);
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs setup.thisComputer.v1 with deterministic step ids and returns a machine id', async () => {
    const fakeCli = createFakeHappierCli({});
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'setup.thisComputer.v1',
          params: {
            surface: 'desktop.ui',
            target: 'thisComputer',
          },
        },
        taskId: 'task_setup_1',
        registry: createHsetupSystemTaskRegistry({
          setupThisComputer: {
            readBackgroundServiceSetupGuidance: async () => createDefaultSetupThisComputerGuidance(),
          },
        }),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(summarizeSetupLifecycleEvents(events)).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.ensureCli' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.resolveRelay' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.checkAuth' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.configureRelay' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.installService' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.startService' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.verifyService' }),
      ]);
      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_setup_1',
        ok: true,
        data: {
          machineId: 'machine-local-1',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'current', '--json'],
        ['auth', 'status', '--json'],
        ['service', 'status', '--json'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['service', 'install', '--json'],
        ['service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('can skip background service steps for setup.thisComputer.v1', async () => {
    const fakeCli = createFakeHappierCli({});
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'setup.thisComputer.v1',
          params: {
            surface: 'desktop.ui',
            target: 'thisComputer',
            installService: false,
            startService: false,
            verifyService: false,
          },
        },
        taskId: 'task_setup_2',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(summarizeSetupLifecycleEvents(events)).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.ensureCli' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.resolveRelay' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.checkAuth' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.configureRelay' }),
      ]);
      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_setup_2',
        ok: true,
        data: {
          machineId: 'machine-local-1',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'current', '--json'],
        ['auth', 'status', '--json'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('returns prompt_required for setup.thisComputer.v1 when guided setup wants to switch the default release channel first', async () => {
    const events: unknown[] = [];

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'setup.thisComputer.v1',
        params: {
          surface: 'desktop.ui',
          target: 'thisComputer',
          channel: 'preview',
        },
      },
      taskId: 'task_local_setup_prompt_release_channel',
      registry: createHsetupSystemTaskRegistry({
        setupThisComputer: {
          readActiveRelayProfile: async () => ({
            serverUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
            localServerUrl: null,
          }),
          createRecipeExecutor: () => ({
            configureRelay: async () => undefined,
            readAuthStatus: async () => ({ authenticated: true, machineId: 'machine-local-1' }),
            requestAuthPairing: async () => ({ publicKey: 'pub-key' }),
            waitForAuthPairing: async () => ({ machineId: 'machine-local-1' }),
            installDaemonService: async () => undefined,
            startDaemonService: async () => undefined,
            waitForReadyDaemon: async () => ({
              serviceInstalled: true,
              daemonRunning: true,
              needsAuth: false,
              machineId: 'machine-local-1',
            }),
          }),
          readBackgroundServiceSetupGuidance: async () => createDefaultSetupThisComputerGuidance({
            targetReleaseChannel: 'preview',
            currentDefaultReleaseChannel: 'stable',
            managedReleaseChannels: [
              {
                releaseChannel: 'stable',
                label: 'stable',
                version: '1.0.0',
                installationId: 'stable-install',
                installationPath: '/managed/stable',
                invokerName: 'happier',
                isDefault: true,
                onPath: true,
              },
              {
                releaseChannel: 'preview',
                label: 'preview',
                version: '2.0.0',
                installationId: 'preview-install',
                installationPath: '/managed/preview',
                invokerName: 'hprev',
                isDefault: false,
                onPath: true,
              },
            ],
            exactDefaultServiceExists: true,
            shouldOfferDefaultReleaseChannelSwitch: true,
          }),
          readCurrentRelayOwner: async () => null,
          switchDefaultReleaseChannel: async () => undefined,
          uninstallExistingDaemonServices: async () => undefined,
        },
      }),
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'progress',
        stepId: 'setup.thisComputer.resolveRelay',
      }),
      expect.objectContaining({
        type: 'progress',
        stepId: 'setup.thisComputer.checkAuth',
      }),
      expect.objectContaining({
        type: 'prompt',
        stepId: 'setup.thisComputer.preflight.releaseChannel',
        message: 'Make preview the default release-channel before installing the default background service targeting https://relay.example.test?',
        data: {
          kind: 'releaseChannel.switchDefaultForSetup',
          targetReleaseChannel: 'preview',
          currentDefaultReleaseChannel: 'stable',
          targetServerUrl: 'https://relay.example.test',
          managedReleaseChannels: expect.any(Array),
        },
      }),
    ]));
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_local_setup_prompt_release_channel',
      ok: false,
      error: {
        code: 'prompt_required',
        message: 'Make preview the default release-channel before installing the default background service targeting https://relay.example.test?',
      },
    });
  });

  it('runs setup.repairThisComputer.v1 when already authenticated', async () => {
    const fakeCli = createFakeHappierCli({});
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSetupRepairThisComputerTask();

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_repair_1',
        ok: true,
        data: {
          machineId: 'machine-local-1',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'current', '--json'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['auth', 'status', '--json'],
        ['service', 'install', '--json'],
        ['service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('uses the publicdev release ring when setup.repairThisComputer.v1 specifies channel dev', async () => {
    const fakeCli = createFakeHappierCli({});
    const homeDir = join(fakeCli.cliPath, '..');
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousRepoDir = process.env.HAPPIER_STACK_REPO_DIR;
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_STACK_REPO_DIR = homeDir;
      delete process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(homeDir, 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(homeDir, 'invocations.log');

      const stablePath = join(homeDir, 'cli', 'current', 'happier');
      mkdirSync(join(homeDir, 'cli', 'current'), { recursive: true });
      writeFileSync(stablePath, `#!/bin/sh\nexit 1\n`);
      chmodSync(stablePath, 0o755);

      const devPath = join(homeDir, 'cli-dev', 'current', 'happier');
      mkdirSync(join(homeDir, 'cli-dev', 'current'), { recursive: true });
      writeFileSync(devPath, readFileSync(fakeCli.cliPath, 'utf8'));
      chmodSync(devPath, 0o755);

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'setup.repairThisComputer.v1',
          params: {
            channel: 'dev',
          },
        },
        taskId: 'task_repair_release_ring_publicdev',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_repair_release_ring_publicdev',
        ok: true,
        data: {
          machineId: 'machine-local-1',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'current', '--json'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['auth', 'status', '--json'],
        ['service', 'install', '--json'],
        ['service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_HOME_DIR', previousHomeDir);
      restoreEnvVar('HAPPIER_STACK_REPO_DIR', previousRepoDir);
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('emits a prompt and fails setup.repairThisComputer.v1 when approval is required', async () => {
    const fakeCli = createFakeHappierCli({
      authStatus: {
        ok: false,
        kind: 'auth_status',
        error: {
          code: 'not_authenticated',
        },
      },
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'setup.repairThisComputer.v1',
          params: {},
        },
        taskId: 'task_repair_prompt_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_repair_prompt_1',
        ok: false,
        error: {
          code: 'prompt_required',
          message: 'Approve pairing request',
        },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'prompt',
        stepId: 'setup.repairThisComputer.authRequest',
      }));
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'current', '--json'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['auth', 'status', '--json'],
        ['auth', 'request', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('requests auth and waits for approval when auth is missing', async () => {
    const fakeCli = createFakeHappierCli({
      authStatus: {
        ok: false,
        kind: 'auth_status',
        error: {
          code: 'not_authenticated',
        },
      },
      authWaits: [
        {
          success: true,
          machineId: 'machine-local-auth-1',
        },
      ],
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-auth-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'setup.thisComputer.v1',
          params: {
            surface: 'desktop.ui',
            target: 'thisComputer',
          },
        },
        taskId: 'task_setup_1',
        registry: createHsetupSystemTaskRegistry({
          setupThisComputer: {
            readBackgroundServiceSetupGuidance: async () => createDefaultSetupThisComputerGuidance(),
          },
        }),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(summarizeSetupLifecycleEvents(events)).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.ensureCli' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.resolveRelay' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.checkAuth' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.configureRelay' }),
        expect.objectContaining({ type: 'prompt', stepId: 'setup.thisComputer.auth.request' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.auth.wait' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.installService' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.startService' }),
        expect.objectContaining({ type: 'progress', stepId: 'setup.thisComputer.verifyService' }),
      ]);
      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_setup_1',
        ok: true,
        data: {
          machineId: 'machine-local-auth-1',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'current', '--json'],
        ['auth', 'status', '--json'],
        ['service', 'status', '--json'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['auth', 'request', '--json'],
        ['auth', 'wait', '--public-key', 'public-key-local-1', '--json'],
        ['service', 'install', '--json'],
        ['service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('fails setup.thisComputer.v1 when local pairing does not expose a public key', async () => {
    const fakeCli = createFakeHappierCli({
      authStatus: {
        ok: true,
        kind: 'auth_status',
        data: {
          authenticated: true,
          machineRegistered: false,
        },
      },
      authRequests: [
        {},
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSetupThisComputerTask();

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_setup_1',
        ok: false,
        error: {
          code: 'invalid_cli_response',
          message: 'Received an invalid auth request response.',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'current', '--json'],
        ['auth', 'status', '--json'],
        ['service', 'status', '--json'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['auth', 'request', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('completes setup.thisComputer.v1 by pairing locally when already authenticated but no machine id is registered yet', async () => {
    const fakeCli = createFakeHappierCli({
      authStatus: {
        ok: true,
        kind: 'auth_status',
        data: {
          authenticated: true,
          machineRegistered: false,
        },
      },
      authRequests: [
        {
          publicKey: 'public-key-local-2',
        },
      ],
      authWaits: [
        {
          success: true,
          machineId: 'machine-local-2',
        },
      ],
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 9876,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-2',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSetupThisComputerTask();

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_setup_1',
        ok: true,
        data: {
          machineId: 'machine-local-2',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'current', '--json'],
        ['auth', 'status', '--json'],
        ['service', 'status', '--json'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['auth', 'request', '--json'],
        ['auth', 'approve', '--public-key', 'public-key-local-2', '--json'],
        ['auth', 'wait', '--public-key', 'public-key-local-2', '--json'],
        ['service', 'install', '--json'],
        ['service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('fails setup.thisComputer.v1 when the daemon service is not ready after setup', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: Array.from({ length: 8 }, () => ({
        server: {
          serverUrl: 'https://relay.example.test',
          localServerUrl: null,
          publicServerUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
        daemon: {
          running: false,
          pid: null,
        },
        service: {
          installed: false,
          running: false,
        },
        auth: {
          authenticated: true,
          machineRegistered: false,
          machineId: null,
          needsAuth: true,
        },
      })),
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    const previousTimeoutMs = process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS;
    const previousPollMs = process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');
      process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS = '150';
      process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS = '20';

      const result = await executeSetupThisComputerTask();

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_setup_1',
        ok: false,
        error: {
          code: 'daemon_service_not_ready',
          message: 'Background service did not reach a ready state for the selected Relay.',
        },
      });
      expect(fakeCli.readInvocations()).toContainEqual(['daemon', 'status', '--json']);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      restoreEnvVar('HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS', previousTimeoutMs);
      restoreEnvVar('HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS', previousPollMs);
      fakeCli.cleanup();
    }
  });

  it('runs daemon.service.status.v1 and reports the local daemon status snapshot', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.status.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_status_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_status_1',
        ok: true,
        data: expect.objectContaining({
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonMachineRegistered: true,
          daemonAccountId: null,
          daemonComparableKey: null,
        }),
      });
      expect(fakeCli.readInvocations()).toContainEqual(['daemon', 'status', '--json']);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs daemon.service.start.v1 and waits for the ready daemon status snapshot', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.start.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_start_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_start_1',
        ok: true,
        data: expect.objectContaining({
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonMachineRegistered: true,
          daemonAccountId: null,
          daemonComparableKey: null,
        }),
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['daemon', 'status', '--json'],
        ['service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs daemon.service.stop.v1 and stops the local daemon service through the canonical CLI wrapper', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: false,
            pid: null,
          },
          service: {
            installed: true,
            running: false,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.stop.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_stop_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_stop_1',
        ok: true,
        data: expect.objectContaining({
          serviceInstalled: true,
          daemonRunning: false,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonMachineRegistered: true,
          daemonAccountId: null,
          daemonComparableKey: null,
        }),
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['daemon', 'status', '--json'],
        ['service', 'stop', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs daemon.service.restart.v1 and restarts the local daemon service through the canonical CLI wrapper', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.restart.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_restart_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_restart_1',
        ok: true,
        data: expect.objectContaining({
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonMachineRegistered: true,
          daemonAccountId: null,
          daemonComparableKey: null,
        }),
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['daemon', 'status', '--json'],
        ['service', 'restart', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs relay.runtime.status.v1 with deterministic progress and result payloads', async () => {
    const events: unknown[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.status.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
        },
      },
      taskId: 'task_status_1',
      registry: createHsetupSystemTaskRegistry({
        relayRuntime: {
          async readStatus() {
            return {
              installed: true,
              version: '1.2.3',
              service: {
                active: true,
                enabled: true,
              },
              baseUrl: 'http://127.0.0.1:3005',
            };
          },
          async checkHealth() {
            return true;
          },
        },
      }),
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'progress',
        stepId: 'relay.status.inspect',
        message: 'Inspecting relay runtime',
      }),
      expect.objectContaining({
        type: 'progress',
        stepId: 'relay.status.health',
        message: 'Checking relay runtime health',
      }),
    ]);
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_status_1',
      ok: true,
      data: {
        installed: true,
        version: '1.2.3',
        relayUrl: 'http://127.0.0.1:3005',
        healthy: true,
        service: {
          active: true,
          enabled: true,
        },
      },
    });
  });

  it('runs relay.runtime.start.v1 through the lifecycle controller before returning fresh status', async () => {
    const controlled: string[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.start.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
        },
      },
      taskId: 'task_start_1',
      registry: createHsetupSystemTaskRegistry({
        relayRuntime: {
          async readStatus() {
            return {
              installed: true,
              version: '1.2.3',
              service: {
                active: true,
                enabled: true,
              },
              baseUrl: 'http://127.0.0.1:3005',
            };
          },
          async checkHealth() {
            return true;
          },
          async control(params) {
            controlled.push(params.action);
          },
        },
      }),
      emitEvent() {},
    });

    expect(controlled).toEqual(['start']);
    expect(result.ok).toBe(true);
  });

  it('runs relay.connectBackgroundService.v1 through the drift repair handler', async () => {
    const events: unknown[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.connectBackgroundService.v1',
        params: {
          activeRelayUrl: 'https://relay.example.test',
          activeWebappUrl: 'https://app.example.test',
          activeLocalRelayUrl: null,
          surface: 'desktop.ui',
        },
      },
      taskId: 'task_drift_1',
      registry: createHsetupSystemTaskRegistry({
        relayDriftRepair: {
          async connectBackgroundService(params) {
            return {
              repaired: true,
              relayUrl: params.activeRelayUrl,
            };
          },
        },
      }),
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_drift_1',
      ok: true,
      data: {
        repaired: true,
        relayUrl: 'https://relay.example.test',
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'progress',
        stepId: 'relay.drift.repair.start',
      }),
    ]);
  });

  it('repairs relay.connectBackgroundService.v1 by pairing and verifying daemon readiness when auth is still needed', async () => {
    const fakeCli = createFakeHappierCli({
      authStatus: {
        ok: true,
        kind: 'auth_status',
        data: {
          authenticated: true,
          machineRegistered: false,
        },
      },
      authRequests: [
        {
          publicKey: 'public-key-drift-1',
        },
      ],
      authWaits: [
        {
          success: true,
          machineId: 'machine-drift-1',
        },
      ],
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4567,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-drift-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'relay.connectBackgroundService.v1',
          params: {
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: null,
            surface: 'desktop.ui',
          },
        },
        taskId: 'task_drift_repair_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_drift_repair_1',
        ok: true,
        data: {
          repaired: true,
          activeRelayUrl: 'https://relay.example.test',
          activeWebappUrl: 'https://app.example.test',
          activeLocalRelayUrl: null,
          machineId: 'machine-drift-1',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['auth', 'status', '--json'],
        ['auth', 'request', '--json'],
        ['auth', 'approve', '--public-key', 'public-key-drift-1', '--json'],
        ['auth', 'wait', '--public-key', 'public-key-drift-1', '--json'],
        ['service', 'install', '--json'],
        ['service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('uses the publicdev release ring when daemon.service.status.v1 specifies channel dev', async () => {
    const fakeCli = createFakeHappierCli({});
    const homeDir = join(fakeCli.cliPath, '..');
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousRepoDir = process.env.HAPPIER_STACK_REPO_DIR;
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_STACK_REPO_DIR = homeDir;
      delete process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(homeDir, 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(homeDir, 'invocations.log');

      const stablePath = join(homeDir, 'cli', 'current', 'happier');
      mkdirSync(join(homeDir, 'cli', 'current'), { recursive: true });
      writeFileSync(stablePath, `#!/bin/sh\nexit 1\n`);
      chmodSync(stablePath, 0o755);

      const devPath = join(homeDir, 'cli-dev', 'current', 'happier');
      mkdirSync(join(homeDir, 'cli-dev', 'current'), { recursive: true });
      writeFileSync(devPath, readFileSync(fakeCli.cliPath, 'utf8'));
      chmodSync(devPath, 0o755);

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.status.v1',
          params: {
            target: { kind: 'local' },
            surface: 'desktop.ui',
            mode: 'user',
            channel: 'dev',
          },
        },
        taskId: 'task_daemon_status_release_ring_publicdev',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_status_release_ring_publicdev',
        ok: true,
        data: {
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonComparableKey: null,
          daemonAccountId: null,
          daemonMachineRegistered: true,
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_HOME_DIR', previousHomeDir);
      restoreEnvVar('HAPPIER_STACK_REPO_DIR', previousRepoDir);
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('returns prompt_required when remote.ssh.bootstrapMachine.v1 needs host trust', async () => {
    const events: unknown[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: {
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
          relay: {
            relayUrl: 'https://relay.example.test',
          },
          serviceMode: 'user',
        },
      },
      taskId: 'task_bootstrap_1',
      registry: createHsetupSystemTaskRegistry({
        remoteSshBootstrap: {
          async resolveHostTrust() {
            return {
              status: 'prompt',
              promptKind: 'sshHostTrust',
              promptMessage: 'Trust the remote SSH host key',
              promptData: {
                host: 'example.test',
                fingerprint: 'SHA256:test',
                knownHostKey: 'example.test ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ',
              },
              accept: async () => undefined,
            };
          },
        },
      }),
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'progress',
        stepId: 'ssh.trust',
        message: 'Verifying SSH host trust',
      }),
      expect.objectContaining({
        type: 'prompt',
        stepId: 'ssh.hostTrust',
        message: 'Trust the remote SSH host key',
        data: {
          kind: 'ssh.trustHost',
          host: 'example.test',
          fingerprint: 'SHA256:test',
          knownHostKey: 'example.test ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ',
        },
      }),
    ]);
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_bootstrap_1',
      ok: false,
      error: {
        code: 'prompt_required',
        message: 'Trust the remote SSH host key',
      },
    });
  });

  it('returns prompt_required when remote.ssh.manageHost.v1 needs host trust', async () => {
    const events: unknown[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.manageHost.v1',
        params: {
          action: 'testConnection',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
      },
      taskId: 'task_remote_manage_1',
      registry: createHsetupSystemTaskRegistry({
        remoteSshBootstrap: {
          async resolveHostTrust() {
            return {
              status: 'prompt',
              promptKind: 'sshHostTrust',
              promptMessage: 'Trust the remote SSH host key',
              promptData: {
                host: 'example.test',
                fingerprint: 'SHA256:test',
                knownHostKey: 'example.test ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ',
              },
              accept: async () => undefined,
            };
          },
        },
      }),
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'progress',
        stepId: 'ssh.trust',
        message: 'Verifying SSH host trust',
      }),
      expect.objectContaining({
        type: 'prompt',
        stepId: 'ssh.hostTrust',
        message: 'Trust the remote SSH host key',
        data: {
          kind: 'ssh.trustHost',
          host: 'example.test',
          fingerprint: 'SHA256:test',
          knownHostKey: 'example.test ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ',
        },
      }),
    ]);
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_remote_manage_1',
      ok: false,
      error: {
        code: 'prompt_required',
        message: 'Trust the remote SSH host key',
      },
    });
  });

  it('completes remote.ssh.bootstrapMachine.v1 when desktop prompt resolutions are provided up front', async () => {
    const events: unknown[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: {
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
          relay: {
            relayUrl: 'https://relay.example.test',
          },
          serviceMode: 'user',
          promptResolution: {
            hostTrust: {
              kind: 'ssh.trustHost',
              fingerprint: 'SHA256:test',
            },
            authApproval: {
              publicKey: 'pub-key',
            },
          },
        },
      },
      taskId: 'task_bootstrap_2',
      registry: createHsetupSystemTaskRegistry({
        remoteSshBootstrap: {
          async resolveHostTrust() {
            return {
              status: 'prompt',
              promptKind: 'ssh.trustHost',
              promptMessage: 'Trust the remote SSH host key',
              promptData: {
                host: 'example.test',
                fingerprint: 'SHA256:test',
              },
              accept: async () => undefined,
            };
          },
          async installRemoteCli() {},
          async approveLocalAuthRequest() {},
          async runRemoteCommand({ label }) {
            if (label === 'auth.status') {
              return { ok: true, data: { authenticated: false } };
            }
            if (label === 'server.configure') {
              return { ok: true, data: { configured: true } };
            }
            if (label === 'auth.request') {
              return { ok: true, data: { publicKey: 'pub-key' } };
            }
            if (label === 'auth.wait') {
              return { ok: true, data: { machineId: 'machine-remote-1' } };
            }
            if (label === 'daemon.service.install') {
              return { ok: true, data: { installed: true } };
            }
            if (label === 'daemon.service.start') {
              return { ok: true, data: { started: true } };
            }
            throw new Error(`Unexpected remote command: ${label}`);
          },
        },
      }),
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events.map((event) => (event as { stepId?: string }).stepId)).toEqual([
      'ssh.trust',
      'ssh.installCli',
      'ssh.auth.request',
      'ssh.auth.wait',
      'ssh.complete',
    ]);
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_bootstrap_2',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: 'machine-remote-1',
      },
    });
  });

  it('runs secureAccess.tailscale.v1 with the existing tailnet-only serve URL when tailscale is already ready', async () => {
    const fakeCli = createFakeTailscaleCli({
      serveStatuses: [
        [
          'https://relay.tailf00.ts.net',
          '|-- / proxy http://127.0.0.1:3005',
        ].join('\n'),
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
          },
        },
        taskId: 'task_tailscale_ready_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_ready_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: true,
          shareableHttpsUrl: 'https://relay.tailf00.ts.net',
          requiresApproval: null,
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.verifyUrl' }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
        ['status', '--json'],
        ['serve', 'status'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs secureAccess.tailscale.v1 through interactive login and returns a structured approval URL when serve needs tailnet approval', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusJsons: [
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
        {
          BackendState: 'Running',
          AuthURL: '',
          HaveNodeKey: true,
          Self: {
            DNSName: 'relay.tailf00.ts.net.',
          },
          CurrentTailnet: {
            Name: 'example-tailnet',
          },
          TailscaleIPs: ['100.64.0.10'],
        },
      ],
      loginOutputs: [
        {
          exitCode: 0,
          stdout: 'To authenticate, visit https://login.tailscale.com/a/example',
        },
      ],
      serveStatuses: [''],
      serveEnableOutputs: [
        {
          exitCode: 1,
          stderr: 'To authorize your tailnet, visit https://login.tailscale.com/f/serve?node=node-123',
        },
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const previousPollTimeoutMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
    const previousPollIntervalMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');
      process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = '0';
      process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = '1';

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            loginPolicy: 'interactive',
          },
        },
        taskId: 'task_tailscale_approval_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_approval_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: false,
          shareableHttpsUrl: null,
          requiresApproval: {
            url: 'https://login.tailscale.com/f/serve?node=node-123',
          },
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.login',
          data: {
            kind: 'needsUserAction.scanQr',
            url: 'https://login.tailscale.com/a/example',
            usedQr: true,
          },
        }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'tailscale.serveEnable',
        }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.serveEnable',
          data: {
            kind: 'tailscaleServeApproval',
            url: 'https://login.tailscale.com/f/serve?node=node-123',
          },
        }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
        ['login', '--qr'],
        ['status', '--json'],
        ['status', '--json'],
        ['serve', 'status'],
        ['serve', '--bg', 'http://127.0.0.1:3005'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      restoreEnvVar('HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS', previousPollTimeoutMs);
      restoreEnvVar('HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS', previousPollIntervalMs);
      fakeCli.cleanup();
    }
  });

  it('polls for interactive tailscale login completion when status remains logged out after the login command', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusJsons: [
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
        {
          BackendState: 'Running',
          AuthURL: '',
          HaveNodeKey: true,
          Self: {
            DNSName: 'relay.tailf00.ts.net.',
          },
          CurrentTailnet: {
            Name: 'example-tailnet',
          },
          TailscaleIPs: ['100.64.0.10'],
        },
      ],
      loginOutputs: [
        {
          exitCode: 0,
          stdout: 'To authenticate, visit https://login.tailscale.com/a/example',
        },
      ],
      serveStatuses: [
        [
          'https://relay.tailf00.ts.net',
          '|-- / proxy http://127.0.0.1:3005',
        ].join('\n'),
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const previousLoginTimeoutMs = process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS;
    const previousLoginIntervalMs = process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');
      process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS = '5000';
      process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS = '1';

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            loginPolicy: 'interactive',
          },
        },
        taskId: 'task_tailscale_login_poll_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_login_poll_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: true,
          shareableHttpsUrl: 'https://relay.tailf00.ts.net',
          requiresApproval: null,
        },
      });
      expect(fakeCli.readInvocations().filter((invocation) => invocation[0] === 'status' && invocation[1] === '--json')).toHaveLength(4);
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.login',
        }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'tailscale.verifyUrl',
        }),
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      restoreEnvVar('HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS', previousLoginTimeoutMs);
      restoreEnvVar('HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS', previousLoginIntervalMs);
      fakeCli.cleanup();
    }
  });

  it('prompts for managedAdmin tailscale login without running the interactive login command', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusJsons: [
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            mode: 'managedAdmin',
            loginPolicy: 'interactive',
          },
        },
        taskId: 'task_tailscale_managed_admin_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_managed_admin_1',
        ok: false,
        error: {
          code: 'prompt_required',
          message: 'Complete Tailscale sign-in before enabling secure access.',
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.login',
          data: {
            kind: 'needsUserAction.openUrl',
            url: 'https://login.tailscale.com/a/example',
            usedQr: false,
          },
        }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('returns prompt_required with a structured install prompt when installIfMissing is requested but tailscale is unavailable', async () => {
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousInstallMode = process.env.HAPPIER_TAILSCALE_INSTALL_MODE;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = join(tmpdir(), `missing-tailscale-${Date.now()}`);
      process.env.HAPPIER_TAILSCALE_INSTALL_MODE = 'manual';

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            installPolicy: 'installIfMissing',
          },
        },
        taskId: 'task_tailscale_install_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_install_1',
        ok: false,
        error: {
          code: 'prompt_required',
          message: 'Install Tailscale and rerun secure access setup.',
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'tailscale.install',
        }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.install',
          data: {
            kind: 'tailscaleInstall',
            platform: process.platform,
            url: expect.any(String),
          },
        }),
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_TAILSCALE_INSTALL_MODE', previousInstallMode);
      vi.unstubAllGlobals();
    }
  });

  it('runs tailscale.ensureReady.v1 through interactive login and returns structured readiness data', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusJsons: [
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
        {
          BackendState: 'Running',
          AuthURL: '',
          HaveNodeKey: true,
          Self: {
            DNSName: 'relay.tailf00.ts.net.',
          },
          CurrentTailnet: {
            Name: 'example-tailnet',
          },
          TailscaleIPs: ['100.64.0.10'],
        },
      ],
      loginOutputs: [
        {
          exitCode: 0,
          stdout: 'To authenticate, visit https://login.tailscale.com/a/example',
        },
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'tailscale.ensureReady.v1',
          params: {
            loginPolicy: 'interactive',
          },
        },
        taskId: 'task_tailscale_ensure_ready_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_ensure_ready_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          authUrl: null,
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.login',
          data: {
            kind: 'needsUserAction.scanQr',
            url: 'https://login.tailscale.com/a/example',
            usedQr: true,
          },
        }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
        ['login', '--qr'],
        ['status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs relay.access.configure.v1 and redacts sensitive provider details in the task result', async () => {
    const store: { config: unknown } = { config: null };
    const events: unknown[] = [];

    const registry = createHsetupSystemTaskRegistry({
      relayAccess: {
        readConfig: async () => store.config as never,
        writeConfig: async (params) => {
          store.config = params.config;
        },
        getProvider: () => ({
          descriptor: {
            id: 'cloudflareNamed',
            title: 'Cloudflare',
            exposure: 'public',
            prerequisites: [],
          },
          status: async () => ({
            state: 'enabled',
            shareUrl: 'https://relay.example.test',
            details: {
              token: 'super-secret',
              ok: true,
            },
          }),
        }),
      },
    });

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.access.configure.v1',
        params: {
          target: { kind: 'local' },
          providerId: 'cloudflareNamed',
          config: {
            hostname: 'relay.example.test',
            token: 'super-secret',
          },
        },
      },
      taskId: 'task_relay_access_configure_1',
      registry,
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events.map((event) => (event as { stepId?: string }).stepId)).toEqual([
      'relay.access.configure.persist',
      'relay.access.configure.verify',
    ]);
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_relay_access_configure_1',
      ok: true,
      data: {
        configured: true,
        providerId: 'cloudflareNamed',
        status: {
          state: 'enabled',
          shareUrl: 'https://relay.example.test',
          details: {
            ok: true,
          },
        },
      },
    });
  });

  it('provides a local command runner for relay.access.configure.v1 when configuring command-backed providers', async () => {
    const events: unknown[] = [];

    const registry = createHsetupSystemTaskRegistry({
      relayAccess: {
        readConfig: async () => null as never,
        writeConfig: async () => {},
        getProvider: () => ({
          descriptor: {
            id: 'tailscaleServe',
            title: 'Tailscale Serve',
            exposure: 'private',
            prerequisites: [],
          },
          configure: async ({ ctx }) => {
            if (!ctx.runCommand) {
              return { state: 'error', details: { reason: 'missing_run_command' } };
            }
            if (ctx.upstreamUrl !== 'http://127.0.0.1:3005') {
              return { state: 'error', details: { reason: 'unexpected_upstream_url', upstreamUrl: ctx.upstreamUrl } };
            }
            return { state: 'enabled', shareUrl: 'https://relay.example.test' };
          },
          status: async ({ ctx }) => {
            if (!ctx.runCommand) {
              return { state: 'error', details: { reason: 'missing_run_command' } };
            }
            return { state: 'enabled', shareUrl: 'https://relay.example.test' };
          },
        }),
      },
    });

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.access.configure.v1',
        params: {
          target: { kind: 'local' },
          upstreamUrl: 'http://127.0.0.1:3005',
          providerId: 'tailscaleServe',
          config: {
            providerId: 'tailscaleServe',
          },
        },
      },
      taskId: 'task_relay_access_configure_local_runner_1',
      registry,
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_relay_access_configure_local_runner_1',
      ok: true,
      data: {
        configured: true,
        providerId: 'tailscaleServe',
        status: {
          state: 'enabled',
          shareUrl: 'https://relay.example.test',
          details: null,
        },
      },
    });
  });

  it('persists relay access configuration across registry restarts by default', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hsetup-relay-access-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const registry1 = createHsetupSystemTaskRegistry();
      const configure = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'relay.access.configure.v1',
          params: {
            target: { kind: 'local' },
            providerId: 'lan',
            config: {
              providerId: 'lan',
              url: 'http://10.0.0.5:3005',
            },
          },
        },
        taskId: 'task_relay_access_persist_1',
        registry: registry1,
        now: () => 1700000000000,
        emitEvent: () => undefined,
      });
      expect(configure.ok).toBe(true);

      const registry2 = createHsetupSystemTaskRegistry();
      const status = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'relay.access.status.v1',
          params: {
            target: { kind: 'local' },
          },
        },
        taskId: 'task_relay_access_persist_2',
        registry: registry2,
        now: () => 1700000000000,
        emitEvent: () => undefined,
      });

      expect(status).toEqual({
        protocolVersion: 1,
        taskId: 'task_relay_access_persist_2',
        ok: true,
        data: {
          configured: true,
          providerId: 'lan',
          status: {
            state: 'enabled',
            shareUrl: 'http://10.0.0.5:3005',
            details: null,
          },
        },
      });
    } finally {
      process.env.HOME = previousHome;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
