import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { configuration } from '@/configuration';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { TrackedSession } from '../types';
import { readSessionMarkerForPid, writeSessionMarker } from '../sessionRegistry';
import { createOnChildExited } from '../sessions/onChildExited';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { waitForTerminalHostedSessionWebhook } from './waitForTerminalHostedSessionWebhook';

describe('terminal hosted startup custody', () => {
  it('preserves a webhook timeout when the tracked PID now belongs to another Session', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS', '25');
    const pid = 4833;
    const sessions = new Map<number, TrackedSession>();
    const awaiters = new Map<number, (session: TrackedSession) => void>();
    const resolvers = new Map<number, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<number, NodeJS.Timeout>();
    const spawnCleanups = new Map<number, () => void | Promise<void>>();
    const attachCleanups = new Map<number, () => Promise<void>>();
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture', hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByPid: spawnCleanups,
      getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {}, sessionAttachCleanupByPid: attachCleanups,
      // Persistent marker storage is the external boundary; startup orchestration stays real.
      persistAcceptedSpawnMarker: async () => {},
    });
    const exit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: spawnCleanups,
      sessionAttachCleanupByPid: attachCleanups, getApiMachineForSessions: () => null });
    const started = waitForTerminalHostedSessionWebhook({ pid, label: 'herdr', normalizedExistingSessionId: '',
      trackedSpawnOptions: { directory: os.tmpdir() }, effectiveResume: '', directoryCreated: false,
      pidToTrackedSession: sessions, pidToAwaiter: awaiters, pidToSpawnResultResolver: resolvers, pidToSpawnWebhookTimeout: timeouts,
      onChildExited: exit, spawnLifecycleCallbacks: callbacks, cleanupSpawnResources: async () => {}, cancelOwnedHost: async () => true,
      bindCanonicalSession: async () => {}, logDebug: () => {}, warn: () => {} });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const replacement: TrackedSession = { startedBy: 'daemon', pid, happySessionId: 'replacement-session' };
      sessions.set(pid, replacement);
      await vi.advanceTimersByTimeAsync(25);
      await expect(started).resolves.toMatchObject({
        type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });
      expect(sessions.get(pid)).toBe(replacement);
      expect(replacement.sessionWebhookTimedOutAtMs).toBeUndefined();
    } finally {
      resolvers.get(pid)?.({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'Fixture cleanup' });
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
    const sessions = new Map<number, TrackedSession>();
    const awaiters = new Map<number, (session: TrackedSession) => void>();
    const resolvers = new Map<number, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<number, NodeJS.Timeout>();
    const spawnCleanups = new Map<number, () => void | Promise<void>>();
    const attachCleanups = new Map<number, () => Promise<void>>();
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture', hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByPid: spawnCleanups,
      getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {}, sessionAttachCleanupByPid: attachCleanups,
      persistAcceptedSpawnMarker: async (tracked) => {
        await commit;
        await writeSessionMarker({ pid: tracked.pid, happySessionId: tracked.happySessionId ?? `PID-${pid}`, startedBy: 'daemon' });
      },
    });
    const exit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: spawnCleanups,
      sessionAttachCleanupByPid: attachCleanups, getApiMachineForSessions: () => null });
    const started = waitForTerminalHostedSessionWebhook({ pid, label: 'herdr', normalizedExistingSessionId: '',
      trackedSpawnOptions: { directory: home }, effectiveResume: '', directoryCreated: false,
      pidToTrackedSession: sessions, pidToAwaiter: awaiters, pidToSpawnResultResolver: resolvers, pidToSpawnWebhookTimeout: timeouts,
      onChildExited: exit, spawnLifecycleCallbacks: callbacks, cleanupSpawnResources: async () => {}, cancelOwnedHost: async () => true,
      bindCanonicalSession: async () => {}, logDebug: () => {}, warn: () => {} });
    let result: SpawnSessionResult | undefined;
    void started.then((value) => { result = value; });
    let exiting: Promise<void> | undefined;
    try {
      exiting = exit(pid, { reason: 'process-exited-before-webhook', code: 1, signal: null });
      if (firstReportAfterExit) {
        const report = createOnHappySessionWebhook({ pidToTrackedSession: sessions, pidToAwaiter: awaiters });
        await expect(report(`PID-${pid}`, { path: home, host: 'fixture', homeDir: home, happyHomeDir: home,
          happyLibDir: home, happyToolsDir: home, hostPid: pid, startedBy: 'daemon', machineId: 'fixture-machine' })).rejects.toThrow('retiring');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The existing resolver is settled before the delayed filesystem commit;
      // physical retirement itself still waits for accepted-marker ownership.
      expect(resolvers.has(pid)).toBe(false);
      releaseCommit();
      await exiting;
      await started;
      expect(result).toMatchObject({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
      expect(sessions.has(pid)).toBe(false);
      expect(await readSessionMarkerForPid(pid)).toBeNull();
    } finally {
      releaseCommit();
      resolvers.get(pid)?.({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'Fixture cleanup' });
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
    const sessions = new Map<number, TrackedSession>();
    const awaiters = new Map<number, (session: TrackedSession) => void>();
    const resolvers = new Map<number, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<number, NodeJS.Timeout>();
    const spawnCleanups = new Map<number, () => void | Promise<void>>();
    const attachCleanups = new Map<number, () => Promise<void>>();
    let pendingAttachmentCleanup: (() => Promise<void>) | null = async () => { await unlink(bindingPath); };
    let releaseBinding!: () => void;
    const bindingGate = new Promise<void>((resolve) => { releaseBinding = resolve; });
    let bindingEntered = false;
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture', hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByPid: spawnCleanups,
      getSessionAttachCleanup: () => pendingAttachmentCleanup, setSessionAttachCleanup: (cleanup) => { pendingAttachmentCleanup = cleanup; }, sessionAttachCleanupByPid: attachCleanups,
      persistAcceptedSpawnMarker: async (tracked) => { await writeSessionMarker({ pid: tracked.pid, happySessionId: tracked.happySessionId ?? `PID-${pid}`, startedBy: 'daemon' }); },
    });
    const exit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: spawnCleanups,
      sessionAttachCleanupByPid: attachCleanups, getApiMachineForSessions: () => null });
    const started = waitForTerminalHostedSessionWebhook({ pid, label: 'herdr', normalizedExistingSessionId: '',
      trackedSpawnOptions: { directory: home }, effectiveResume: '', directoryCreated: false,
      pidToTrackedSession: sessions, pidToAwaiter: awaiters, pidToSpawnResultResolver: resolvers, pidToSpawnWebhookTimeout: timeouts,
      onChildExited: exit, spawnLifecycleCallbacks: callbacks, cleanupSpawnResources: async () => {}, cancelOwnedHost: async () => true,
      bindCanonicalSession: async () => { bindingEntered = true; await bindingGate; await writeFile(bindingPath, 'owned'); },
      logDebug: () => {}, warn: () => {} });
    const report = createOnHappySessionWebhook({ pidToTrackedSession: sessions, pidToAwaiter: awaiters,
      readProcessIdentityByPidFn: async () => null, findHappyProcessByPidFn: async () => null });
    const reporting = report('session-held-binding', { path: home, host: 'fixture', homeDir: home, happyHomeDir: home,
      happyLibDir: home, happyToolsDir: home, hostPid: pid, startedBy: 'daemon', machineId: 'fixture-machine' });
    let exiting: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(bindingEntered).toBe(true));
      exiting = exit(pid, { reason: 'process-exited', code: 1, signal: null });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resolvers.has(pid)).toBe(false);
      releaseBinding();
      await Promise.all([exiting, reporting]);
      await expect(started).resolves.toMatchObject({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
      expect(sessions.has(pid)).toBe(false);
      await expect(access(bindingPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readSessionMarkerForPid(pid)).toBeNull();
    } finally {
      releaseBinding();
      resolvers.get(pid)?.({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'Fixture cleanup' });
      await Promise.allSettled([started, reporting, ...(exiting ? [exiting] : [])]);
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      Object.defineProperty(configuration, 'happyHomeDir', { value: previousHome });
      await rm(home, { recursive: true, force: true });
    }
  });
});
