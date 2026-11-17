import { execFileSync } from 'node:child_process';
import { captureProcessBirthWitness } from '@/daemon/processIdentity';
import { EventEmitter, once } from 'node:events';
import { rm } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Isolated Happier home: the host publishes its endpoint descriptor and the daemon its markers here.
const testHome = vi.hoisted(() => {
  const home = `${process.env.TMPDIR ?? '/tmp'}/happier-daemon-session-host-${process.pid}-${Date.now()}`;
  process.env.HAPPIER_HOME_DIR = home;
  return home;
});

/**
 * Process census at the OS boundary: every `happier session-host` launch is counted. The launched
 * "process" is this test process (pid = process.pid) running the real session host, so the daemon
 * side reaches it over the real owner-only endpoint with kernel peer identity (this process is both
 * the daemon and the host's trusted caller).
 */
const census = vi.hoisted(() => ({
  hostLaunches: 0,
  runnerLaunches: 0,
  /** Runner-code preloads the hosts performed (a prestarted host loads the runner before its first Session). */
  runnerPreloads: 0,
  /** The environment each session host was launched with. */
  hostLaunchEnvironments: [] as Array<Record<string, string | undefined>>,
  startHost: null as null | (() => Promise<EventEmitter>),
  /** The launched host "processes" as the daemon sees them (exit = the host process died). */
  hostChildren: [] as Array<import('node:events').EventEmitter & Record<string, unknown>>,
}));

/**
 * Transport boundary, observed only: the sockets accepted by the host endpoint, so a test can
 * break every host connection the way a dying host process does.
 */
const hostSockets = vi.hoisted(() => new Set<import('node:net').Socket>());
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return { ...actual, createServer: ((...args: unknown[]) => {
    const listener = args.find((arg): arg is (socket: import('node:net').Socket) => void => typeof arg === 'function');
    const options = args.find(arg => typeof arg === 'object' && arg !== null);
    const observed = (socket: import('node:net').Socket) => {
      hostSockets.add(socket);
      socket.once('close', () => hostSockets.delete(socket));
      listener?.(socket);
    };
    return options ? actual.createServer(options as import('node:net').ServerOpts, observed) : actual.createServer(observed);
  }) as typeof actual.createServer };
});

async function mockChildProcess(importOriginal: () => Promise<typeof import('node:child_process')>) {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const argv = (args[1] ?? []) as readonly string[];
    if (argv.includes('session-host')) {
      census.hostLaunches += 1;
      census.hostLaunchEnvironments.push({ ...((args[2] as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) });
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdout = new PassThrough();
      // The launched process is a launch supervisor (Linux scope exec): its pid is not the host's.
      // The host names its own pid on its ready line.
      Object.assign(child, { pid: SUPERVISOR_PID, exitCode: null, signalCode: null, stdout, stderr: new PassThrough(), kill: () => true });
      census.hostChildren.push(child);
      void census.startHost!().then(() => stdout.write(`happier-session-host-ready ${process.pid}\n`));
      return child as unknown as ReturnType<typeof actual.spawn>;
    }
    if (argv.some(arg => arg === 'codex')) {
      // A one-Session runner launch: counted, never started (it would be a real CLI process).
      census.runnerLaunches += 1;
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null,
        stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      return child as unknown as ReturnType<typeof actual.spawn>;
    }
    return actual.spawn(...args);
  } };
}
vi.mock('node:child_process', mockChildProcess);
vi.mock('child_process', mockChildProcess);

const SUPERVISOR_PID = 2_000_001;
const peerHelper = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('@/subprocess/supervision/processCustody', async (original) => ({
  ...(await original<typeof import('@/subprocess/supervision/processCustody')>()),
  resolveProcessCustodyPeerIdentityExecutable: () => peerHelper.path,
}));

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { startSessionHost } from '@/agent/runtime/lifecycle/sessionHost';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';

import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import type { SessionTrackingKey } from '../sessions/sessionTrackingKey';
import { createSpawnLifecycleCallbacks } from '../spawn/createSpawnLifecycleCallbacks';
import { persistAcceptedSpawnMarker } from '../spawn/persistAcceptedSpawnMarker';
import { spawnRegularProcessAndWaitForWebhook } from '../spawn/spawnRegularProcessAndWaitForWebhook';
import type { TrackedSession } from '../types';
import type { ChildExit } from '../sessions/onChildExited';

import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { SessionHost } from '@/agent/runtime/lifecycle/sessionHost';
import { SESSION_HOLDER_ADOPT_ENV_KEY } from '@/subprocess/supervision/sessionHolder';
import { SESSION_HOST_HANDOVER_EXIT_CODE, type SessionHostLaunchRecordV1 } from '@/session/transport/rpc/localSessionRpcChannel';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { createRunnerAgentSessionBootstrapAuthorization } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { SessionHostLaunchAccountChangedError } from '@/agent/runtime/lifecycle/sessionHostCredentialHold';
import { PLUGIN_MANIFEST as codexManifest } from '../../../../../packages/plugins/codex/src/manifest';

import { createSessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import { createSparedHeldAgentCustody } from '../processSupervision/sparedHeldAgents';
import type { OwnerRemainderPort } from '../processes/endOwnerRemainder';
import { createOnChildExited } from '../sessions/onChildExited';

import { createDaemonSessionHost, createSessionHostPlacement } from './daemonSessionHost';
import { requestConnectedServiceSessionRestartSignal } from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import axios from 'axios';
import { createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createStopSession } from '../sessions/stopSession';
import { retireExactTerminalControlServiceability, retireStoppedPlainRunnerControlServiceability } from '../sessions/retireTerminalControlServiceability';
import { waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import { readSessionMarker } from '../sessionRegistry';
import { buildTrackedSessionFromMarker } from '../sessions/trackedSessionFromMarker';
import { resolveSessionRunnerRestartEligibility } from '../sessionRunnerRuntime/resolveRestartEligibility';
import { reportSessionRunnerFailure } from '@/cli/resolveSessionRunnerFailureExitCode';
import { endSessionCommand } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';

function resolvePeerHelper(): string {
  const staged = resolveProcessCustodySupportExecutable(process.platform);
  if (staged) {
    try { execFileSync(staged, ['peer-identity'], { stdio: 'ignore', timeout: 10_000 }); return staged; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOEXEC' && code !== 'EACCES' && code !== 'ENOENT') return staged;
    }
  }
  const out = join(testHome, 'happier-process-custody-test');
  execFileSync('go', ['build', '-o', out, '.'], { cwd: resolvePath(__dirname, '../../../native/processcustody'), stdio: 'ignore', timeout: 600_000 });
  return out;
}

type InProcessHost = Readonly<{ process: EventEmitter; exit: ReturnType<typeof vi.fn<(code: number) => void>>; host: SessionHost }>;

/**
 * One daemon's view through the real spawn owner, report owner and daemon session host. Every
 * launched host runs in this process (see the child_process mock); each hosted runner command stays
 * in its turn until the test releases it, and records the Session environment it was added with.
 */
/** In-process hosts still serving at the end of a test (a real host is its own process). */
const liveInProcessHosts = new Set<InProcessHost>();

async function createHarness(startupFailure?: Error,
  readTrustedCaller: Parameters<typeof startSessionHost>[0]['readTrustedCaller'] = () => captureProcessBirthWitness(process.pid)) {
  peerHelper.path ??= resolvePeerHelper();
  const releaseSessions: Array<() => void> = [];
  const hostedEnvironments: Array<Readonly<Record<string, string | undefined>>> = [];
  const hostedLaunches: SessionHostLaunchRecordV1[] = [];
  const hosts: InProcessHost[] = [];
  census.startHost = async () => {
    const hostProcess = new EventEmitter();
    // A host process that exits breaks every connection to it.
    const hostExit = vi.fn<(code: number) => void>(code => {
      for (const socket of hostSockets) socket.destroy();
      if (startupFailure) {
        const child = census.hostChildren.at(-1)!;
        child.exitCode = code;
        child.emit('exit', code, null);
      }
    });
    const host = await startSessionHost({
      runSessionCommand: async (_argv, launch) => {
        hostedEnvironments.push({ ...sessionProcessEnvironment() });
        hostedLaunches.push(launch);
        if (startupFailure) {
          endSessionCommand(reportSessionRunnerFailure(startupFailure));
          return;
        }
        const termination = registerRunnerTerminationHandlers({ process: hostProcess, exit: hostExit, onTerminate: () => undefined });
        await Promise.race([new Promise<void>((resolve) => { releaseSessions.push(resolve); }), termination.whenTerminated]);
        termination.dispose();
      },
      readTrustedCaller,
      preloadSessionRunner: async () => { census.runnerPreloads += 1; },
      process: hostProcess,
      exit: hostExit,
    });
    const inProcess = { process: hostProcess, exit: hostExit, host };
    hosts.push(inProcess);
    liveInProcessHosts.add(inProcess);
    void host.whenEnded.then(() => liveInProcessHosts.delete(inProcess));
    return hostProcess;
  };

  const tracked = new Map<SessionTrackingKey, TrackedSession>();
  const accepted: TrackedSession[] = [];
  const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
  const exits: Array<Readonly<{ pid: number; exit: ChildExit }>> = [];
  let observeExit: (pid: number, exit: ChildExit) => Promise<void> = async () => {};
  if (startupFailure) observeExit = createOnChildExited({ trackedSessionsByKey: tracked,
    spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
  const onChildExited = async (pid: number, exit: ChildExit) => {
    exits.push({ pid, exit });
    await observeExit(pid, exit);
  };
  const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(testHome, 'device-local-key.json') });
  const callbacks = createSpawnLifecycleCallbacks({
    connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture',
    hasConnectedServiceAuth: () => false, getSpawnResourceCleanupOnExit: () => null,
    onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByKey: new Map(),
    getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {}, sessionAttachCleanupByKey: new Map(),
    persistAcceptedSpawnMarker: async (session, options) => {
      accepted.push(session);
      await persistAcceptedSpawnMarker({ trackedSession: session, deviceLocalSecretStorage, ...options });
    },
  });
  const sessionHost = createDaemonSessionHost({
    processEnv: { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir },
    directory: testHome,
    logDebug: () => {},
  });
  const report = createOnHappySessionWebhook({
    trackedSessionsByKey: tracked, spawnAwaiterByKey: awaiters,
    readProcessIdentityByPidFn: async (pid) => ({ pid, processStartTimeMs: 1_000, command: HOST_COMMAND }),
    readCredentialsFn: async () => null,
  });
  // One spawn at a time, so each report reaches the Session that spawn just tracked.
  let spawnQueue: Promise<unknown> = Promise.resolve();
  type LaunchFacts = Pick<Parameters<typeof spawnRegularProcessAndWaitForWebhook>[0],
    'sessionHostLaunchAccount' | 'runnerAgentSessionBootstrapAuthorization'>;
  const spawnSession = (sessionId: string, extraEnv: Record<string, string> = {}, launch: LaunchFacts = {}) => {
    const run = spawnQueue.then(() => spawnOneSession(sessionId, extraEnv, launch));
    spawnQueue = run.catch(() => undefined);
    return run;
  };
  const spawnOneSession = async (sessionId: string, extraEnv: Record<string, string>, launch: LaunchFacts) => {
    const before = new Set([...tracked.keys(), ...accepted.map(session => session.trackingKey)]);
    const pending = spawnRegularProcessAndWaitForWebhook({
      args: ['codex', '--happy-starting-mode', 'remote', '--started-by', 'daemon'], directory: testHome, options: { directory: testHome }, trackedSpawnOptions: { directory: testHome },
      normalizedExistingSessionId: '', effectiveResume: '', directoryCreated: false, extraEnvForChildWithMessage: extraEnv,
      processEnv: { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir },
      trackedSessionsByKey: tracked, spawnAwaiterByKey: awaiters, spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
      resolveCanonicalTrackedSessionId: trackingKey => tracked.get(trackingKey)?.happySessionId ?? '',
      onChildExited,
      spawnLifecycleCallbacks: callbacks, cleanupSpawnResources: () => {}, logDebug: () => {}, warn: () => {},
      sessionHost,
      ...launch,
    });
    const record = await vi.waitFor(() => {
      const added = [...tracked.values(), ...accepted].find(session => !before.has(session.trackingKey));
      if (!added) throw new Error('Session not tracked yet');
      return added;
    }, { timeout: 60_000 });
    await record.acceptedSpawnMarkerGate;
    if (startupFailure) return { record, result: await pending };
    await report(sessionId, { hostPid: record.pid, path: testHome, startedBy: 'daemon' } as Metadata, undefined, undefined, record.trackingKey);
    await record.reportMarkerCustody?.pending;
    return { record, result: await pending };
  };
  return {
    tracked, exits, hosts, hostedEnvironments, hostedLaunches, releaseSessions, spawnSession, sessionHost,
    setExitObserver: (observer: (pid: number, exit: ChildExit) => Promise<void>) => { observeExit = observer; },
    releaseAll: () => { for (const release of releaseSessions.splice(0)) release(); },
    /** Daemon restart: hand the reattached Sessions of a live host to this daemon's session host. */
    adoptReattached: (sessions: readonly TrackedSession[], isCurrentRuntime?: (processCommand: string) => boolean) =>
      sessionHost.adoptReattachedSessions({ trackedSessions: sessions, observeExit: onChildExited, ...(isCurrentRuntime ? { isCurrentRuntime } : {}) }),
  };
}

/** The host process dies (SIGKILL): every host connection breaks and the daemon observes its exit. */
async function crashLatestHost(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  for (const socket of hostSockets) socket.destroy();
  // The in-process stand-in stops serving (a dead process serves nothing) before its exit is seen.
  const inProcess = harness.hosts.at(-1)!;
  inProcess.process.emit('SIGTERM');
  await inProcess.host.whenEnded;
  const child = census.hostChildren.at(-1)!;
  child.signalCode = 'SIGKILL';
  child.emit('exit', null, 'SIGKILL');
}

const HOST_COMMAND = '/runtime/bin/happier session-host';

describe('session host launch', () => {
  it('retains a host admission refusal in the public spawn failure without starting a Session', { timeout: 120_000 }, async () => {
    const harness = await createHarness(undefined, async () => null);
    const added = await harness.sessionHost.addSession({ trackingKey: 'refused-admission', argv: ['codex'],
      env: {}, cwd: testHome });
    expect(added.status).toBe('failed');
    if (added.status !== 'failed' || added.result.type !== 'error') throw new Error('Expected admission refusal');
    expect(projectSessionSpawnFailure({ errorCode: added.result.errorCode,
      errorMessage: added.result.errorMessage, errorDetail: added.result.errorDetail }))
      .toMatchObject({ type: 'error', launchError: { code: 'local_session_peer_refused',
        failureCause: { phase: 'client_start', httpStatus: 403 } } });
    expect(harness.hostedEnvironments).toEqual([]);
  });
  it('preserves a hosted runner startup cause through the public spawn failure', { timeout: 120_000 }, async () => {
    const failureCause = { code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
      phase: 'client_start' as const, failureReason: 'unknown' as const };
    const harness = await createHarness(Object.assign(new Error('PRIVATE_BODY'), { failureCause }));
    const { result } = await harness.spawnSession('failed-session');
    if (result.type !== 'error') throw new Error('Expected startup failure');
    const projected = projectSessionSpawnFailure({ errorCode: result.errorCode,
      errorMessage: result.errorMessage, errorDetail: result.errorDetail });
    expect(projected).toMatchObject({ type: 'error', code: 'spawn_failed', launchError: { failureCause } });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_BODY');
  });
  it('ends a Session admitted for another Account with its typed account_changed cause in the public spawn failure', { timeout: 120_000 }, async () => {
    const harness = await createHarness(new SessionHostLaunchAccountChangedError());
    const { result } = await harness.spawnSession('account-changed');
    if (result.type !== 'error') throw new Error('Expected startup refusal');
    expect(projectSessionSpawnFailure({ errorCode: result.errorCode, errorMessage: result.errorMessage, errorDetail: result.errorDetail }))
      .toMatchObject({ type: 'error', launchError: { failureCause: { phase: 'authentication', failureReason: 'account_changed' } } });
  });
  it('sends the admitted launch record (Account, epoch, Machine, Settings floor, runner bootstrap) with the host add', { timeout: 120_000 }, async () => {
    const definition = PluginAgentContributionV2Schema.parse(codexManifest.contributes.agents?.[0]);
    const issued = await createRunnerAgentSessionBootstrapAuthorization({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      descriptor: { v: 1, pluginId: codexManifest.id, pluginVersion: codexManifest.version, agentId: definition.id,
        backendId: 'codex', occurrenceId: 'recorded-admitted-runtime',
        sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: 'recorded' } },
        agentDeclaration: { provenance: 'first_party', source: { kind: 'bundled' }, definition } },
    });
    const account = { accountId: 'account-a', credentialEpoch: 1, machineId: 'machine-1', settingsVersion: 7 };
    const harness = await createHarness();
    // The record reaches the host at add time. The later report runs the recorded descriptor's own
    // adoption checks, which this fixture does not satisfy; only the add is asserted here.
    const launched = harness.spawnSession('launch-record', {}, {
      sessionHostLaunchAccount: account, runnerAgentSessionBootstrapAuthorization: issued.authorization }).catch(() => null);
    await vi.waitFor(() => expect(harness.hostedLaunches).toHaveLength(1), { timeout: 60_000 });
    expect(harness.hostedLaunches[0]).toEqual({ account,
      runnerBootstrap: { path: issued.authorization.bootstrapFilePath, bootstrap: issued.authorization.bootstrap } });
    // Facts only (exact shape above): no bearer or Settings read key crosses the host channel.
    await launched;
    harness.releaseAll();
    await harness.hosts.at(-1)!.host.whenEnded;
    await issued.cleanupBootstrapFile();
  });
  it('launches the host with the daemon\'s Home and server identity, even when the daemon environment lacks them', { timeout: 120_000 }, async () => {
    const harness = await createHarness();
    const launchesBefore = census.hostLaunchEnvironments.length;
    const a = await harness.spawnSession('session-a');
    expect(a.result).toMatchObject({ type: 'success', sessionId: 'session-a' });
    const launched = census.hostLaunchEnvironments.slice(launchesBefore);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      HAPPIER_HOME_DIR: configuration.happyHomeDir,
      HAPPIER_ACTIVE_SERVER_ID: configuration.activeServerId,
    });
    // The host is tracked by its own pid (from its ready line), never the launch supervisor's.
    expect(a.record.pid).toBe(process.pid);
    harness.releaseAll();
    await a.record.hostedSession!.observed;
  });
});

