import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { InteractiveSystemTaskKindMap } from '@happier-dev/cli-common/systemTasks';
import type { BackgroundServiceSetupGuidance } from '@happier-dev/cli-common/systemTasks';
import { buildBackgroundServiceSetupGuidance } from '@happier-dev/cli-common/systemTasks';
import { deriveBoxPublicKeyFromSeed, openTerminalProvisioningV3Response } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createFakeHappierCli, restoreEnvVar } from '../systemTasks/fakeHappierCli.testkit.js';
import {
  createProductionSetupThisComputerInteractiveDeps,
  createSetupThisComputerInteractiveTaskKind,
} from '../systemTasks/kinds/setupThisComputerInteractiveKind.js';
import {
  createProductionSetupRepairThisComputerInteractiveDeps,
  createSetupRepairThisComputerInteractiveTaskKind,
} from '../systemTasks/kinds/setupRepairThisComputerInteractiveKind.js';
import { createHsetupSystemTaskRegistry } from '../systemTasks/registry.js';

import { createDefaultInteractiveKinds, runHsetupCli } from './hsetup.js';

type FakeCliScenario = Parameters<typeof createFakeHappierCli>[0];
type FakeCli = ReturnType<typeof createFakeHappierCli>;

type HsetupRun = Readonly<{
  exitCode: number;
  events: Array<Record<string, unknown>>;
  result: Record<string, unknown> | null;
  stderr: string;
}>;

const LOCAL_SETUP_KINDS = ['setup.thisComputer.v1', 'setup.repairThisComputer.v1'] as const;

async function withFakeHappierCli<T>(
  scenario: FakeCliScenario,
  run: (fakeCli: FakeCli) => Promise<T>,
): Promise<T> {
  const fakeCli = createFakeHappierCli(scenario);
  const previous = {
    homeDir: process.env.HAPPIER_HOME_DIR,
    cliPath: process.env.HAPPIER_BOOTSTRAP_CLI_PATH,
    statePath: process.env.HAPPIER_FAKE_CLI_STATE_PATH,
    logPath: process.env.HAPPIER_FAKE_CLI_LOG_PATH,
  };
  try {
    // These tests run the real production deps, which install the managed CLI and rewrite the
    // first-party shims under `<HAPPIER_HOME_DIR>/bin`. Without an explicit home the default is
    // the developer's own `~/.happier`, so a test run would replace a real installed `happier`
    // shim with a symlink into a temp directory that is deleted on cleanup. Point the whole
    // managed layout at the fake CLI's temp root instead.
    process.env.HAPPIER_HOME_DIR = join(fakeCli.cliPath, '..');
    process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
    process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
    process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');
    return await run(fakeCli);
  } finally {
    restoreEnvVar('HAPPIER_HOME_DIR', previous.homeDir);
    restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previous.cliPath);
    restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previous.statePath);
    restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previous.logPath);
    fakeCli.cleanup();
  }
}

/**
 * Runs the real `hsetup system-tasks run` dispatcher: the spec arrives on stdin, prompt answers
 * follow it line by line, and events/result are read back from stdout exactly as the desktop
 * bridge reads them.
 */
async function runHsetup(params: Readonly<{
  spec: Record<string, unknown>;
  answers?: readonly unknown[];
  interactiveKinds?: InteractiveSystemTaskKindMap;
  taskId?: string;
}>): Promise<HsetupRun> {
  const stdinLines = [JSON.stringify(params.spec), ...(params.answers ?? []).map((answer) => JSON.stringify(answer))];
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let ts = 1_000;
  const exitCode = await runHsetupCli(['system-tasks', 'run'], {
    stdin: {
      async readAll() {
        return stdinLines.join('\n');
      },
      async readLine() {
        return stdinLines.shift() ?? null;
      },
    },
    stdout: { write: (chunk) => { stdoutChunks.push(chunk); } },
    stderr: { write: (chunk) => { stderrChunks.push(chunk); } },
    now: () => ts++,
    taskIdFactory: () => params.taskId ?? 'task-local-1',
    ...(params.interactiveKinds
      ? { interactiveKinds: params.interactiveKinds }
      : params.spec.kind === 'setup.repairThisComputer.v1'
        ? { interactiveKinds: repairKindsWithoutGuidance() }
        : {}),
  });
  const lines = stdoutChunks.join('').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const result = lines.find((line) => typeof line.ok === 'boolean') ?? null;
  return {
    exitCode,
    events: lines.filter((line) => typeof line.type === 'string'),
    result,
    stderr: stderrChunks.join(''),
  };
}

function lifecycle(events: ReadonlyArray<Record<string, unknown>>): Array<Readonly<{ type: string; stepId: string }>> {
  return events
    .filter((event) => typeof event.stepId === 'string' && (event.type === 'prompt' || (event.type === 'progress' && !('data' in event))))
    .map((event) => ({ type: String(event.type), stepId: String(event.stepId) }));
}

