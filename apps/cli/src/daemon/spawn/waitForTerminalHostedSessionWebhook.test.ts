import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { configuration } from '@/configuration';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { TrackedSession } from '../types';
import { listSessionMarkers, writeSessionMarker } from '../sessionRegistry';
import { createOnChildExited } from '../sessions/onChildExited';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { waitForTerminalHostedSessionWebhook } from './waitForTerminalHostedSessionWebhook';
import { mintSessionTrackingKey, trackedSessionForSingleSessionProcess, trackedSessionsForProcess, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// Hosted startup mints its Session key; these tests address it through its host pid.
const markersForProcess = async (pid: number) => (await listSessionMarkers()).filter(marker => marker.pid === pid);
const settleAll = (resolvers: ReadonlyMap<SessionTrackingKey, (result: SpawnSessionResult) => void>, result: SpawnSessionResult) => {
  for (const resolve of [...resolvers.values()]) resolve(result);
};

describe('terminal hosted startup custody', () => {
  it('preserves a webhook timeout when the tracked PID now belongs to another Session', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS', '25');
    const pid = 4833;
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const resolvers = new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const spawnCleanups = new Map<SessionTrackingKey, () => void | Promise<void>>();
    const attachCleanups = new Map<SessionTrackingKey, () => Promise<void>>();
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture', hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByKey: spawnCleanups,
      getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {}, sessionAttachCleanupByKey: attachCleanups,
      // Persistent marker storage is the external boundary; startup orchestration stays real.
      persistAcceptedSpawnMarker: async () => {},
    });
    const exit = createOnChildExited({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: spawnCleanups,
      sessionAttachCleanupByKey: attachCleanups, getApiMachineForSessions: () => null });
    const started = waitForTerminalHostedSessionWebhook({ pid, label: 'herdr', normalizedExistingSessionId: '',
      trackedSpawnOptions: { directory: os.tmpdir() }, effectiveResume: '', directoryCreated: false,
      trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters, spawnResultResolverByKey: resolvers, spawnWebhookTimeoutByKey: timeouts,
      onChildExited: exit, spawnLifecycleCallbacks: callbacks, cleanupSpawnResources: async () => {}, cancelOwnedHost: async () => true,
      bindCanonicalSession: async () => {}, logDebug: () => {}, warn: () => {} });
    try {
      await vi.advanceTimersByTimeAsync(0);
      // Another Session now owns the tracked pid: the startup Session is gone.
      const original = trackedSessionForSingleSessionProcess(sessions, pid)!;
      sessions.delete(original.trackingKey);
      const replacement: TrackedSession = { startedBy: 'daemon', trackingKey: mintSessionTrackingKey(), pid, happySessionId: 'replacement-session' };
      sessions.set(replacement.trackingKey, replacement);
      await vi.advanceTimersByTimeAsync(25);
      await expect(started).resolves.toMatchObject({
        type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });
      expect(trackedSessionForSingleSessionProcess(sessions, pid)).toBe(replacement);
      expect(replacement.sessionWebhookTimedOutAtMs).toBeUndefined();
    } finally {
      settleAll(resolvers, { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'Fixture cleanup' });
      await Promise.allSettled([started]);
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it.each([false, true])('settles an actual early exit immediately and retires a held accepted marker after its commit (first report after exit %s)', async (firstReportAfterExit) => {
    const previousHome = configuration.happyHomeDir;
    const home = await mkdtemp(path.join(os.tmpdir(), 'happier-hosted-acceptance-'));
    Object.defineProperty(configuration, 'happyHomeDir', { value: home });
    const pid = 4831;
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const resolvers = new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const spawnCleanups = new Map<SessionTrackingKey, () => void | Promise<void>>();
    const attachCleanups = new Map<SessionTrackingKey, () => Promise<void>>();
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture', hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByKey: spawnCleanups,
      getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {}, sessionAttachCleanupByKey: attachCleanups,
      persistAcceptedSpawnMarker: async (tracked) => {
        await commit;
        await writeSessionMarker({ trackingKey: tracked.trackingKey, pid: tracked.pid, happySessionId: tracked.happySessionId ?? `PID-${pid}`, startedBy: 'daemon' });
      },
    });
    const exit = createOnChildExited({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: spawnCleanups,
      sessionAttachCleanupByKey: attachCleanups, getApiMachineForSessions: () => null });
    const started = waitForTerminalHostedSessionWebhook({ pid, label: 'herdr', normalizedExistingSessionId: '',
      trackedSpawnOptions: { directory: home }, effectiveResume: '', directoryCreated: false,
      trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters, spawnResultResolverByKey: resolvers, spawnWebhookTimeoutByKey: timeouts,
      onChildExited: exit, spawnLifecycleCallbacks: callbacks, cleanupSpawnResources: async () => {}, cancelOwnedHost: async () => true,
      bindCanonicalSession: async () => {}, logDebug: () => {}, warn: () => {} });
    let result: SpawnSessionResult | undefined;
    void started.then((value) => { result = value; });
    let exiting: Promise<void> | undefined;
    try {
      exiting = exit(pid, { reason: 'process-exited-before-webhook', code: 1, signal: null });
      if (firstReportAfterExit) {
        const report = createOnHappySessionWebhook({ trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters });
        await expect(report(`PID-${pid}`, { path: home, host: 'fixture', homeDir: home, happyHomeDir: home,
          happyLibDir: home, happyToolsDir: home, hostPid: pid, startedBy: 'daemon', machineId: 'fixture-machine' })).rejects.toThrow('retiring');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The existing resolver is settled before the delayed filesystem commit;
      // physical retirement itself still waits for accepted-marker ownership.
      expect(resolvers.size).toBe(0);
      releaseCommit();
      await exiting;
      await started;
      expect(result).toMatchObject({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
      expect(trackedSessionsForProcess(sessions, pid)).toEqual([]);
      expect(await markersForProcess(pid)).toEqual([]);
    } finally {
      releaseCommit();
      settleAll(resolvers, { type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'Fixture cleanup' });
      await Promise.allSettled([started, ...(exiting ? [exiting] : [])]);
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      Object.defineProperty(configuration, 'happyHomeDir', { value: previousHome });
      await rm(home, { recursive: true, force: true });
    }
  });
  it('orders a real filesystem binding commit before actual-exit attachment cleanup', async () => {
    const previousHome = configuration.happyHomeDir;
    const home = await mkdtemp(path.join(os.tmpdir(), 'happier-hosted-binding-'));
    Object.defineProperty(configuration, 'happyHomeDir', { value: home });
    const pid = 4832;
    const bindingPath = path.join(home, 'owned-attachment');
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const resolvers = new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const spawnCleanups = new Map<SessionTrackingKey, () => void | Promise<void>>();
    const attachCleanups = new Map<SessionTrackingKey, () => Promise<void>>();
    let pendingAttachmentCleanup: (() => Promise<void>) | null = async () => { await unlink(bindingPath); };
    let releaseBinding!: () => void;
    const bindingGate = new Promise<void>((resolve) => { releaseBinding = resolve; });
    let bindingEntered = false;
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture', hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByKey: spawnCleanups,
      getSessionAttachCleanup: () => pendingAttachmentCleanup, setSessionAttachCleanup: (cleanup) => { pendingAttachmentCleanup = cleanup; }, sessionAttachCleanupByKey: attachCleanups,
      persistAcceptedSpawnMarker: async (tracked) => { await writeSessionMarker({ trackingKey: tracked.trackingKey, pid: tracked.pid, happySessionId: tracked.happySessionId ?? `PID-${pid}`, startedBy: 'daemon' }); },
    });
    const exit = createOnChildExited({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: spawnCleanups,
      sessionAttachCleanupByKey: attachCleanups, getApiMachineForSessions: () => null });
    const started = waitForTerminalHostedSessionWebhook({ pid, label: 'herdr', normalizedExistingSessionId: '',
      trackedSpawnOptions: { directory: home }, effectiveResume: '', directoryCreated: false,
      trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters, spawnResultResolverByKey: resolvers, spawnWebhookTimeoutByKey: timeouts,
      onChildExited: exit, spawnLifecycleCallbacks: callbacks, cleanupSpawnResources: async () => {}, cancelOwnedHost: async () => true,
      bindCanonicalSession: async () => { bindingEntered = true; await bindingGate; await writeFile(bindingPath, 'owned'); },
      logDebug: () => {}, warn: () => {} });
    const report = createOnHappySessionWebhook({ trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters,
      readProcessIdentityByPidFn: async () => null, findHappyProcessByPidFn: async () => null });
    const reporting = report('session-held-binding', { path: home, host: 'fixture', homeDir: home, happyHomeDir: home,
      happyLibDir: home, happyToolsDir: home, hostPid: pid, startedBy: 'daemon', machineId: 'fixture-machine' });
    let exiting: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(bindingEntered).toBe(true));
      exiting = exit(pid, { reason: 'process-exited', code: 1, signal: null });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resolvers.size).toBe(0);
      releaseBinding();
      await Promise.all([exiting, reporting]);
      await expect(started).resolves.toMatchObject({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
      expect(trackedSessionsForProcess(sessions, pid)).toEqual([]);
      await expect(access(bindingPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await markersForProcess(pid)).toEqual([]);
    } finally {
      releaseBinding();
      settleAll(resolvers, { type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'Fixture cleanup' });
      await Promise.allSettled([started, reporting, ...(exiting ? [exiting] : [])]);
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      Object.defineProperty(configuration, 'happyHomeDir', { value: previousHome });
      await rm(home, { recursive: true, force: true });
    }
  });
});