describe('session host placement decision', () => {
  it('places every headless Session in the session host, except on Windows (no switch)', () => {
    const placement = (platform: NodeJS.Platform) =>
      createSessionHostPlacement({ processEnv: {}, logDebug: () => {}, platform }).place();
    expect(placement('linux')).toBeDefined();
    expect(placement('darwin')).toBeDefined();
    expect(placement('win32')).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('daemon session host placement', () => {
  afterEach(async () => {
    for (const inProcess of [...liveInProcessHosts]) {
      inProcess.process.emit('SIGTERM');
      await inProcess.host.whenEnded;
    }
  });
  afterAll(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  it('starts no process for a second Session and ends only the Session whose host end it observed', { timeout: 120_000 }, async () => {
    const launchesBefore = census.hostLaunches;
    const harness = await createHarness();
    const a = await harness.spawnSession('session-a');
    const b = await harness.spawnSession('session-b');

    expect(a.result).toMatchObject({ type: 'success', sessionId: 'session-a' });
    expect(b.result).toMatchObject({ type: 'success', sessionId: 'session-b' });
    // Process census: one session host process, no runner process, for two Sessions.
    expect(census.hostLaunches - launchesBefore).toBe(1);
    expect(census.runnerLaunches).toBe(0);
    expect(a.record.pid).toBe(process.pid);
    expect(b.record.pid).toBe(process.pid);
    expect(a.record.childProcess).toBeUndefined();
    // Real spawn + report + marker reattachment retain the Session's mode, not the host argv.
    const marker = await readSessionMarker(a.record.trackingKey);
    const reattached = buildTrackedSessionFromMarker({ marker: marker!, startedByFallback: 'reattached',
      spawnOptions: { directory: testHome, existingSessionId: 'session-a' }, reattachedFromDiskMarker: true });
    expect(resolveSessionRunnerRestartEligibility(reattached)).toEqual({ eligible: true, disabledReason: null });

    // Stop of A goes through the host; its end is observed for A only, never as the host's exit.
    await expect(a.record.hostedSession!.end()).resolves.toBe(true);
    await a.record.hostedSession!.observed;
    expect(harness.exits).toEqual([{ pid: process.pid, exit: expect.objectContaining({ trackingKey: a.record.trackingKey }) }]);
    expect(harness.hosts[0]!.exit).not.toHaveBeenCalled();

    harness.releaseAll();
    await b.record.hostedSession!.observed;
    expect(harness.exits.map(({ exit }) => exit.trackingKey)).toEqual([a.record.trackingKey, b.record.trackingKey]);
  });

  it.each(['launched', 'reattached'] as const)('refreshes only the selected Session in a shared host (%s)', { timeout: 120_000 }, async placement => {
    const first = await createHarness();
    const a = await first.spawnSession('refresh-a');
    const b = await first.spawnSession('refresh-b');
    const liveHost = first.hosts.at(-1)!;
    const launchesBeforeRefresh = census.hostLaunches;
    let daemon = first;
    let selected = a.record;
    let peer = b.record;
    if (placement === 'reattached') {
      daemon = await createHarness();
      const reattached: TrackedSession[] = [a.record, b.record].map(record => ({
        trackingKey: record.trackingKey, pid: record.pid, happySessionId: record.happySessionId,
        startedBy: 'daemon', processStartTimeMs: 1_000, processCommand: HOST_COMMAND,
        reattachedFromDiskMarker: true, spawnOptions: { directory: testHome },
      }));
      for (const session of reattached) daemon.tracked.set(session.trackingKey, session);
      expect(daemon.adoptReattached(reattached)).toBe(2);
      [selected, peer] = [reattached[0]!, reattached[1]!];
    }
    // Model the OS signal boundary without ever signalling this test process.
    // The old PID restart path terminates the real in-process host and its peers.
    const processKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 'SIGTERM' && Math.abs(pid) === process.pid) {
        liveHost.process.emit('SIGTERM');
        return true;
      }
      return processKill(pid, signal);
    });
    try {
      await expect(requestConnectedServiceSessionRestartSignal({
        pid: selected.pid, delayMs: 0, preferProcessGroup: true,
        hostedSession: selected.hostedSession,
        onSignalFailure: error => { throw error; },
      })).resolves.toEqual({ status: 'requested' });
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toEqual([]);
      await selected.hostedSession!.observed;
      expect(daemon.exits.map(({ exit }) => exit.trackingKey)).toEqual([selected.trackingKey]);
      expect(liveHost.exit).not.toHaveBeenCalled();

      const replacement = await daemon.spawnSession('refresh-a');
      expect(replacement.result).toMatchObject({ type: 'success', sessionId: 'refresh-a' });
      expect(replacement.record.trackingKey).not.toBe(selected.trackingKey);
      expect(replacement.record.pid).toBe(peer.pid);
      expect(census.hostLaunches).toBe(launchesBeforeRefresh);
      expect(daemon.exits.map(({ exit }) => exit.trackingKey)).toEqual([selected.trackingKey]);
      first.releaseAll();
      daemon.releaseAll();
      await Promise.all([peer.hostedSession!.observed, replacement.record.hostedSession!.observed]);
    } finally {
      kill.mockRestore();
      first.releaseAll();
      daemon.releaseAll();
    }
  });

  it.each(['plain', 'e2ee'] as const)('Stop retires only its Session while the shared host stays alive (%s)', { timeout: 120_000 }, async accountMode => {
    const harness = await createHarness();
    const a = await harness.spawnSession('stop-ready');
    const b = await harness.spawnSession('stop-never-ready');
    const c = await harness.spawnSession('stop-publication-refused');
    const secret = new Uint8Array(32).fill(7);
    const credentials = { token: 'fixture', encryption: accountMode === 'e2ee' ? { type: 'legacy' as const, secret } : null };
    const accountCurrentness = { mode: accountMode, version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: accountMode === 'e2ee'
        ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
          createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint)
        : null, updatedAt: 1 };
    const rawSessions = new Map([a, b, c].map(({ record }) => {
      const sessionId = record.happySessionId!;
      const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: accountMode, agentState: null,
        metadata: { path: testHome, hostPid: record.pid, hostProcessStartTimeMs: record.processStartTimeMs,
          ...(record === a.record ? { lifecycleState: 'running', lifecycleStateSince: 1 } : {}) },
        ...(accountMode === 'e2ee' ? { storedContentMode: 'e2ee', encryptionKey: secret, encryptionVariant: 'legacy' }
          : { storedContentMode: 'plain' }) });
      return [sessionId, createSessionRecordFixture({ id: sessionId, encryptionMode: accountMode, active: false,
        share: null, metadataLayoutVersion: 1, metadataVersion: 1, metadata: fields.sharedMetadata.ciphertext,
        ownerMetadata: fields.ownerMetadata, agentState: fields.agentState })] as const;
    }));
    // HTTP/socket carriers are boundaries. Session-host transport, Session end,
    // exit custody, metadata encryption/publication and Stop all remain real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: String(url).includes('/v2/sessions/')
        ? { session: rawSessions.get(new URL(String(url)).pathname.split('/').at(-1)!) } : accountCurrentness }));
    const patch = vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
      const raw = [...rawSessions.values()].find(session => String(url).includes(session.id));
      if (!raw) throw new Error('Unknown fixture Session');
      const mutation = SessionMetadataTuplePatchV1Schema.parse(body);
      if (mutation.mode !== 'owner') throw new Error('Expected owner metadata publication');
      if (raw.id === c.record.happySessionId) {
        throw new axios.AxiosError('Private fixture publication refusal', 'ERR_BAD_REQUEST', undefined, undefined,
          { status: 403, statusText: 'Forbidden', data: {}, headers: {}, config: { headers: new axios.AxiosHeaders() } });
      }
      raw.ownerMetadata = mutation.ownerMetadata;
      raw.metadataVersion++;
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
    });
    const machine = { captureMachineSessionTerminal: async (sessionId: string) => ({ v: 1 as const, status: 'already_inactive' as const, sessionId }),
      finalizeMachineSessionTerminal: async () => { throw new Error('Inactive Session cannot finalize again'); },
    } satisfies Pick<ApiMachineClient, 'captureMachineSessionTerminal' | 'finalizeMachineSessionTerminal'>;
    const onExit = createOnChildExited({ trackedSessionsByKey: harness.tracked, spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => machine as ApiMachineClient });
    harness.setExitObserver(onExit);
    const stop = createStopSession({ trackedSessionsByKey: harness.tracked,
      waitForTrackedRunnersExit: ({ trackedPids }) => waitForTrackedRunnerProcessesExit({
        runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0 }),
      retireAbsentTerminalControlServiceability: ({ sessionId, trackedSession, stoppedAt }) =>
        retireStoppedPlainRunnerControlServiceability({ sessionId, trackedSession,
          publishRetirement: expectedRunner => retireExactTerminalControlServiceability({
            credentials, sessionId, terminalMode: 'plain', expectedRunner, stoppedAt }) }),
    });
    try {
      await expect(stop(a.record.happySessionId!)).resolves.toEqual({ status: 'stopped' });
      expect(tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: accountMode,
        rawSession: rawSessions.get(a.record.happySessionId!)! })).toMatchObject({ lifecycleState: 'stopped',
          terminal: { mode: 'plain', controlServiceabilityV1: { retired: true } } });
      expect(harness.tracked.has(a.record.trackingKey)).toBe(false);
      expect(harness.tracked.has(b.record.trackingKey)).toBe(true);
      expect(harness.hosts[0]!.host.watchSession(b.record.trackingKey)).not.toBeNull();
      expect(harness.hosts[0]!.exit).not.toHaveBeenCalled();
      await expect(stop(c.record.happySessionId!)).resolves.toMatchObject({
        status: 'incomplete', reason: 'terminal_control_serviceability_retirement_failed', effectAttempted: true,
        failureCause: { phase: 'stop.plain_control_serviceability_retirement', errorClass: 'AxiosError',
          errorCode: 'ERR_BAD_REQUEST', httpStatus: 403 },
      });
      expect(harness.tracked.has(c.record.trackingKey)).toBe(false);
      expect(harness.hosts[0]!.host.watchSession(b.record.trackingKey)).not.toBeNull();
      expect(harness.hosts[0]!.exit).not.toHaveBeenCalled();
      // The last Session may also end the host, as in Account D. Its Stop still
      // consumes that Session's end report instead of waiting for a process kill.
      await expect(stop(b.record.happySessionId!)).resolves.toEqual({ status: 'stopped' });
      expect(tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: accountMode,
        rawSession: rawSessions.get(b.record.happySessionId!)! })).toMatchObject({ lifecycleState: 'stopped',
          terminal: { mode: 'plain', controlServiceabilityV1: { retired: true } } });
      expect(harness.tracked.size).toBe(0);
      await harness.hosts[0]!.host.whenEnded;
    } finally {
      harness.releaseAll();
      await Promise.all([a.record.hostedSession!.observed, b.record.hostedSession!.observed, c.record.hostedSession!.observed]);
      get.mockRestore(); patch.mockRestore();
    }
  });

  it('observes a host crash as each Session\'s unexpected exit and respawns them into ONE new host, adopting held Agents', { timeout: 120_000 }, async () => {
    const harness = await createHarness();
    const a = await harness.spawnSession('session-a');
    const b = await harness.spawnSession('session-b');
    // A's runner holds an adoptable primary Agent (reported over the daemon control route); B holds none.
    const heldA = { role: 'primary' as const, socketPath: join(testHome, 'held-a.sock'), holderPid: 7101, agentPid: 7102 };
    a.record.heldAgentsV1 = [heldA];

    // The real exit owner, spare custody and respawn owner. The owner remainder (OS process ends)
    // and the holder probe (holder socket) are the boundaries.
    const remainderEnds: Array<Readonly<{ sessionId: string; spare: readonly number[] }>> = [];
    const ownerRemainder: OwnerRemainderPort = {
      capture: async () => undefined,
      captureTree: async () => undefined,
      observeEnd: async () => ({ status: 'complete', outcomes: [] }),
      end: async (owner, _capture, options) => {
        remainderEnds.push({ sessionId: owner.kind === 'session' ? owner.sessionId : '', spare: options?.spare ?? [] });
        return { status: 'complete', outcomes: [] };
      },
    };
    const spared = createSparedHeldAgentCustody({ ownerRemainder, endTurn: async () => {}, probe: async held => held.holderPid === heldA.holderPid });
    const respawned: Array<Promise<unknown>> = [];
    const respawn = createSessionRunnerRespawnManager({
      enabled: true, maxRestarts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0, random: () => 0,
      isSessionAlreadyRunning: () => false,
      // The daemon spawn path: the adopt token travels in the Session environment (prepareDaemonSpawnChildEnvironment).
      spawnSession: (options, predecessor) => {
        const spawn = harness.spawnSession(predecessor.sessionId, options.adoptSessionHolder
          ? { [SESSION_HOLDER_ADOPT_ENV_KEY]: JSON.stringify(options.adoptSessionHolder) } : {}).then(({ result }) => result);
        respawned.push(spawn);
        return spawn;
      },
      onRespawnSuccess: ({ sessionId }) => spared.handOver(sessionId),
      onRespawnTerminal: async ({ sessionId }) => { await spared.end(sessionId); },
      logDebug: () => {}, logWarn: () => {},
    });
    const exitOwner = createOnChildExited({
      trackedSessionsByKey: harness.tracked,
      ownerRemainder,
      spareHeldAgent: tracked => spared.spare(tracked),
      spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      onUnexpectedExit: (tracked, exit) => { respawn.handleUnexpectedExit(tracked, exit); },
    });
    harness.setExitObserver((pid, exit) => exitOwner(pid, exit));
    const launchesBeforeCrash = census.hostLaunches;
    const environmentsBeforeCrash = harness.hostedEnvironments.length;

    await crashLatestHost(harness);
    await Promise.all([a.record.hostedSession!.observed, b.record.hostedSession!.observed]);

    // Each hosted Session observed the host's death as its own unexpected exit.
    expect(harness.exits.map(({ exit }) => [exit.trackingKey, exit.signal])).toEqual(expect.arrayContaining([
      [a.record.trackingKey, 'SIGKILL'], [b.record.trackingKey, 'SIGKILL']]));
    // A's held Agent was spared by its Session's remainder end; B had nothing to spare.
    expect(remainderEnds).toEqual(expect.arrayContaining([
      { sessionId: 'session-a', spare: [heldA.holderPid] }, { sessionId: 'session-b', spare: [] }]));

    await vi.waitFor(() => { if (respawned.length < 2) throw new Error('respawns pending'); }, { timeout: 30_000 });
    const results = await Promise.all(respawned);
    expect(results).toEqual([expect.objectContaining({ type: 'success' }), expect.objectContaining({ type: 'success' })]);
    // ONE new host for both Sessions, no runner process.
    expect(census.hostLaunches - launchesBeforeCrash).toBe(1);
    expect(census.runnerLaunches).toBe(0);
    // A re-added with its adopt token; B through today's path (no token).
    const readded = harness.hostedEnvironments.slice(environmentsBeforeCrash);
    expect(readded.map(environment => environment[SESSION_HOLDER_ADOPT_ENV_KEY] ? JSON.parse(environment[SESSION_HOLDER_ADOPT_ENV_KEY]!).holderPid : null).sort())
      .toEqual([heldA.holderPid, null].sort());
    harness.releaseAll();
  });

  it('hands a stale host\'s live Sessions to a current host after a CLI update: the old host exits and each Session takes the adopt path', { timeout: 120_000 }, async () => {
    const first = await createHarness();
    const a = await first.spawnSession('session-a');
    const b = await first.spawnSession('session-b');
    const oldHost = first.hosts.at(-1)!;
    const launchesBeforeUpdate = census.hostLaunches;

    // The daemon restarts on a newer CLI; the live host runs the previous runtime.
    for (const socket of hostSockets) socket.destroy();
    const updated = await createHarness();
    const reattached = [a.record, b.record].map(record => ({
      trackingKey: record.trackingKey, pid: record.pid, happySessionId: record.happySessionId,
      startedBy: 'daemon' as const, processStartTimeMs: 1_000, processCommand: HOST_COMMAND,
      reattachedFromDiskMarker: true, spawnOptions: { directory: testHome },
    }) as TrackedSession);
    for (const session of reattached) updated.tracked.set(session.trackingKey, session);
    expect(updated.adoptReattached(reattached, () => false)).toBe(2);

    // The old host stops admitting and exits without ending its Sessions; each Session's end is an
    // unexpected exit (the crash path: spare held Agents, respawn into the current host, adopt).
    await vi.waitFor(() => expect(oldHost.exit).toHaveBeenCalledWith(SESSION_HOST_HANDOVER_EXIT_CODE), { timeout: 20_000 });
    await Promise.all(reattached.map(session => session.hostedSession!.observed));
    expect(updated.exits.map(({ exit }) => [exit.trackingKey, exit.reason]).sort())
      .toEqual(reattached.map(session => [session.trackingKey, 'process-missing']).sort());

    // A new Session starts a current host (the stale one is never reused).
    const c = await updated.spawnSession('session-c');
    expect(c.result).toMatchObject({ type: 'success', sessionId: 'session-c' });
    expect(census.hostLaunches - launchesBeforeUpdate).toBe(1);
    first.releaseAll();
    updated.releaseAll();
  });

  it('reattaches a restarted daemon to the live host: Stop ends only that Session and new Sessions join the same host', { timeout: 120_000 }, async () => {
    const first = await createHarness();
    const a = await first.spawnSession('session-a');
    const b = await first.spawnSession('session-b');
    const launchesBeforeRestart = census.hostLaunches;
    const liveHost = first.hosts.at(-1)!;

    // Daemon restart: the previous daemon's host connections are gone; the new daemon rebuilds its
    // tracked Sessions from the markers (pid, birth and command identity of the host process).
    for (const socket of hostSockets) socket.destroy();
    const restarted = await createHarness();
    const reattached = [a.record, b.record].map(record => ({
      trackingKey: record.trackingKey, pid: record.pid, happySessionId: record.happySessionId,
      startedBy: 'daemon' as const, processStartTimeMs: 1_000, processCommand: HOST_COMMAND,
      reattachedFromDiskMarker: true, spawnOptions: { directory: testHome },
    }) as TrackedSession);
    for (const session of reattached) restarted.tracked.set(session.trackingKey, session);

    expect(restarted.adoptReattached(reattached)).toBe(2);
    const [ra, rb] = reattached;
    // Stop of A reaches the host; A's end is observed for A only; the host and B live on.
    await expect(ra!.hostedSession!.end()).resolves.toBe(true);
    await ra!.hostedSession!.observed;
    expect(restarted.exits).toEqual([{ pid: process.pid, exit: expect.objectContaining({ trackingKey: ra!.trackingKey }) }]);
    expect(liveHost.exit).not.toHaveBeenCalled();

    // A new Session joins the reattached host: no host launch.
    const c = await restarted.spawnSession('session-c');
    expect(c.result).toMatchObject({ type: 'success', sessionId: 'session-c' });
    expect(census.hostLaunches).toBe(launchesBeforeRestart);

    first.releaseAll();
    restarted.releaseAll();
    await Promise.all([rb!.hostedSession!.observed, c.record.hostedSession!.observed]);
    expect(restarted.exits.map(({ exit }) => exit.trackingKey).sort())
      .toEqual([ra!.trackingKey, rb!.trackingKey, c.record.trackingKey].sort());
  });

  it('prestarts ONE host on New Session intents, preloads the runner once, and the next Session joins that host', { timeout: 120_000 }, async () => {
    const launchesBefore = census.hostLaunches;
    const preloadsBefore = census.runnerPreloads;
    const harness = await createHarness();
    // No intent, no host: an idle daemon starts nothing.
    expect(census.hostLaunches - launchesBefore).toBe(0);

    // Two devices open New Session on this Machine at once.
    const phone = new AbortController();
    const web = new AbortController();
    const held = [harness.sessionHost.prestart(phone.signal), harness.sessionHost.prestart(web.signal)];
    await vi.waitFor(() => expect(census.runnerPreloads - preloadsBefore).toBe(1), { timeout: 60_000 });
    expect(census.hostLaunches - launchesBefore).toBe(1);

    // The Session created after the intent runs in the prestarted host: no second launch, no second preload.
    const a = await harness.spawnSession('prestarted-a');
    expect(a.result).toMatchObject({ type: 'success', sessionId: 'prestarted-a' });
    expect(census.hostLaunches - launchesBefore).toBe(1);
    expect(census.runnerPreloads - preloadsBefore).toBe(1);

    // The intents end (New Session closed) while the Session runs: the host stays for it.
    phone.abort();
    web.abort();
    await Promise.all(held);
    const host = harness.hosts.at(-1)!;
    expect(host.exit).not.toHaveBeenCalled();
    // Its last Session ends: the host's ordinary idle end.
    harness.releaseAll();
    await host.host.whenEnded;
    expect(host.exit).toHaveBeenCalledWith(0);
  });

  it('lets a prestarted host end when the intent ends with no Session, and starts a new host for the next Session', { timeout: 120_000 }, async () => {
    const launchesBefore = census.hostLaunches;
    const harness = await createHarness();
    const intent = new AbortController();
    const held = harness.sessionHost.prestart(intent.signal);
    await vi.waitFor(() => expect(harness.hosts).toHaveLength(1), { timeout: 60_000 });
    const prestarted = harness.hosts[0]!;
    intent.abort();
    await held;
    await prestarted.host.whenEnded;
    expect(prestarted.exit).toHaveBeenCalledWith(0);

    const b = await harness.spawnSession('after-abandoned-intent');
    expect(b.result).toMatchObject({ type: 'success', sessionId: 'after-abandoned-intent' });
    expect(census.hostLaunches - launchesBefore).toBe(2);
    harness.releaseAll();
    await b.record.hostedSession!.observed;
  });

  it('ends an idle prestarted host when the intent disconnects during daemon admission', { timeout: 120_000 }, async () => {
    let admissionStarted!: () => void;
    const started = new Promise<void>(resolve => { admissionStarted = resolve; });
    let finishAdmission!: () => void;
    const admitted = new Promise<void>(resolve => { finishAdmission = resolve; });
    const harness = await createHarness(undefined, async () => {
      admissionStarted();
      await admitted;
      return captureProcessBirthWitness(process.pid);
    });
    const intent = new AbortController();
    const held = harness.sessionHost.prestart(intent.signal);
    await started;
    expect(hostSockets.size).toBe(1);
    const serverSocket = [...hostSockets][0]!;
    const serverClosed = once(serverSocket, 'close');
    intent.abort();
    await held;
    await serverClosed;
    expect(serverSocket.destroyed).toBe(true);
    finishAdmission();
    await harness.hosts[0]!.host.whenEnded;
    expect(harness.hosts[0]!.exit).toHaveBeenCalledWith(0);
  });

  it('ends an idle prestarted host when its daemon goes away (the hold connection breaks)', { timeout: 120_000 }, async () => {
    const harness = await createHarness();
    const intent = new AbortController();
    void harness.sessionHost.prestart(intent.signal);
    await vi.waitFor(() => expect(harness.hosts).toHaveLength(1), { timeout: 60_000 });
    // Wait for the hold to be admitted before the daemon "dies".
    await vi.waitFor(() => expect(hostSockets.size).toBeGreaterThan(0), { timeout: 60_000 });
    for (const socket of hostSockets) socket.destroy();
    await harness.hosts[0]!.host.whenEnded;
    expect(harness.hosts[0]!.exit).toHaveBeenCalledWith(0);
    intent.abort();
  });
});