function createDefaultGuidance(overrides: Partial<BackgroundServiceSetupGuidance> = {}): BackgroundServiceSetupGuidance {
  return {
    targetReleaseChannel: 'stable',
    targetServerUrl: 'https://relay.example.test',
    currentHappierHomeDir: null,
    currentDefaultReleaseChannel: 'stable',
    managedReleaseChannels: [],
    manualRelayOwner: null,
    exactDefaultServiceExists: false,
    exactDefaultServiceRunning: false,
    conflictingServices: [],
    foreignHomeConflictingServices: [],
    shouldOfferDefaultReleaseChannelSwitch: false,
    shouldPromptForManualRelayTakeover: false,
    shouldPromptForServiceReplacement: false,
    ...overrides,
  };
}

function setupKindsWithoutGuidance(): InteractiveSystemTaskKindMap {
  return {
    ...createDefaultInteractiveKinds(),
    'setup.thisComputer.v1': createSetupThisComputerInteractiveTaskKind({
      // Production wiring by name: this file drives the real dispatcher and the real
      // setup recipe against the fake CLI installed at `HAPPIER_BOOTSTRAP_CLI_PATH`.
      ...createProductionSetupThisComputerInteractiveDeps(),
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
    readBackgroundServiceSetupGuidance: async () => createDefaultGuidance(),
    }),
  };
}

/**
 * Repair reads the machine's installed background services through the guidance owner; the
 * developer's own services must not decide a test, so the inventory is fixed here.
 */
function repairKindsWithoutGuidance(): InteractiveSystemTaskKindMap {
  return {
    ...createDefaultInteractiveKinds(),
    'setup.repairThisComputer.v1': createSetupRepairThisComputerInteractiveTaskKind({
      ...createProductionSetupRepairThisComputerInteractiveDeps(),
      readBackgroundServiceSetupGuidance: async () => createDefaultGuidance(),
    }),
  };
}

// R3: the desktop surface always names the Home it selected. The kind refuses a `desktop.ui`
// spec without it rather than falling back to the terminal's own selected relay.
const SETUP_SPEC = {
  protocolVersion: 1,
  kind: 'setup.thisComputer.v1',
  params: {
    surface: 'desktop.ui',
    target: 'thisComputer',
    activeRelayUrl: 'https://relay.example.test',
    activeWebappUrl: 'https://app.example.test',
    activeLocalRelayUrl: null,
  },
} as const;

const REPAIR_SPEC = {
  protocolVersion: 1,
  kind: 'setup.repairThisComputer.v1',
  params: {
    activeRelayUrl: 'https://relay.example.test',
    activeWebappUrl: 'https://app.example.test',
    activeLocalRelayUrl: null,
    surface: 'desktop.ui',
  },
} as const;

const NOT_AUTHENTICATED_STATUS = { ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } } as const;

function readyDaemonStatus(machineId: string): Record<string, unknown> {
  return {
    server: {
      serverUrl: 'https://relay.example.test',
      localServerUrl: null,
      publicServerUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
    },
    daemon: { running: true, pid: 4321 },
    service: { installed: true, running: true },
    auth: { authenticated: true, machineRegistered: true, machineId, needsAuth: false },
  };
}

type PairingFixture = Readonly<{
  seed: Uint8Array;
  publicKeyB64: string;
  pairingSecret: Uint8Array;
  pairingSecretB64Url: string;
  createdAtMs: number;
  expiresAtMs: number;
}>;

function createPairingFixture(): PairingFixture {
  const seed = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) seed[index] = index + 1;
  const pairingSecret = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) pairingSecret[index] = index + 100;
  return {
    seed,
    publicKeyB64: Buffer.from(deriveBoxPublicKeyFromSeed(seed)).toString('base64'),
    pairingSecret,
    pairingSecretB64Url: Buffer.from(pairingSecret).toString('base64url'),
    createdAtMs: 1_000_000,
    expiresAtMs: 2_000_000,
  };
}

function tokenOnlyAuthRequest(fixture: PairingFixture): Record<string, unknown> {
  return {
    publicKey: fixture.publicKeyB64,
    pairing: {
      secretB64Url: fixture.pairingSecretB64Url,
      createdAtMs: fixture.createdAtMs,
      expiresAtMs: fixture.expiresAtMs,
    },
    supportsTokenOnly: true,
    claimSecret: 'claim-secret-value',
    stateFile: '/home/tester/.happier/auth/pending/abc123.json',
  };
}

