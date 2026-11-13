import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { captureProcessTree, terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { createSessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import type { TrackedSession } from '../types';
import { createStopSession } from './stopSession';
import { createSessionProcessActionLifecycle } from './sessionProcessActionLifecycle';
import { createOnChildExited } from './onChildExited';
import { createProcessActionExecutor } from '../processes/actions/processActionExecutor';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import { listHappierProcessRoots } from '../processes/roots/listHappierProcessRoots';
import { processRef } from '../processes/view/processRef';
import { configuration } from '@/configuration';
import { resolveProcessOwnerScopeKey, withProcessOwnerEnvironment } from '@/processes/ownerTag';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createEndOwnerRemainder } from '../processes/endOwnerRemainder';
import { createLeftBehindPass } from '../processes/leftBehind/leftBehindPass';
import type { HappierProcessRoot } from '../processes/ownership/types';
import { createSessionStopOperationBarrier } from './sessionStopOperationBarrier';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe.skipIf(process.platform === 'win32')('native Session process Action intent', () => {
  it('lets the custodian kill a guest session through the real Action owner while actual exit retirement preserves final verification', async () => {
    const sessionId = `native-action-guest-${process.pid}`;
    const root = spawn(process.execPath, ['-e', `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      child.once('spawn', () => process.send(child.pid)); setInterval(() => {}, 1000);
    `], { env: withProcessOwnerEnvironment(process.env, { kind: 'session', sessionId }),
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const rootExit = once(root, 'exit');
    const peer = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const peerExit = once(peer, 'exit');
    await Promise.all([once(root, 'message'), once(peer, 'message')]);
    const capture = await captureProcessTree({ pid: root.pid! });
    if (capture.status !== 'ok') throw new Error(`fixture capture unavailable: ${capture.reason}`);
    const rootIdentity = capture.capturedTargets.find(row => row.pid === root.pid)!;
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(rootIdentity.pid), pid: rootIdentity.pid, processStartTimeMs: rootIdentity.start.startTimeMs,
      childProcess: root, startedBy: 'daemon', happySessionId: sessionId, activeTurnId: 'native-guest-turn',
      vendorResumeId: 'native-guest-vendor', spawnOptions: { directory: process.cwd() } };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    let endedRoots: readonly HappierProcessRoot[] = [];
    const daemonScopeKey = resolveProcessOwnerScopeKey(configuration.happyHomeDir);
    const ownership = createProcessOwnershipRuntime({ daemonScopeKey,
      listRoots: snapshot => listHappierProcessRoots({ snapshot, trackedSessions: sessions.values(), endedRoots }) });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    const ownerRemainder = createEndOwnerRemainder({ processOwnershipRuntime: ownership, daemonScopeKey,
      firstPass: leftBehind.firstPass, retainEndedRoots: roots => { endedRoots = roots; } });
    tracked.ownerRemainderCapture = await ownerRemainder.capture({ kind: 'session', sessionId });
    let spawned = 0;
    const respawn = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2,
      baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0, random: () => 0,
      isSessionAlreadyRunning: () => false, spawnSession: async () => { spawned++; return { type: 'success' }; },
      logDebug: () => {}, logWarn: () => {} });
    // Home terminal mutation transport is the network boundary, not exit orchestration.
    const machine = {
      enqueueDaemonTerminalExactTurnEnd: async () => undefined,
      captureMachineSessionTerminal: async () => ({ v: 1, status: 'already_inactive', sessionId } as const),
      finalizeMachineSessionTerminal: async () => { throw new Error('Inactive Session must not request terminal finalization'); },
    } satisfies Pick<ApiMachineClient, 'enqueueDaemonTerminalExactTurnEnd' | 'captureMachineSessionTerminal' | 'finalizeMachineSessionTerminal'>;
    const onExit = createOnChildExited({ trackedSessionsByKey: sessions, ownerRemainder, spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => machine,
      removeSessionMarkerFn: async () => undefined,
      onUnexpectedExit: (row, exit) => { respawn.handleUnexpectedExit(row, exit); } });
    const retirement = rootExit.then(async ([code, signal]) => {
      await onExit(tracked.pid, { reason: 'process-exited', code, signal });
    });
    const lifecycle = createSessionProcessActionLifecycle({ trackedSessionsByKey: sessions,
      registerPhysicalStopEffect: createSessionStopOperationBarrier().registerPhysicalStopEffect,
      markStopRequested: respawn.markStopRequested, prepareStopIntent: async () => {},
      stopSession: createStopSession({ trackedSessionsByKey: sessions }) });
    const actions = createProcessActionExecutor({ ownership, leftBehind,
      requesterForOwner: owner => owner.kind === 'session' ? { accountId: 'guest' } : { accountId: 'custodian' },
      allProcessesVisible: () => false, prepareKill: lifecycle.prepareKill });
    try {
      const request = { machineId: 'native-machine', tree: true, targets: [{ ref: processRef(rootIdentity.pid, rootIdentity.start),
        expect: { level: 'proven' as const, owner: { kind: 'session' as const, sessionId } } }] };
      expect((await actions.executeKill(request, { accountId: 'recipient', isCustodian: false })).status).toBe('refused');
      expect(tracked.stopRequestedAtMs).toBeUndefined();
      const killed = await actions.executeKill(request, { accountId: 'custodian', isCustodian: true });
      await retirement;
      expect(killed.status, JSON.stringify(killed)).toBe('ended');
      expect(sessions.size).toBe(0);
      expect(tracked.stopRequestedReason).toBe('user_process_kill');
      expect(spawned).toBe(0);
      expect(process.kill(peer.pid!, 0)).toBe(true);
    } finally {
      await terminateProcessTree({ targets: capture.capturedTargets, tree: false, firstSignal: 'SIGKILL' });
      await terminateProcessTree(peer, { firstSignal: 'SIGKILL' });
      await Promise.all([peerExit, retirement]);
      leftBehind.dispose();
    }
  });

  it('kills an actual ancestor tree containing a runner without restarting it or affecting its peer', async () => {
    // Disposable development fixtures only; no daemon or user session is signaled.
    const root = spawn(process.execPath, ['-e', `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      child.once('spawn', () => process.send(child.pid)); setInterval(() => {}, 1000);
    `], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const rootExit = once(root, 'exit');
    const peer = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const peerExit = once(peer, 'exit');
    const [runnerPid] = await once(root, 'message');
    await once(peer, 'message');
    const capture = await captureProcessTree({ pid: root.pid! });
    if (capture.status !== 'ok') throw new Error(`fixture capture unavailable: ${capture.reason}`);
    const runner = capture.capturedTargets.find(row => row.pid === runnerPid);
    const rootIdentity = capture.capturedTargets.find(row => row.pid === root.pid)!;
    if (!runner) throw new Error('native runner identity not captured');
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(runner.pid), pid: runner.pid, processStartTimeMs: runner.start.startTimeMs,
      startedBy: 'daemon', happySessionId: 'native-action-session', vendorResumeId: 'vendor-native',
      spawnOptions: { directory: process.cwd() } };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    let spawned = 0;
    const respawn = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2,
      baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0, random: () => 0,
      isSessionAlreadyRunning: () => false, spawnSession: async () => { spawned++; return { type: 'success' }; },
      logDebug: () => {}, logWarn: () => {} });
    const lifecycle = createSessionProcessActionLifecycle({ trackedSessionsByKey: sessions,
      registerPhysicalStopEffect: createSessionStopOperationBarrier().registerPhysicalStopEffect,
      markStopRequested: respawn.markStopRequested, prepareStopIntent: async () => {},
      stopSession: createStopSession({ trackedSessionsByKey: sessions }) });
    try {
      const stamp = await lifecycle.prepareKill({ targets: capture.capturedTargets });
      if (!stamp) throw new Error('native generation binding refused');
      expect(tracked.stopRequestedAtMs).toBeUndefined();
      const result = await terminateProcessTree({ targets: [rootIdentity], tree: true, firstSignal: 'SIGKILL',
        authorizeSnapshot: stamp });
      expect(result.status).toBe('complete');
      expect(result.outcomes.find(row => row.pid === runner.pid)?.outcome).toBe('ended');
      expect(tracked.stopRequestedReason).toBe('user_process_kill');
      expect(respawn.handleUnexpectedExit(tracked, { reason: 'process-exited', code: null, signal: 'SIGKILL' })).toBe('ignored');
      expect(spawned).toBe(0);
      expect(peer.exitCode).toBeNull();
      expect(peer.signalCode).toBeNull();
      expect(process.kill(peer.pid!, 0)).toBe(true);
      await rootExit;
    } finally {
      await terminateProcessTree({ targets: capture.capturedTargets, tree: false, firstSignal: 'SIGKILL' });
      await terminateProcessTree(peer, { firstSignal: 'SIGKILL' });
      await peerExit;
    }
  });
});
