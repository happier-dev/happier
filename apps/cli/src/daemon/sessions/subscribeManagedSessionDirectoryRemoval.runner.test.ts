import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand, writeSessionMarker } from '../sessionRegistry';
import { createSessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';
import { createStopSession } from './stopSession';
import { waitForExistingSessionExitIfStopRequested } from './waitForExistingSessionExitIfStopRequested';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';
import { subscribeManagedSessionDirectoryRemoval } from './subscribeManagedSessionDirectoryRemoval';

it.each(['live', 'preparing'] as const)('retires an inactive Session’s %s successor on deletion without a directory allocation, preserving its neighbour', async successorState => {
  await withConfiguredDaemonTestHome({ prefix: 'deleted-respawn-' }, async ({ homeDir }) => {
    const sessions = new Map<number, TrackedSession>();
    const children: ChildProcess[] = [];
    const exits = new Map<number, Promise<unknown>>();
    const sessionId = 'deleted-inactive-session';
    const launch = async (id: string) => {
      // OS/process is the boundary. Every lifecycle, restart and removal owner is real.
      const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(child);
      exits.set(child.pid!, once(child, 'exit'));
      await once(child, 'message');
      const identity = await readProcessIdentityByPid(child.pid!);
      if (!identity) throw new Error('Missing process fixture identity');
      const tracked: TrackedSession = { pid: child.pid!, childProcess: child, happySessionId: id,
        startedBy: 'daemon', processStartTimeMs: identity.processStartTimeMs,
        processCommandHash: hashProcessCommand(identity.command), spawnOptions: { directory: homeDir } };
      sessions.set(tracked.pid, tracked);
      await writeSessionMarker({ pid: tracked.pid, happySessionId: id, startedBy: 'daemon',
        processStartTimeMs: identity.processStartTimeMs, processCommandHash: hashProcessCommand(identity.command) });
      return tracked;
    };
    let launches = 0;
    let pausePreparation = false;
    let preparing = false;
    let preparationSettled = false;
    let releasePreparation!: () => void;
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    const respawn = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2,
      baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0, random: () => 0,
      isSessionAlreadyRunning: id => [...sessions.values()].some(row => row.happySessionId === id),
      spawnSession: async options => {
        if (pausePreparation) { preparing = true; await preparation; }
        if (options.beforeSessionRunnerLaunch && !await options.beforeSessionRunnerLaunch()) {
          preparationSettled = true;
          return { type: 'error' };
        }
        launches++;
        const tracked = await launch(options.existingSessionId!);
        return { type: 'success', sessionId: options.existingSessionId, pid: tracked.pid };
      }, logDebug: () => {}, logWarn: () => {} });
    const machine = {
      captureMachineSessionTerminal: async (id: string) => ({ v: 1, status: 'already_inactive', sessionId: id } as const),
      enqueueDaemonTerminalExactTurnEnd: async () => { throw new Error('Inactive Session has no exact turn to settle'); },
      finalizeMachineSessionTerminal: async () => { throw new Error('Inactive Session must not request terminal finalization'); },
    } satisfies Pick<ApiMachineClient, 'captureMachineSessionTerminal' | 'enqueueDaemonTerminalExactTurnEnd' | 'finalizeMachineSessionTerminal'>;
    const onExit = createOnChildExited({ pidToTrackedSession: sessions,
      spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => machine,
      onUnexpectedExit: (tracked, exit) => { respawn.handleUnexpectedExit(tracked, exit); } });
    const core = createStopSession({ pidToTrackedSession: sessions,
      areTrackedRunnersExited: ({ trackedPids }) => waitForTrackedRunnerProcessesExit({
        runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0 }),
      waitForTrackedRunnersExit: async ({ sessionId: id, trackedPids }) => {
        await waitForExistingSessionExitIfStopRequested({ sessionId: id, pidToTrackedSession: sessions,
          timeoutMs: 1000, pollIntervalMs: 10, onExitObserved: onExit });
        return trackedPids.every(pid => !sessions.has(pid));
      } });
    const receipts: unknown[] = [];
    let deleted: ((input: { sessionId: string }) => void | Promise<void>) | undefined;
    let dispose: (() => void) | undefined;
    try {
      const original = await launch(sessionId);
      const neighbour = await launch('unrelated-session');
      original.childProcess!.kill('SIGTERM');
      await exits.get(original.pid);
      await onExit(original.pid, { reason: 'process-exit', code: 1, signal: null });
      await vi.waitFor(() => expect([...sessions.values()].some(row => row.happySessionId === sessionId)).toBe(true));
      expect(launches).toBe(1);
      const successor = [...sessions.values()].find(row => row.happySessionId === sessionId)!;
      expect(successor.pid).not.toBe(original.pid);
      if (successorState === 'preparing') {
        pausePreparation = true;
        successor.childProcess!.kill('SIGTERM');
        await exits.get(successor.pid);
        await onExit(successor.pid, { reason: 'process-exit', code: 1, signal: null });
        await vi.waitFor(() => expect(preparing).toBe(true));
      }
      dispose = await subscribeManagedSessionDirectoryRemoval({
        directories: createManagedSessionDirectories({ activeServerDir: join(homeDir, 'server') }), token: 'fixture',
        stopSession: async id => {
          respawn.markStopRequested(id, { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
          const receipt = await core(id);
          receipts.push(StopSessionResultSchema.parse(receipt));
          return receipt;
        },
        onSessionDeletedChange: listener => { deleted = listener; return () => { deleted = undefined; }; },
        onSessionAccessReset: () => () => {},
        fetchInventoryPage: async () => ({ sessions: [], hasNext: false, nextCursor: null }),
      });
      await deleted!({ sessionId });
      const firstReceipt = { status: successorState === 'live' ? 'stopped' : 'not_found' };
      expect(receipts).toEqual([firstReceipt]);
      releasePreparation();
      if (successorState === 'preparing') await vi.waitFor(() => expect(preparationSettled).toBe(true));
      expect(await waitForTrackedRunnerProcessesExit({ runners: [{ pid: successor.pid }], timeoutMs: 0, pollIntervalMs: 0 })).toBe(true);
      expect([...sessions.values()].filter(row => row.happySessionId === sessionId)).toEqual([]);
      expect(sessions.get(neighbour.pid)).toBe(neighbour);
      expect(neighbour.childProcess!.exitCode).toBeNull();
      expect(respawn.handleUnexpectedExit(successor, { reason: 'process-exit', code: 1, signal: null })).toBe('ignored');
      await deleted!({ sessionId });
      expect(receipts).toEqual([firstReceipt, { status: 'not_found' }]);
      expect(launches).toBe(1);
    } finally {
      dispose?.();
      respawn.markStopRequested(sessionId, { reason: 'test_cleanup', requestedAtMs: Date.now() });
      releasePreparation();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.allSettled(exits.values());
      sessions.clear();
      vi.restoreAllMocks();
    }
  });
});
