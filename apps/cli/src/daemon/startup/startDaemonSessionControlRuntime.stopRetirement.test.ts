import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionMetadataTuplePatchV1Schema, StopSessionResultSchema } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand, writeSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';
import { resolveRequesterSessionBootstrapFromCustody } from '../sessionEncryption/requesterSessionCredentials';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
// Home HTTP is external; control HTTP, Stop, metadata authority, serialization,
// currentness and lifecycle retirement remain real.
afterEach(() => vi.restoreAllMocks());

it.each([
  { stopped: false, pendingDemand: true }, { stopped: true, pendingDemand: true },
  { stopped: false, pendingDemand: false },
])('rejoins the exact planned runner restart only for current Pending (Stop: $stopped; demand: $pendingDemand)', async ({ stopped, pendingDemand }) => {
  await withConfiguredDaemonTestHome({ prefix: 'planned-restart-input-' }, async ({ homeDir }) => {
    const credentials = { token: 'fixture-owner', encryption: null } satisfies StoredCredentials;
    const custody = createDaemonSessionMutationCustody({ credentials });
    // Home is external; the exact planned launcher remains in custody. Only
    // the canonical persisted Stop owner may decide whether new input rejoins it.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions/planned-session') return { status: 200, data: { session: createSessionRecordFixture({
        id: 'planned-session', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: homeDir,
          ...(stopped ? { sessionExplicitStopV1: { v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 2 } } : {}) }),
      }) } };
      if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`No additional launch preparation: ${path}`);
    });
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(111), pid: 111, happySessionId: 'planned-session', startedBy: 'daemon',
      spawnOptions: { directory: homeDir } };
    const runtime = await startDaemonSessionControlRuntime({
      machineId: 'machine', serverId: configuration.activeServerId, serverBaseUrl: configuration.apiServerUrl,
      credentials, api: {} as never,
      daemonSessionMutationCustody: custody,
      connectedServicesMaterializationBaseDir: join(homeDir, 'connected-services'),
      getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
      spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => null,
      spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
      connectedServicesRestartRequestedSessions: new Set([tracked.trackingKey]),
      startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
      beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
    });
    try {
      const result = await runtime.spawnSessionForInternalResume({ directory: homeDir, existingSessionId: 'planned-session',
        executionAuthorization: { provenance: 'user_request', requestId: 'retained-pending', requestedAt: 1 } },
        pendingDemand ? { requestId: 'retained-pending', requestedAt: 1 } : undefined);
      expect(result).toMatchObject(stopped ? { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' }
        : pendingDemand ? { type: 'success', sessionId: 'planned-session' } : { type: 'error' });
    } finally { await runtime.stopControlServer(); await custody.close(); }
  });
});

