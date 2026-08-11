import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceAuthGroupPolicyV1Schema,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import { prepareIsolatedDaemonTestHome, type PreparedDaemonTestHome } from '@/daemon/testkit/realIntegration.testkit';
import { removeSessionMarker, writeSessionMarker } from '@/daemon/sessionRegistry';
import {
  ConnectedServiceSessionAuthSwitchLockRegistry,
  createConnectedServiceSessionAuthSwitchCore,
} from '@/daemon/connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { createSessionConnectedServiceAuthHotApply } from '@/daemon/connectedServices/sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import { switchSessionConnectedServiceAuth } from '@/daemon/connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { getBrokerBridgeEffectiveSelectionForTest } from '@/daemon/connectedServices/broker/brokerBridgeEffectiveSelectionRegistry';
import { waitForCondition } from '@/testkit/async/waitFor';
import { spawnDetachedInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';

import { createOpenCodeConnectedServiceRuntimeAuthAdapter } from '../connectedServices/createOpenCodeConnectedServiceRuntimeAuthAdapter';
import { setOpenCodeConnectedServiceInFlightTurnProvider } from '@/daemon/connectedServices/sessionAuthSwitch/openCodeConnectedServiceInFlightTurnRegistry';
import { startManagedOpenCodeServer } from './openCodeManagedServer';
import { resolveOpenCodeManagedServerLaunchFingerprint } from './openCodeManagedServerEnv';
import {
  ensureSharedManagedOpenCodeServerBaseUrl,
  isLoopbackManagedOpenCodeBaseUrl,
  type SharedManagedOpenCodeServerState,
} from './sharedManagedServer';
import { getOpenCodeServerProcessInfoBestEffort, isOpenCodeServerPidAlive } from './openCodeServerProcessState';

type StartedManagedServer = Awaited<ReturnType<typeof startManagedOpenCodeServer>>;

function hashCommandLine(rawCommandLine: string): string {
  return createHash('sha256').update(rawCommandLine).digest('hex');
}

function readProcessStartTimeMsBestEffort(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(Math.floor(pid))],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    )
      .trim();
    if (!output) return null;
    const line = output.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? '';
    if (!line) return null;
    const parsed = Date.parse(line);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function currentManagedServerDirs(): Readonly<{
  managedServersDir: string;
  currentStatePath: string;
}> {
  return {
    managedServersDir: join(configuration.happyHomeDir, 'opencode', 'managed-servers'),
    currentStatePath: join(configuration.happyHomeDir, 'opencode', 'current-managed-server.json'),
  };
}

async function writeManagedState(statePath: string, state: SharedManagedOpenCodeServerState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state), 'utf8');
}

async function readManagedState(statePath: string): Promise<SharedManagedOpenCodeServerState | null> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as SharedManagedOpenCodeServerState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function killPidBestEffort(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }
}

async function buildTrustedManagedState(params: Readonly<{
  launchFingerprint: string;
  ownerToken: string;
  server: StartedManagedServer;
}>): Promise<SharedManagedOpenCodeServerState> {
  const processInfo = getOpenCodeServerProcessInfoBestEffort(params.server.pid);
  if (!processInfo?.cmd) {
    throw new Error(`Missing process command line for PID ${params.server.pid}`);
  }
  const observedStartTimeMs = readProcessStartTimeMsBestEffort(params.server.pid);
  if (!Number.isFinite(observedStartTimeMs) || observedStartTimeMs === null || observedStartTimeMs <= 0) {
    throw new Error(`Missing process start time for PID ${params.server.pid}`);
  }
  return {
    v: 2,
    baseUrl: params.server.baseUrl,
    pid: params.server.pid,
    startedAtMs: Date.now(),
    status: 'ready',
    launchEnvFingerprint: params.launchFingerprint,
    ownerToken: params.ownerToken,
    startTimeMs: Math.floor(observedStartTimeMs),
    expectedCmdlineHash: hashCommandLine(processInfo.cmd),
    activeServerDir: configuration.activeServerDir,
    daemonInstanceId: configuration.activeServerId,
  };
}