describe('hsetup local setup and repair dispatch', () => {
  it('repairs the selected account and identifies an actual service restart separately from start', async () => {
    const fixture = createPairingFixture();
    await withFakeHappierCli({
      serverList: { ok: true, data: { activeServerId: 'cloud', profiles: [{ id: 'relay', serverUrl: 'https://relay.example.test' }] } },
      authStatus: { ok: true, kind: 'auth_status', data: {
        authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed',
        accountId: 'account-old', machineId: 'machine-old',
      } },
      authStatuses: [{ ok: true, kind: 'auth_status', data: {
        authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed',
        accountId: 'account-new', machineId: 'machine-new',
      } }],
      authRequests: [tokenOnlyAuthRequest(fixture)],
      authWaits: [{ success: true, machineId: 'machine-new' }],
      daemonStatuses: [readyDaemonStatus('machine-new')],
    }, async (fakeCli) => {
      const interactiveKinds = {
        ...createDefaultInteractiveKinds(),
        'setup.repairThisComputer.v1': createSetupRepairThisComputerInteractiveTaskKind({
          ...createProductionSetupRepairThisComputerInteractiveDeps(),
          // Only the OS inventory is a fixture; conflict and lifecycle policy stay real.
          readBackgroundServiceSetupGuidance: async (target) => buildBackgroundServiceSetupGuidance({
            ...target, platform: 'linux', mode: 'user', currentHappierHomeDir: process.env.HAPPIER_HOME_DIR,
            managedReleaseChannelInventory: { defaultReleaseChannel: 'stable', managedReleaseChannels: [] },
            services: [{ id: 'service-relay', serviceType: 'daemon', platform: 'linux', backend: 'systemd-user',
              label: 'relay', targetMode: 'pinned', verification: 'verified', ring: 'stable', instanceId: 'relay',
              scope: 'user', definitionPath: '/test/relay.service', executablePath: fakeCli.cliPath,
              happierHomeDir: process.env.HAPPIER_HOME_DIR, serverUrl: 'https://relay.example.test',
              installed: true, running: true }],
          }),
        }),
      };
      const run = await runHsetup({
        spec: { ...REPAIR_SPEC, params: { ...REPAIR_SPEC.params, activeAccountId: 'account-new' } },
        answers: [{ approved: true }], interactiveKinds,
      });
      expect(run.result).toMatchObject({ ok: true, data: { machineId: 'machine-new' } });
      expect(run.events).toContainEqual(expect.objectContaining({ type: 'progress', stepId: 'setup.repairThisComputer.restartService' }));
      expect(fakeCli.readInvocations()).toContainEqual(['--server', 'relay', 'service', 'restart', '--json']);
    });
  });
  it('dispatches setup.thisComputer.v1 and setup.repairThisComputer.v1 only through the interactive map', () => {
    const interactiveKinds = createDefaultInteractiveKinds();
    const registry = createHsetupSystemTaskRegistry();

    for (const kind of LOCAL_SETUP_KINDS) {
      expect(interactiveKinds[kind], `${kind} must be an interactive kind`).toBeTruthy();
      expect(registry.has(kind), `${kind} must not be shadow-registered in the ordinary registry`).toBe(false);
    }
    expect(registry.has('relay.connectBackgroundService.v1')).toBe(false);
    // INV1: interactive dispatch wins whenever a kind is in the interactive map, so a registry
    // entry for the same kind is unreachable code that can only drift. No kind is in both maps.
    const inBothMaps = Object.keys(interactiveKinds).filter((kind) => registry.has(kind));
    expect(inBothMaps).toEqual([]);
  });

  it('completes unauthenticated setup.repairThisComputer.v1 end to end through the token-only approval exchange', async () => {
    const fixture = createPairingFixture();
    await withFakeHappierCli({
      authStatus: NOT_AUTHENTICATED_STATUS,
      authRequests: [tokenOnlyAuthRequest(fixture)],
      authWaits: [{ success: true, machineId: 'machine-repaired-1' }],
      daemonStatuses: [readyDaemonStatus('machine-repaired-1')],
    }, async (fakeCli) => {
      const run = await runHsetup({ spec: REPAIR_SPEC, answers: [{ approved: true }], taskId: 'task-repair-e2e' });

      expect(run.stderr).toBe('');
      const prompt = run.events.find((event) => event.type === 'prompt');
      expect(prompt).toMatchObject({ taskId: 'task-repair-e2e', stepId: 'setup.repairThisComputer.authRequest' });
      const promptData = prompt?.data as Record<string, unknown>;
      // The same prompt contract the desktop approval owner recognizes: opaque token-only
      // response, the explicit target identity, and how this run's CLI was acquired.
      expect(Object.keys(promptData).sort()).toEqual(['cliCommand', 'cliProvenance', 'kind', 'publicKey', 'relayUrl', 'response', 'responseKind', 'webappUrl']);
      expect(promptData).toMatchObject({
        kind: 'authRequest',
        responseKind: 'tokenOnly',
        publicKey: fixture.publicKeyB64,
        relayUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        // This fixture installs the CLI through `HAPPIER_BOOTSTRAP_CLI_PATH`, which is exactly the
        // development override R13 never approves unattended — the real resolver says so through
        // the real dispatcher, with no test seam in between. The resolved command travels with it
        // so the approval owner can name the program it is asking about (R8).
        cliProvenance: 'override',
        cliCommand: fakeCli.cliPath,
      });
      const opened = openTerminalProvisioningV3Response({
        payload: new Uint8Array(Buffer.from(String(promptData.response), 'base64')),
        recipientSecretKeyOrSeed: fixture.seed,
        terminalEphemeralPublicKey: new Uint8Array(Buffer.from(fixture.publicKeyB64, 'base64')),
        pairingSecret: fixture.pairingSecret,
        createdAtMs: fixture.createdAtMs,
        expiresAtMs: fixture.expiresAtMs,
        nowMs: (fixture.createdAtMs + fixture.expiresAtMs) / 2,
      });
      expect(opened).toEqual({ type: 'tokenOnly' });
      const serialized = JSON.stringify(run.events);
      expect(serialized).not.toContain(fixture.pairingSecretB64Url);
      expect(serialized).not.toContain('claim-secret-value');
      expect(serialized).not.toContain('/auth/pending');

      // The answer resumed the runner: pairing was claimed, the service installed and started,
      // and readiness was proven by a fresh daemon status read, not by the task's own success.
      expect(run.result).toEqual({
        protocolVersion: 1,
        taskId: 'task-repair-e2e',
        ok: true,
        data: { machineId: 'machine-repaired-1' },
      });
      expect(run.exitCode).toBe(0);
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'list', '--json'],
        ['server', 'help'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--no-use', '--json'],
        ['--server', 'relay', 'auth', 'status', '--json'],
        ['--server', 'relay', 'auth', 'request', '--json'],
        ['--server', 'relay', 'auth', 'wait', '--public-key', fixture.publicKeyB64, '--json'],
        ['--server', 'relay', 'service', 'install', '--json'],
        ['--server', 'relay', 'service', 'start', '--json'],
        ['--server', 'relay', 'daemon', 'status', '--json'],
      ]);
      expect(lifecycle(run.events)).toEqual([
        { type: 'progress', stepId: 'setup.repairThisComputer.configureRelay' },
        { type: 'progress', stepId: 'setup.repairThisComputer.authRequest' },
        { type: 'prompt', stepId: 'setup.repairThisComputer.authRequest' },
        { type: 'progress', stepId: 'setup.repairThisComputer.authenticate' },
        { type: 'progress', stepId: 'setup.repairThisComputer.installService' },
        { type: 'progress', stepId: 'setup.repairThisComputer.startService' },
        { type: 'progress', stepId: 'setup.repairThisComputer.waitForReady' },
        { type: 'progress', stepId: 'setup.repairThisComputer.finish' },
      ]);
    });
  });

  it('fails setup.repairThisComputer.v1 with a named error when the approval owner declines', async () => {
    const fixture = createPairingFixture();
    await withFakeHappierCli({
      authStatus: NOT_AUTHENTICATED_STATUS,
      authRequests: [tokenOnlyAuthRequest(fixture)],
    }, async (fakeCli) => {
      // The approval owner names why it refused; the run reports that instead of implying the
      // person declined.
      const run = await runHsetup({ spec: REPAIR_SPEC, answers: [{ approved: false, reason: 'relay_mismatch' }] });

      expect(run.result).toMatchObject({
        ok: false,
        error: { code: 'approval_declined', message: 'Pairing request was not approved (relay_mismatch).' },
      });
      expect(run.exitCode).toBe(1);
      expect(fakeCli.readInvocations()).not.toContainEqual(expect.arrayContaining(['auth', 'wait']));
      expect(fakeCli.readInvocations()).not.toContainEqual(expect.arrayContaining(['service', 'install']));
    });
  });

  it('fails setup.repairThisComputer.v1 closed when the CLI cannot supply token-only pairing material', async () => {
    await withFakeHappierCli({
      authStatus: NOT_AUTHENTICATED_STATUS,
      authRequests: [{ publicKey: 'legacy-public-key' }],
    }, async () => {
      const run = await runHsetup({ spec: REPAIR_SPEC, answers: [{ approved: true }] });

      expect(run.events.some((event) => event.type === 'prompt')).toBe(false);
      expect(run.result).toMatchObject({ ok: false, error: { code: 'pairing_approval_unavailable' } });
    });
  });

  it('runs setup.repairThisComputer.v1 without pairing when already authenticated and registered', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const run = await runHsetup({ spec: REPAIR_SPEC });

      expect(run.result).toEqual({
        protocolVersion: 1,
        taskId: 'task-local-1',
        ok: true,
        data: { machineId: 'machine-local-1' },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'list', '--json'],
        ['server', 'help'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--no-use', '--json'],
        ['--server', 'relay', 'auth', 'status', '--json'],
        ['--server', 'relay', 'service', 'install', '--json'],
        ['--server', 'relay', 'service', 'start', '--json'],
        ['--server', 'relay', 'daemon', 'status', '--json'],
      ]);
    });
  });

  it('refuses a desktop.ui setup.repairThisComputer.v1 spec that names no Home', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const run = await runHsetup({
        spec: { protocolVersion: 1, kind: 'setup.repairThisComputer.v1', params: { surface: 'desktop.ui' } },
      });

      // Same R3 rule and same seam as setup: the app always names the Home it selected, so an
      // omission is malformed rather than a licence to repoint the daemon at the terminal's relay.
      expect(run.result).toMatchObject({
        ok: false,
        error: { code: 'invalid_params', message: 'activeRelayUrl is required for surface desktop.ui.' },
      });
      expect(fakeCli.readInvocations()).toEqual([]);
    });
  });

  it('resolves the ambient relay for setup.repairThisComputer.v1 only when no explicit target is given', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const run = await runHsetup({ spec: { protocolVersion: 1, kind: 'setup.repairThisComputer.v1', params: {} } });

      expect(run.result).toMatchObject({ ok: true, data: { machineId: 'machine-local-1' } });
      expect(fakeCli.readInvocations()[0]).toEqual(['server', 'current', '--json']);
    });
  });

  it('uses the publicdev release ring when setup.repairThisComputer.v1 specifies channel dev', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const homeDir = join(fakeCli.cliPath, '..');
      const previous = {
        homeDir: process.env.HAPPIER_HOME_DIR,
        repoDir: process.env.HAPPIER_STACK_REPO_DIR,
        cliPath: process.env.HAPPIER_BOOTSTRAP_CLI_PATH,
      };
      try {
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_STACK_REPO_DIR = homeDir;
        delete process.env.HAPPIER_BOOTSTRAP_CLI_PATH;

        const stablePath = join(homeDir, 'cli', 'current', 'happier');
        mkdirSync(join(homeDir, 'cli', 'current'), { recursive: true });
        writeFileSync(stablePath, '#!/bin/sh\nexit 1\n');
        chmodSync(stablePath, 0o755);
        const devPath = join(homeDir, 'cli-dev', 'current', 'happier');
        mkdirSync(join(homeDir, 'cli-dev', 'current'), { recursive: true });
        writeFileSync(devPath, readFileSync(fakeCli.cliPath, 'utf8'));
        chmodSync(devPath, 0o755);

        const run = await runHsetup({
          spec: { ...REPAIR_SPEC, params: { ...REPAIR_SPEC.params, channel: 'dev' } },
        });

        expect(run.result).toMatchObject({ ok: true, data: { machineId: 'machine-local-1' } });
        expect(fakeCli.readInvocations()).toEqual([
          ['server', 'list', '--json'],
          ['server', 'help'],
          ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--no-use', '--json'],
          ['--server', 'relay', 'auth', 'status', '--json'],
          ['--server', 'relay', 'service', 'install', '--json'],
          ['--server', 'relay', 'service', 'start', '--json'],
          ['--server', 'relay', 'daemon', 'status', '--json'],
        ]);
      } finally {
        restoreEnvVar('HAPPIER_HOME_DIR', previous.homeDir);
        restoreEnvVar('HAPPIER_STACK_REPO_DIR', previous.repoDir);
        restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previous.cliPath);
      }
    });
  });

  it('refuses a desktop.ui setup.thisComputer.v1 spec that names no Home instead of resolving the ambient relay', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const run = await runHsetup({
        spec: { ...SETUP_SPEC, params: { surface: 'desktop.ui', target: 'thisComputer' } },
        interactiveKinds: setupKindsWithoutGuidance(),
      });

      expect(run.result).toMatchObject({
        ok: false,
        error: { code: 'invalid_params', message: 'activeRelayUrl is required for surface desktop.ui.' },
      });
      // R3: refused before anything ran, so the CLI's own selected relay was never consulted and
      // nothing on this machine was touched.
      expect(fakeCli.readInvocations()).toEqual([]);
    });
  });

  it('resolves the ambient relay for a terminal setup.thisComputer.v1 spec that names no Home', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const run = await runHsetup({
        spec: { ...SETUP_SPEC, params: { surface: 'terminal', target: 'thisComputer' } },
        interactiveKinds: setupKindsWithoutGuidance(),
      });

      expect(run.result).toMatchObject({ ok: true, data: { machineId: 'machine-local-1' } });
      expect(fakeCli.readInvocations()[0]).toEqual(['server', 'current', '--json']);
    });
  });

  it('runs setup.thisComputer.v1 with deterministic step ids and returns a machine id', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const run = await runHsetup({ spec: SETUP_SPEC, interactiveKinds: setupKindsWithoutGuidance() });

      expect(lifecycle(run.events)).toEqual([
        { type: 'progress', stepId: 'setup.thisComputer.ensureCli' },
        { type: 'progress', stepId: 'setup.thisComputer.resolveRelay' },
        { type: 'progress', stepId: 'setup.thisComputer.configureRelay' },
        { type: 'progress', stepId: 'setup.thisComputer.installService' },
        { type: 'progress', stepId: 'setup.thisComputer.startService' },
        { type: 'progress', stepId: 'setup.thisComputer.verifyService' },
      ]);
      expect(run.result).toEqual({
        protocolVersion: 1,
        taskId: 'task-local-1',
        ok: true,
        data: { machineId: 'machine-local-1' },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'list', '--json'],
        ['server', 'help'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--no-use', '--json'],
        ['--server', 'relay', 'auth', 'status', '--json'],
        ['--server', 'relay', 'service', 'install', '--json'],
        ['--server', 'relay', 'service', 'start', '--json'],
        ['--server', 'relay', 'daemon', 'status', '--json'],
      ]);
    });
  });

  it('uses the identity-bearing Home profile it resolved, so setup and scoped status address one profile', async () => {
    await withFakeHappierCli({
      serverList: {
        ok: true,
        kind: 'server_list',
        data: {
          activeServerId: 'cloud',
          profiles: [
            { id: 'cloud', serverUrl: 'https://api.happier.dev' },
            { id: 'home-2', serverUrl: 'https://relay.example.test', homeServerIdentityId: 'home-identity-2' },
          ],
        },
      },
    }, async (fakeCli) => {
      const run = await runHsetup({
        spec: { ...SETUP_SPEC, params: { ...SETUP_SPEC.params, activeServerIdentityId: 'home-identity-2' } },
        interactiveKinds: setupKindsWithoutGuidance(),
      });

      expect(run.result).toMatchObject({ ok: true });
      const invocations = fakeCli.readInvocations();
      // The resolved profile is used as saved: no second profile, no rewritten endpoints.
      expect(invocations.some((args) => args[0] === 'server' && args[1] === 'set')).toBe(false);
      const scopedServerIds = invocations.filter((args) => args[0] === '--server').map((args) => args[1]);
      expect(scopedServerIds.length).toBeGreaterThan(0);
      expect(new Set(scopedServerIds)).toEqual(new Set(['home-2']));
    });
  });

  it('can skip background service steps for setup.thisComputer.v1', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const run = await runHsetup({
        spec: {
          ...SETUP_SPEC,
          params: { ...SETUP_SPEC.params, installService: false, startService: false, verifyService: false },
        },
        interactiveKinds: setupKindsWithoutGuidance(),
      });

      expect(lifecycle(run.events)).toEqual([
        { type: 'progress', stepId: 'setup.thisComputer.ensureCli' },
        { type: 'progress', stepId: 'setup.thisComputer.resolveRelay' },
        { type: 'progress', stepId: 'setup.thisComputer.configureRelay' },
      ]);
      expect(run.result).toMatchObject({ ok: true, data: { machineId: 'machine-local-1' } });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'list', '--json'],
        ['server', 'help'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--no-use', '--json'],
        ['--server', 'relay', 'auth', 'status', '--json'],
      ]);
    });
  });

  it('keeps setup on the current default release channel when the guided switch is declined', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const switches: string[] = [];
      const run = await runHsetup({
        spec: { ...SETUP_SPEC, params: { ...SETUP_SPEC.params, channel: 'preview' } },
        answers: [{ switchDefaultReleaseChannel: false }],
        interactiveKinds: {
          'setup.thisComputer.v1': createSetupThisComputerInteractiveTaskKind({
            // Production wiring by name: this file drives the real dispatcher and the real
            // setup recipe against the fake CLI installed at `HAPPIER_BOOTSTRAP_CLI_PATH`.
            ...createProductionSetupThisComputerInteractiveDeps(),
            exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
            readBackgroundServiceSetupGuidance: async () => createDefaultGuidance({
              targetReleaseChannel: 'preview',
              currentDefaultReleaseChannel: 'stable',
              managedReleaseChannels: [
                { releaseChannel: 'stable', label: 'stable', version: '1.0.0', installationId: 'stable-install', installationPath: '/managed/stable', invokerName: 'happier', isDefault: true, onPath: true },
                { releaseChannel: 'preview', label: 'preview', version: '2.0.0', installationId: 'preview-install', installationPath: '/managed/preview', invokerName: 'hprev', isDefault: false, onPath: true },
              ],
              exactDefaultServiceExists: true,
              shouldOfferDefaultReleaseChannelSwitch: true,
            }),
            readCurrentRelayOwner: async () => null,
            switchDefaultReleaseChannel: async (channel) => { switches.push(channel); },
            readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
          }),
        },
      });

      expect(run.events).toContainEqual(expect.objectContaining({
        type: 'prompt',
        stepId: 'setup.thisComputer.preflight.releaseChannel',
        message: 'Make preview the default release-channel before installing the default background service targeting https://relay.example.test?',
      }));
      expect(run.result).toMatchObject({ ok: true, data: { machineId: 'machine-local-1' } });
      expect(switches).toEqual([]);
      expect(fakeCli.readInvocations()).toContainEqual([
        'server',
        'set',
        '--server-url',
        'https://relay.example.test',
        '--webapp-url',
        'https://app.example.test',
        '--no-use',
        '--json',
      ]);
    });
  });

  it('requests auth, answers the token-only approval, and completes setup.thisComputer.v1 when auth is missing', async () => {
    const fixture = createPairingFixture();
    await withFakeHappierCli({
      authStatus: NOT_AUTHENTICATED_STATUS,
      authRequests: [tokenOnlyAuthRequest(fixture)],
      authWaits: [{ success: true, machineId: 'machine-local-auth-1' }],
      daemonStatuses: [readyDaemonStatus('machine-local-auth-1')],
    }, async (fakeCli) => {
      const run = await runHsetup({
        spec: SETUP_SPEC,
        answers: [{ approved: true }],
        interactiveKinds: setupKindsWithoutGuidance(),
      });

      expect(lifecycle(run.events)).toEqual([
        { type: 'progress', stepId: 'setup.thisComputer.ensureCli' },
        { type: 'progress', stepId: 'setup.thisComputer.resolveRelay' },
        { type: 'progress', stepId: 'setup.thisComputer.configureRelay' },
        { type: 'prompt', stepId: 'setup.thisComputer.auth.request' },
        { type: 'progress', stepId: 'setup.thisComputer.auth.wait' },
        { type: 'progress', stepId: 'setup.thisComputer.installService' },
        { type: 'progress', stepId: 'setup.thisComputer.startService' },
        { type: 'progress', stepId: 'setup.thisComputer.verifyService' },
      ]);
      expect(run.result).toMatchObject({ ok: true, data: { machineId: 'machine-local-auth-1' } });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'list', '--json'],
        ['server', 'help'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--no-use', '--json'],
        ['--server', 'relay', 'auth', 'status', '--json'],
        ['--server', 'relay', 'auth', 'request', '--json'],
        ['--server', 'relay', 'auth', 'wait', '--public-key', fixture.publicKeyB64, '--json'],
        ['--server', 'relay', 'service', 'install', '--json'],
        ['--server', 'relay', 'service', 'start', '--json'],
        ['--server', 'relay', 'daemon', 'status', '--json'],
      ]);
    });
  });

  it('fails setup.thisComputer.v1 when local pairing does not expose a public key', async () => {
    await withFakeHappierCli({
      authStatus: { ok: true, kind: 'auth_status', data: { authenticated: true, credentialState: 'valid', machineRegistered: false } },
      authRequests: [{}],
    }, async (fakeCli) => {
      const run = await runHsetup({ spec: SETUP_SPEC, interactiveKinds: setupKindsWithoutGuidance() });

      expect(run.result).toEqual({
        protocolVersion: 1,
        taskId: 'task-local-1',
        ok: false,
        error: { code: 'invalid_cli_response', message: 'Received an invalid auth request response.' },
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'list', '--json'],
        ['server', 'help'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--no-use', '--json'],
        ['--server', 'relay', 'auth', 'status', '--json'],
        ['--server', 'relay', 'auth', 'request', '--json'],
      ]);
    });
  });

  it('completes setup.thisComputer.v1 by approving locally when authenticated but the machine is not yet server-confirmed', async () => {
    await withFakeHappierCli({
      authStatus: { ok: true, kind: 'auth_status', data: { authenticated: true, credentialState: 'valid', machineRegistered: false } },
      authRequests: [{ publicKey: 'public-key-local-2' }],
      authWaits: [{ success: true, machineId: 'machine-local-2' }],
      daemonStatuses: [readyDaemonStatus('machine-local-2')],
    }, async (fakeCli) => {
      const run = await runHsetup({ spec: SETUP_SPEC, interactiveKinds: setupKindsWithoutGuidance() });

      expect(run.result).toMatchObject({ ok: true, data: { machineId: 'machine-local-2' } });
      expect(fakeCli.readInvocations()).toEqual([
        ['server', 'list', '--json'],
        ['server', 'help'],
        ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--no-use', '--json'],
        ['--server', 'relay', 'auth', 'status', '--json'],
        ['--server', 'relay', 'auth', 'request', '--json'],
        ['--server', 'relay', 'auth', 'approve', '--public-key', 'public-key-local-2', '--json'],
        ['--server', 'relay', 'auth', 'wait', '--public-key', 'public-key-local-2', '--json'],
        ['--server', 'relay', 'service', 'install', '--json'],
        ['--server', 'relay', 'service', 'start', '--json'],
        ['--server', 'relay', 'daemon', 'status', '--json'],
      ]);
    });
  });

  it('fails setup.thisComputer.v1 when its daemon exits after setup', async () => {
    await withFakeHappierCli({
      daemonStatuses: [{
        server: { serverUrl: 'https://relay.example.test', localServerUrl: null, publicServerUrl: 'https://relay.example.test', webappUrl: 'https://app.example.test' },
        daemon: { running: false, pid: 4321 },
        service: { installed: true, running: false },
        auth: { authenticated: true, machineRegistered: true, machineId: 'machine-local-1', needsAuth: false },
      }],
    }, async (fakeCli) => {
      const run = await runHsetup({ spec: SETUP_SPEC, interactiveKinds: setupKindsWithoutGuidance() });
      expect(run.result).toMatchObject({
        protocolVersion: 1, taskId: 'task-local-1', ok: false,
        error: { code: 'daemon_service_not_ready', message: expect.stringContaining('daemon logs') },
      });
      expect(fakeCli.readInvocations()).toContainEqual(['--server', 'relay', 'daemon', 'status', '--json']);
    });
  });

  it('uses the publicdev release ring when setup.thisComputer.v1 specifies channel publicdev', async () => {
    await withFakeHappierCli({}, async (fakeCli) => {
      const homeDir = join(fakeCli.cliPath, '..');
      const previous = {
        homeDir: process.env.HAPPIER_HOME_DIR,
        repoDir: process.env.HAPPIER_STACK_REPO_DIR,
        cliPath: process.env.HAPPIER_BOOTSTRAP_CLI_PATH,
      };
      try {
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_STACK_REPO_DIR = homeDir;
        delete process.env.HAPPIER_BOOTSTRAP_CLI_PATH;

        const stablePath = join(homeDir, 'cli', 'current', 'happier');
        mkdirSync(join(homeDir, 'cli', 'current'), { recursive: true });
        writeFileSync(stablePath, '#!/bin/sh\nexit 1\n');
        chmodSync(stablePath, 0o755);
        const devPath = join(homeDir, 'cli-dev', 'current', 'happier');
        mkdirSync(join(homeDir, 'cli-dev', 'current'), { recursive: true });
        writeFileSync(devPath, readFileSync(fakeCli.cliPath, 'utf8'));
        chmodSync(devPath, 0o755);

        const run = await runHsetup({
          spec: { ...SETUP_SPEC, params: { ...SETUP_SPEC.params, channel: 'publicdev' } },
          interactiveKinds: {
            'setup.thisComputer.v1': createSetupThisComputerInteractiveTaskKind({
              // Production wiring by name: this file drives the real dispatcher and the real
              // setup recipe against the fake CLI installed at `HAPPIER_BOOTSTRAP_CLI_PATH`.
              ...createProductionSetupThisComputerInteractiveDeps(),
              exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
              readBackgroundServiceSetupGuidance: async () => createDefaultGuidance({
                targetReleaseChannel: 'preview',
                currentDefaultReleaseChannel: 'stable',
                managedReleaseChannels: [
                  { releaseChannel: 'stable', label: 'stable', version: '1.0.0', installationId: 'stable-install', installationPath: '/managed/stable', invokerName: 'happier', isDefault: true, onPath: true },
                  { releaseChannel: 'preview', label: 'dev', version: '2.0.0-dev.1', installationId: 'dev-install', installationPath: '/managed/dev', invokerName: 'hdev', isDefault: false, onPath: true },
                ],
                exactDefaultServiceExists: true,
                shouldOfferDefaultReleaseChannelSwitch: true,
              }),
            }),
          },
        });

        // The prompt is awaited from stdin, which closes without an answer: the task fails loudly
        // instead of hanging, and only ring-scoped read commands ran beforehand.
        expect(run.events).toContainEqual(expect.objectContaining({ type: 'prompt', stepId: 'setup.thisComputer.preflight.releaseChannel' }));
        expect(run.result).toMatchObject({ ok: false });
        expect(fakeCli.readInvocations()).toEqual([
          ['server', 'list', '--json'],
        ]);
      } finally {
        restoreEnvVar('HAPPIER_HOME_DIR', previous.homeDir);
        restoreEnvVar('HAPPIER_STACK_REPO_DIR', previous.repoDir);
        restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previous.cliPath);
      }
    });
  });
});
