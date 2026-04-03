import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeSystemTask } from '@happier-dev/cli-common/systemTasks';
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

if (command === 'daemon service status --json') {
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

if (argv[0] === 'daemon' && argv[1] === 'service' && (argv[2] === 'install' || argv[2] === 'start') && argv.includes('--json')) {
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

function createFakeTailscaleCli(scenario: Readonly<{
  statusJsons?: readonly Record<string, unknown>[];
  loginOutputs?: readonly Readonly<{ exitCode?: number; stdout?: string; stderr?: string }>[];
  serveStatuses?: readonly string[];
  serveEnableOutputs?: readonly Readonly<{ exitCode?: number; stdout?: string; stderr?: string }>[];
}>): Readonly<{
  cliPath: string;
  cleanup: () => void;
  readInvocations: () => string[][];
}> {
  const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-tailscale-'));
  const cliPath = join(rootDir, 'fake-tailscale');
  const statePath = join(rootDir, 'scenario.json');
  const logPath = join(rootDir, 'invocations.log');

  writeFileSync(statePath, JSON.stringify({
    statusJsons: scenario.statusJsons ?? [
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
    loginOutputs: scenario.loginOutputs ?? [],
    serveStatuses: scenario.serveStatuses ?? [],
    serveEnableOutputs: scenario.serveEnableOutputs ?? [],
  }, null, 2));

  writeFileSync(cliPath, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const statePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
const logPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
const argv = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(argv) + '\\n');

const state = JSON.parse(readFileSync(statePath, 'utf8'));

function shift(list, fallback) {
  const values = Array.isArray(list) ? [...list] : [];
  const next = values.length > 0 ? values.shift() : fallback;
  return { next, rest: values };
}

if (argv[0] === 'status' && argv[1] === '--json') {
  const { next, rest } = shift(state.statusJsons, {
    BackendState: 'Running',
    AuthURL: '',
    HaveNodeKey: true,
    Self: { DNSName: 'relay.tailf00.ts.net.' },
    CurrentTailnet: { Name: 'example-tailnet' },
    TailscaleIPs: ['100.64.0.10'],
  });
  state.statusJsons = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write(JSON.stringify(next) + '\\n');
  process.exit(0);
}

if (argv[0] === 'login' && (argv[1] === '--qr' || argv.length === 1)) {
  const { next, rest } = shift(state.loginOutputs, {
    exitCode: 0,
    stdout: 'logged in',
    stderr: '',
  });
  state.loginOutputs = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (next.stdout) process.stdout.write(String(next.stdout));
  if (next.stderr) process.stderr.write(String(next.stderr));
  process.exit(Number(next.exitCode ?? 0));
}

if (argv[0] === 'serve' && argv[1] === 'status') {
  const { next, rest } = shift(state.serveStatuses, '');
  state.serveStatuses = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write(String(next ?? ''));
  process.exit(0);
}

if (argv[0] === 'serve' && argv[1] === '--bg') {
  const { next, rest } = shift(state.serveEnableOutputs, {
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  state.serveEnableOutputs = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (next.stdout) process.stdout.write(String(next.stdout));
  if (next.stderr) process.stderr.write(String(next.stderr));
  process.exit(Number(next.exitCode ?? 0));
}

process.stderr.write('Unexpected fake tailscale args: ' + argv.join(' ') + '\\n');
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
    registry: createHsetupSystemTaskRegistry(),
    now: () => 1700000000000,
    emitEvent() {},
  });
}

describe('createHsetupSystemTaskRegistry', () => {
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
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(events).toEqual([
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
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['daemon', 'service', 'install', '--json'],
        ['daemon', 'service', 'start', '--json'],
        ['daemon', 'status', '--json'],
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
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(events).toEqual([
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
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['auth', 'request', '--json'],
        ['auth', 'wait', '--public-key', 'public-key-local-1', '--json'],
        ['daemon', 'service', 'install', '--json'],
        ['daemon', 'service', 'start', '--json'],
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
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
        ['auth', 'request', '--json'],
        ['auth', 'approve', '--public-key', 'public-key-local-2', '--json'],
        ['auth', 'wait', '--public-key', 'public-key-local-2', '--json'],
        ['daemon', 'service', 'install', '--json'],
        ['daemon', 'service', 'start', '--json'],
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
          message: 'Daemon service did not reach a ready state for the selected Relay.',
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
        data: {
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
        },
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
        data: {
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
        },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['daemon', 'status', '--json'],
        ['daemon', 'service', 'start', '--json'],
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
        ['daemon', 'service', 'install', '--json'],
        ['daemon', 'service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
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
        expect.objectContaining({ type: 'progress', stepId: 'detect' }),
        expect.objectContaining({ type: 'progress', stepId: 'verify url' }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
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
    const previousPollTimeout = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
    const previousPollInterval = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');
      // Avoid long approval polling in this registry integration test. The handler still returns the approval URL,
      // and the UX layer can re-run or poll separately if desired.
      process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = '0';
      process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = '0';

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
        expect.objectContaining({ type: 'progress', stepId: 'detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'login',
          data: {
            kind: 'needsUserAction.scanQr',
            url: 'https://login.tailscale.com/a/example',
            usedQr: true,
          },
        }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'serve enable',
        }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'serve enable',
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
        ['serve', 'status'],
        ['serve', '--bg', 'http://127.0.0.1:3005'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      restoreEnvVar('HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS', previousPollTimeout);
      restoreEnvVar('HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS', previousPollInterval);
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
        expect.objectContaining({ type: 'progress', stepId: 'detect' }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'install',
        }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'install',
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
});
