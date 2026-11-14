import { execFileSync } from 'node:child_process';
import { captureProcessBirthWitness } from '@/daemon/processIdentity';
import { EventEmitter } from 'node:events';
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
import { SESSION_HOST_HANDOVER_EXIT_CODE } from '@/session/transport/rpc/localSessionRpcChannel';

import { createSessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import { createSparedHeldAgentCustody } from '../processSupervision/sparedHeldAgents';
import type { OwnerRemainderPort } from '../processes/endOwnerRemainder';
import { createOnChildExited } from '../sessions/onChildExited';

import { createDaemonSessionHost, createSessionHostPlacement } from './daemonSessionHost';
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

async function createHarness() {
  peerHelper.path ??= resolvePeerHelper();
  const releaseSessions: Array<() => void> = [];
  const hostedEnvironments: Array<Readonly<Record<string, string | undefined>>> = [];
  const hosts: InProcessHost[] = [];
  census.startHost = async () => {
    const hostProcess = new EventEmitter();
    // A host process that exits breaks every connection to it.
    const hostExit = vi.fn<(code: number) => void>(() => { for (const socket of hostSockets) socket.destroy(); });
    const host = await startSessionHost({
      runSessionCommand: async () => {
        hostedEnvironments.push({ ...sessionProcessEnvironment() });
        const termination = registerRunnerTerminationHandlers({ process: hostProcess, exit: hostExit, onTerminate: () => undefined });
        await Promise.race([new Promise<void>((resolve) => { releaseSessions.push(resolve); }), termination.whenTerminated]);
        termination.dispose();
      },
      readTrustedCaller: () => captureProcessBirthWitness(process.pid),
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
  const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
  const exits: Array<Readonly<{ pid: number; exit: ChildExit }>> = [];
  let observeExit: (pid: number, exit: ChildExit) => Promise<void> = async () => {};
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
    persistAcceptedSpawnMarker: async (session, options) => await persistAcceptedSpawnMarker({ trackedSession: session, deviceLocalSecretStorage, ...options }),
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
  const spawnSession = (sessionId: string, extraEnv: Record<string, string> = {}) => {
    const run = spawnQueue.then(() => spawnOneSession(sessionId, extraEnv));
    spawnQueue = run.catch(() => undefined);
    return run;
  };
  const spawnOneSession = async (sessionId: string, extraEnv: Record<string, string>) => {
    const before = new Set(tracked.keys());
    const pending = spawnRegularProcessAndWaitForWebhook({
      args: ['codex', '--started-by', 'daemon'], directory: testHome, options: { directory: testHome }, trackedSpawnOptions: { directory: testHome },
      normalizedExistingSessionId: '', effectiveResume: '', directoryCreated: false, extraEnvForChildWithMessage: extraEnv,
      processEnv: { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir },
      trackedSessionsByKey: tracked, spawnAwaiterByKey: awaiters, spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
      resolveCanonicalTrackedSessionId: trackingKey => tracked.get(trackingKey)?.happySessionId ?? '',
      onChildExited,
      spawnLifecycleCallbacks: callbacks, cleanupSpawnResources: () => {}, logDebug: () => {}, warn: () => {},
      sessionHost,
    });
    const record = await vi.waitFor(() => {
      const added = [...tracked.values()].find(session => !before.has(session.trackingKey));
      if (!added) throw new Error('Session not tracked yet');
      return added;
    }, { timeout: 60_000 });
    await record.acceptedSpawnMarkerGate;
    await report(sessionId, { hostPid: record.pid, path: testHome, startedBy: 'daemon' } as Metadata, undefined, undefined, record.trackingKey);
    await record.reportMarkerCustody?.pending;
    return { record, result: await pending };
  };
  return {
    tracked, exits, hosts, hostedEnvironments, releaseSessions, spawnSession,
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

    // Stop of A goes through the host; its end is observed for A only, never as the host's exit.
    await expect(a.record.hostedSession!.end()).resolves.toBe(true);
    await a.record.hostedSession!.observed;
    expect(harness.exits).toEqual([{ pid: process.pid, exit: expect.objectContaining({ trackingKey: a.record.trackingKey }) }]);
    expect(harness.hosts[0]!.exit).not.toHaveBeenCalled();

    harness.releaseAll();
    await b.record.hostedSession!.observed;
    expect(harness.exits.map(({ exit }) => exit.trackingKey)).toEqual([a.record.trackingKey, b.record.trackingKey]);
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
});