it.each(['owner', 'explicit-owner', 'explicit-intent-refused', 'foreign-account', 'other-home', 'other-machine'] as const)('retires a stopped %s runner using only its own Account authority', async wiring => {
  await withConfiguredDaemonTestHome({ prefix: 'stop-retirement-' }, async ({ homeDir }) => {
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const credentials = { token: 'fixture-owner', encryption: null } satisfies StoredCredentials;
    const daemonSessionMutationCustody = createDaemonSessionMutationCustody({ credentials });
    let releaseProfile!: () => void;
    const blockedProfile = new Promise<void>(resolve => { releaseProfile = resolve; });
    let raw: ReturnType<typeof createSessionRecordFixture> | undefined;
    const reads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path.endsWith('/account/profile')) {
        await blockedProfile;
        throw new Error('Requester runtime bootstrap remains unavailable');
      }
      if (path.includes('/v2/sessions/') && raw) return { status: 200, data: { session: raw } };
      if (path.endsWith('/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected Home read ${path}`);
    });
    let retired = false;
    let explicitIntent = false;
    vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
      if (wiring === 'explicit-intent-refused') throw Object.assign(new Error('Home refused Stop intent'), { response: { status: 403 } });
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (!explicitIntent && wiring === 'explicit-owner') {
        expect(patch).toMatchObject({ mode: 'owner_migration', target: {
          ownerMetadata: { t: 'plain', v: { runtime: { sessionExplicitStopV1: { cause: 'explicit_stop' } } } } } });
        explicitIntent = true;
      } else {
        expect(patch).toMatchObject({ mode: 'owner_migration', target: {
          ownerMetadata: { t: 'plain', v: { runtime: { terminal: { controlServiceabilityV1: { retired: true } } } } } } });
        retired = true;
      }
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 2 }, agentState: { version: 0 } } };
    });
    const runtime = await startDaemonSessionControlRuntime({
      machineId: 'machine', serverId: configuration.activeServerId, serverBaseUrl: configuration.apiServerUrl,
      externalActionAccountId: 'owner', credentials, api: {} as never,
      daemonSessionMutationCustody,
      connectedServicesMaterializationBaseDir: join(homeDir, 'connected-services'),
      getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
      trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
      spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => null,
      spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
      connectedServicesRestartRequestedSessions: new Set(),
      startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
      beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {},
      resolveRequesterSessionRuntimeContext: async (sessionId, attribution) => {
        await resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: homeDir, sessionId,
          serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.apiServerUrl,
          expectedAttribution: attribution, legacyOwnerCredentials: credentials,
          machineAdmissionBoundary: { machineId: 'machine', daemonToken: credentials.token,
            isHomeCurrent: () => true, readInstallation: () => ({ installationId: 'installation', privateKey: new Uint8Array(64) }) } });
        return null;
      },
      releaseRequesterSessionRuntimeContext: async context => { await context.dispose(); },
      processEnv: { HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: '0' },
    });
    const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    let stopping: ReturnType<typeof runtime.stopSession> | undefined;
    try {
      await once(child, 'message');
      const pid = child.pid!;
      const identity = await readProcessIdentityByPid(pid);
      if (!identity) throw new Error('Missing process fixture identity');
      const sessionId = 'stop-own-account';
      raw = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ machineId: 'machine', path: homeDir, hostPid: pid,
          hostProcessStartTimeMs: identity.processStartTimeMs, terminal: { mode: 'plain', controlServiceabilityV1: {
            v: 1, attachmentId: 'departed-runner', state: 'servable', observedAt: 1 } } }) });
      const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, childProcess: child, happySessionId: sessionId, startedBy: 'daemon',
        processStartTimeMs: identity.processStartTimeMs, processCommandHash: hashProcessCommand(identity.command),
        requesterWorkAttributionV1: { accountId: wiring === 'foreign-account' ? 'foreign' : 'owner',
          serverId: wiring === 'other-home' ? 'foreign-home' : configuration.activeServerId,
          machineId: wiring === 'other-machine' ? 'foreign-machine' : 'machine',
          installationId: 'installation' }, spawnOptions: { directory: homeDir } };
      sessions.set(tracked.trackingKey, tracked);
      await writeSessionMarker({ trackingKey: tracked.trackingKey, pid, happySessionId: sessionId, startedBy: 'daemon',
        processStartTimeMs: identity.processStartTimeMs, processCommandHash: hashProcessCommand(identity.command) });
      const explicit = wiring === 'explicit-owner' || wiring === 'explicit-intent-refused';
      if (!explicit) {
        child.kill('SIGTERM');
        await exited;
      }
      let receipt: Awaited<ReturnType<typeof runtime.stopSession>> | undefined;
      const started = Date.now();
      stopping = (explicit ? fetch(`http://127.0.0.1:${runtime.controlPort}/stop-session`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-happier-daemon-token': runtime.controlToken },
        body: JSON.stringify({ sessionId }),
      }).then(async response => StopSessionResultSchema.parse(await response.json())) : runtime.stopSession(sessionId))
        .then(result => { receipt = result; return result; });
      void stopping.catch(() => {});
      if (wiring !== 'owner' && !explicit) releaseProfile();
      await vi.waitFor(() => expect(receipt).toEqual(wiring === 'explicit-intent-refused'
        ? { status: 'incomplete', reason: 'explicit_stop_failed' } : { status: 'stopped' }), { timeout: 5000 });
      expect(retired).toBe(wiring === 'owner' || wiring === 'explicit-owner');
      expect(explicitIntent).toBe(wiring === 'explicit-owner');
      if (wiring === 'owner' || explicit) expect(reads.some(path => path.endsWith('/account/profile'))).toBe(false);
      expect(sessions.size).toBe(wiring === 'explicit-intent-refused' ? 1 : 0);
      if (wiring === 'explicit-intent-refused') expect(child.exitCode === null && child.signalCode === null).toBe(true);
      console.info('[FIX64] physical Stop and Home retirement', { wiring, elapsedMs: Date.now() - started, reads });
    } finally {
      releaseProfile();
      await stopping?.catch(() => {});
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      sessions.clear();
      await runtime.stopControlServer();
      await daemonSessionMutationCustody.close();
    }
  });
});