async function createFakeOpenCodeBinary(scriptPath: string): Promise<void> {
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
const http = require('http');

function parseArg(name) {
  const prefix = name + '=';
  const raw = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(prefix)) || '';
  return raw.slice(prefix.length);
}

const hostname = parseArg('--hostname') || '127.0.0.1';
const port = Number(parseArg('--port') || '0');
if (!Number.isFinite(port) || port <= 0) {
  console.error('missing --port');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/global/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ healthy: true, version: 'fake-opencode' }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, hostname);
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1 << 30);
`,
    'utf8',
  );
  await chmod(scriptPath, 0o755);
}

async function createFakeBinDir(): Promise<string> {
  const dir = join(tmpdir(), `happier-opencode-fake-bin-${randomUUID()}`);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
  return dir;
}

async function startManagedServerResources(params: Readonly<{
  managedServersDir: string;
}>): Promise<Readonly<{
  currentServer: StartedManagedServer;
  orphanServer: StartedManagedServer;
  orphanStatePath: string;
  currentStatePath: string;
  ownerToken: string;
  orphanFingerprint: string;
}>> {
  const currentServer = await startManagedOpenCodeServer({ timeoutMs: 5_000 });
  const orphanServer = await startManagedOpenCodeServer({ timeoutMs: 5_000 });
  const ownerToken = `owner-${randomUUID()}`;
  const orphanFingerprint = `orphan-${randomUUID()}`;
  const orphanStatePath = join(params.managedServersDir, `${orphanFingerprint}.json`);
  const currentStatePath = join(configuration.happyHomeDir, 'opencode', 'current-managed-server.json');
  return {
    currentServer,
    orphanServer,
    orphanStatePath,
    currentStatePath,
    ownerToken,
    orphanFingerprint,
  };
}

describe('OpenCode auth-switch fake-provider e2e', () => {
  let preparedHome: PreparedDaemonTestHome | null = null;
  const startedServers: StartedManagedServer[] = [];
  const markerPids: number[] = [];
  let fakeBinDir: string | null = null;

  afterEach(async () => {
    setOpenCodeConnectedServiceInFlightTurnProvider(null);
    for (const markerPid of markerPids.splice(0)) {
      await removeSessionMarker(markerPid).catch(() => {});
      killPidBestEffort(markerPid);
      await waitForProcessExit(markerPid, { timeoutMs: 5_000 }).catch(() => false);
    }

    while (startedServers.length > 0) {
      const server = startedServers.pop();
      await server?.close().catch(() => {});
    }

    await preparedHome?.restore().catch(() => {});
    preparedHome = null;

    if (fakeBinDir) {
      await rm(fakeBinDir, { recursive: true, force: true }).catch(() => {});
      fakeBinDir = null;
    }
  });

  it('keeps tracked orphan fingerprints on startup scan and reaps them once no tracked claim remains', async () => {
    const localFakeBinDir = await createFakeBinDir();
    fakeBinDir = localFakeBinDir;
    const fakeOpenCodePath = join(localFakeBinDir, 'opencode');
    await createFakeOpenCodeBinary(fakeOpenCodePath);

    const homePreview = await prepareIsolatedDaemonTestHome({
      prefix: 'happier-opencode-auth-switch-startup-scan-',
      extraEnv: ({ homeDir }) => ({
        HAPPIER_OPENCODE_PATH: fakeOpenCodePath,
        HAPPIER_OPENCODE_SERVER_STATE_PATH: join(homeDir, 'opencode', 'current-managed-server.json'),
        HAPPIER_OPENCODE_AUTH_SWITCH_DRAIN_MS: '200',
      }),
    });
    preparedHome = homePreview;

    const { managedServersDir, currentStatePath } = currentManagedServerDirs();
    await mkdir(managedServersDir, { recursive: true });
    const { currentServer, orphanServer, orphanStatePath, ownerToken, orphanFingerprint } = await startManagedServerResources({
      managedServersDir,
    });
    startedServers.push(currentServer, orphanServer);

    const currentLaunchFingerprint = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: process.env,
      xdgRootDir: null,
      isolateConfig: false,
    });

    const currentState = await buildTrustedManagedState({
      launchFingerprint: currentLaunchFingerprint,
      ownerToken: `owner-${randomUUID()}`,
      server: currentServer,
    });
    await writeManagedState(currentStatePath, currentState);

    const orphanState = await buildTrustedManagedState({
      launchFingerprint: orphanFingerprint,
      ownerToken,
      server: orphanServer,
    });
    await writeManagedState(orphanStatePath, orphanState);

    const marker = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)', {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const markerPid = marker.pid ?? -1;
    expect(markerPid).toBeGreaterThan(0);
    markerPids.push(markerPid);
    await writeSessionMarker({
      pid: markerPid,
      happySessionId: `tracked-opencode-${markerPid}`,
      startedBy: 'daemon',
      metadata: {
        flavor: 'opencode',
        opencodeManagedServerLaunchFingerprint: orphanFingerprint,
      },
    });

    const probeHealth = async (baseUrl: string): Promise<boolean> => {
      const response = await fetch(new URL('/global/health', baseUrl).toString(), {
        signal: AbortSignal.timeout(3_000),
      }).catch(() => null);
      return response?.ok === true;
    };

    const baseUrl = await ensureSharedManagedOpenCodeServerBaseUrl({ probeHealth });
    expect(baseUrl).toBe(currentServer.baseUrl);
    expect(isLoopbackManagedOpenCodeBaseUrl(baseUrl)).toBe(true);

    await waitForCondition(async () => {
      const state = await readManagedState(orphanStatePath);
      return state !== null && isOpenCodeServerPidAlive(orphanServer.pid);
    }, { timeoutMs: 10_000, label: 'tracked orphan server to remain alive after startup scan' });

    await removeSessionMarker(markerPid);
    killPidBestEffort(markerPid);
    await waitForProcessExit(markerPid, { timeoutMs: 5_000 }).catch(() => false);

    await ensureSharedManagedOpenCodeServerBaseUrl({ probeHealth });

    await waitForCondition(
      async () => !(await pathExists(orphanStatePath)),
      { timeoutMs: 20_000, label: 'orphan managed-server state file removal after tracked claims clear' },
    );
    await waitForCondition(
      () => !isOpenCodeServerPidAlive(orphanServer.pid),
      { timeoutMs: 20_000, label: 'orphan managed-server process exit after tracked claims clear' },
    );
  }, 120_000);

  it('preserves the shared managed server and its claim across broker-owned auth switches', async () => {
    const localFakeBinDir = await createFakeBinDir();
    fakeBinDir = localFakeBinDir;
    const fakeOpenCodePath = join(localFakeBinDir, 'opencode');
    await createFakeOpenCodeBinary(fakeOpenCodePath);

    const homePreview = await prepareIsolatedDaemonTestHome({
      prefix: 'happier-opencode-auth-switch-release-',
      extraEnv: {
        HAPPIER_OPENCODE_PATH: fakeOpenCodePath,
        HAPPIER_OPENCODE_AUTH_SWITCH_DRAIN_MS: '200',
      },
    });
    preparedHome = homePreview;

    const { managedServersDir } = currentManagedServerDirs();
    await mkdir(managedServersDir, { recursive: true });

    const orphanServer = await startManagedOpenCodeServer({ timeoutMs: 5_000 });
    startedServers.push(orphanServer);
    const launchFingerprint = `release-${randomUUID()}`;
    const ownerToken = `owner-${randomUUID()}`;
    const statePath = join(managedServersDir, `${launchFingerprint}.json`);
    const state = await buildTrustedManagedState({
      launchFingerprint,
      ownerToken,
      server: orphanServer,
    });
    await writeManagedState(statePath, state);

    const markerA = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)', {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const markerB = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)', {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const markerPidA = markerA.pid ?? -1;
    const markerPidB = markerB.pid ?? -1;
    expect(markerPidA).toBeGreaterThan(0);
    expect(markerPidB).toBeGreaterThan(0);
    markerPids.push(markerPidA, markerPidB);
    for (const pid of [markerPidA, markerPidB]) {
      await writeSessionMarker({
        pid,
        happySessionId: `tracked-release-${pid}`,
        startedBy: 'daemon',
        metadata: {
          flavor: 'opencode',
          opencodeManagedServerLaunchFingerprint: launchFingerprint,
        },
      });
    }

    const runtimeAdapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();
    const blockedResult = await runtimeAdapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode', targetId: 'fake-session' },
      selection: {
        brokerSelectionIdentity: 'opencode|connected|broker:1|openai-codex:account-a:',
        previousLaunchFingerprint: launchFingerprint,
        previousOwnerToken: ownerToken,
      },
    }) as { detached?: boolean; detachedReason?: string; recovery?: string };
    expect(blockedResult).toMatchObject({
      detached: false,
      detachedReason: 'broker_request_time_selection_preserved',
      recovery: 'provider_owned_broker_selection',
    });
    expect(await pathExists(statePath)).toBe(true);
    expect(isOpenCodeServerPidAlive(orphanServer.pid)).toBe(true);

    await removeSessionMarker(markerPidB);
    killPidBestEffort(markerPidB);
    await waitForProcessExit(markerPidB, { timeoutMs: 5_000 }).catch(() => false);

    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'main',
          profileId: 'profile-old',
        },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'tracked-release-session',
      pid: markerPidA,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        connectedServices: previousBindings,
      },
    };
    const nextRecord = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'profile-new',
      kind: 'oauth',
      oauth: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'account-b',
        providerEmail: null,
      },
    });
    const runtimeSelection = {
      serviceId: 'openai-codex',
      brokerSelectionIdentity: 'opencode|connected|broker:1|openai-codex:account-a:',
      kind: 'group',
      groupId: 'main',
      activeProfileId: 'profile-new',
      fallbackProfileId: 'profile-old',
      generation: 2,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      record: nextRecord,
      previousLaunchFingerprint: launchFingerprint,
      previousOwnerToken: ownerToken,
    };
    const hotApply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => runtimeAdapter,
    });
    const switchResult = await switchSessionConnectedServiceAuth({
      core: createConnectedServiceSessionAuthSwitchCore({
        locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
      }),
      switchReason: 'automatic_runtime_failure',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'provider composition test consumes the adapter hot-apply verification directly',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [
            { profileId: 'profile-old', status: 'connected' },
            { profileId: 'profile-new', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => ({
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          displayName: 'Main',
          policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true }),
          activeProfileId: 'profile-new',
          generation: 2,
          runtimeStateRevision: 0,
          state: { v: 1 },
          members: [
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'main',
              profileId: 'profile-old',
              priority: 1,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'main',
              profileId: 'profile-new',
              priority: 2,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        }),
      },
      materializeRuntimeAuthSelection: async () => runtimeSelection,
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: async () => {
        throw new Error('broker request-time adoption must not restart OpenCode');
      },
      hotApply,
      recoverAfterRuntimeAuthSwitch: async (input) => {
        const selection = input.runtimeAuthSelectionsByServiceId?.get('openai-codex');
        const result = await runtimeAdapter.recoverAfterRuntimeAuthSwitch({
          target: { agentId: 'opencode', targetId: 'tracked-release-session' },
          selection,
        });
        return result.recovered === true ? { ok: true } : { ok: false };
      },
      persistSessionBindings: async () => {},
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'tracked-release-session',
        agentId: 'opencode',
        bindings: previousBindings,
      },
    });
    expect(switchResult).toMatchObject({ ok: true, action: 'hot_applied' });
    expect(getBrokerBridgeEffectiveSelectionForTest({
      selectionIdentity: runtimeSelection.brokerSelectionIdentity,
      serviceId: 'openai-codex',
    })).toMatchObject({
      selectionEpoch: 1,
      selection: {
        kind: 'group',
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 2,
      },
    });
    expect(await pathExists(statePath)).toBe(true);
    expect(isOpenCodeServerPidAlive(orphanServer.pid)).toBe(true);
  }, 120_000);

  it('keeps broker-owned auth adoption independent from in-flight-turn and quiescence state', async () => {
    // Request-time broker adoption is independent from the turn boundary: neither an in-flight turn
    // nor later quiescence is authority to release the shared server or its materialized claim.
    const localFakeBinDir = await createFakeBinDir();
    fakeBinDir = localFakeBinDir;
    const fakeOpenCodePath = join(localFakeBinDir, 'opencode');
    await createFakeOpenCodeBinary(fakeOpenCodePath);

    const homePreview = await prepareIsolatedDaemonTestHome({
      prefix: 'happier-opencode-auth-switch-inflight-',
      extraEnv: {
        HAPPIER_OPENCODE_PATH: fakeOpenCodePath,
        HAPPIER_OPENCODE_AUTH_SWITCH_DRAIN_MS: '200',
      },
    });
    preparedHome = homePreview;

    const { managedServersDir } = currentManagedServerDirs();
    await mkdir(managedServersDir, { recursive: true });

    const orphanServer = await startManagedOpenCodeServer({ timeoutMs: 5_000 });
    startedServers.push(orphanServer);
    const launchFingerprint = `inflight-${randomUUID()}`;
    const ownerToken = `owner-${randomUUID()}`;
    const statePath = join(managedServersDir, `${launchFingerprint}.json`);
    const state = await buildTrustedManagedState({
      launchFingerprint,
      ownerToken,
      server: orphanServer,
    });
    await writeManagedState(statePath, state);

    // A single tracked claim represents the switching session itself.
    const marker = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)', {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const markerPid = marker.pid ?? -1;
    expect(markerPid).toBeGreaterThan(0);
    markerPids.push(markerPid);
    const happySessionId = `tracked-inflight-${markerPid}`;
    await writeSessionMarker({
      pid: markerPid,
      happySessionId,
      startedBy: 'daemon',
      metadata: {
        flavor: 'opencode',
        opencodeManagedServerLaunchFingerprint: launchFingerprint,
      },
    });

    // The session's turn is in flight.
    const turnInFlightSessionIds = new Set<string>([happySessionId]);
    setOpenCodeConnectedServiceInFlightTurnProvider((sessionId) => turnInFlightSessionIds.has(sessionId));

    const runtimeAdapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();
    const blockedResult = await runtimeAdapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode', targetId: 'fake-session' },
      selection: {
        brokerSelectionIdentity: 'opencode|connected|broker:1|openai-codex:account-a:',
        previousLaunchFingerprint: launchFingerprint,
        previousOwnerToken: ownerToken,
      },
    }) as { detached?: boolean; detachedReason?: string; recovery?: string };
    expect(blockedResult).toMatchObject({
      detached: false,
      detachedReason: 'broker_request_time_selection_preserved',
      recovery: 'provider_owned_broker_selection',
    });
    expect(await pathExists(statePath)).toBe(true);
    expect(isOpenCodeServerPidAlive(orphanServer.pid)).toBe(true);

    // Turn quiesces: request-time broker adoption still does not release the shared server.
    turnInFlightSessionIds.clear();

    const releasedResult = await runtimeAdapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode', targetId: 'fake-session' },
      selection: {
        brokerSelectionIdentity: 'opencode|connected|broker:1|openai-codex:account-a:',
        previousLaunchFingerprint: launchFingerprint,
        previousOwnerToken: ownerToken,
      },
    }) as { detached?: boolean; detachedReason?: string; recovery?: string };
    expect(releasedResult).toMatchObject({
      detached: false,
      detachedReason: 'broker_request_time_selection_preserved',
      recovery: 'provider_owned_broker_selection',
    });
    expect(await pathExists(statePath)).toBe(true);
    expect(isOpenCodeServerPidAlive(orphanServer.pid)).toBe(true);
  }, 120_000);
});
