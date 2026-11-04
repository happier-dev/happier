import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import axios from 'axios';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createOnChildExited } from '../sessions/onChildExited';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../types';
import { createRequesterSessionRuntimeContext } from './createRequesterSessionRuntimeContext';
import { admitRequesterSessionBootstrap, createRequesterSessionRuntimeContextResolver,
  type AdmittedRequesterSessionBootstrap } from './requesterSessionCredentials';

it.each(['before_exit', 'during_exit', 'before_cleanup_registration', 'collision_during_exit', 'shared_live_replacement', 'shared_retiring_replacement', 'shared_predecessor_recovery'] as const)(
  'retires current requester custody across %s',
  async replacement => {
    const directory = await mkdtemp(join(tmpdir(), 'requester-exit-lifetime-'));
    // The substituted Home authenticates this token; requester owners still
    // consume its real Account subject, including the Follow cache boundary.
    const requesterToken = `e30.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
    const channel = await createRequesterCurrentnessSocketHarness();
    let releaseExitCleanup: (() => void) | undefined;
    let announceExitCleanup: (() => void) | undefined;
    const exitCleanupEntered = new Promise<void>(resolve => { announceExitCleanup = resolve; });
    const exitCleanupRelease = new Promise<void>(resolve => { releaseExitCleanup = resolve; });
    let pauseIncumbentCurrentness = false;
    let announceIncumbentCurrentness: (() => void) | undefined;
    let releaseIncumbentCurrentness: (() => void) | undefined;
    const incumbentCurrentnessEntered = new Promise<void>(resolve => { announceIncumbentCurrentness = resolve; });
    const incumbentCurrentnessRelease = new Promise<void>(resolve => { releaseIncumbentCurrentness = resolve; });
    let initialAdmissionAvailable = true;
    let initialBootstrap: AdmittedRequesterSessionBootstrap | undefined;
    // Home HTTP is the boundary; admission, requester construction, resource
    // transfer and the actual Session exit owner all execute real logic.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/exit-cleanup-barrier')) {
        announceExitCleanup?.();
        await exitCleanupRelease;
        return { status: 200, data: {} };
      }
      if (url.endsWith('/incumbent-currentness-barrier')) {
        announceIncumbentCurrentness?.();
        await incumbentCurrentnessRelease;
        return { status: 200, data: {} };
      }
      if (url.endsWith('/initial-admission')) return { status: initialAdmissionAvailable ? 200 : 401, data: {} };
      return { status: 200, data: url.endsWith('/v2/sessions/bob-session')
        ? { session: createSessionRecordFixture({ id: 'bob-session', encryptionMode: 'plain',
          metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }), dataEncryptionKey: null, share: null }) }
        : url.endsWith('/profile') ? { id: 'bob' }
        : url.endsWith('/currentness')
          ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
          : { content: { t: 'plain', v: {} }, version: 1 } };
    });
    let requester: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
    let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
    let pendingExit: Promise<void> | null = null;
    let pendingResolution: Promise<Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>>> | null = null;
    let pendingReplacementExit: Promise<void> | null = null;
    let retainedPredecessor: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
    try {
      const registry = new ConnectedServiceRuntimeRegistry();
      const trackedSessions = new Map<number, TrackedSession>();
      host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
        serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
        credentials: { token: 'alice', encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
        registry, trackedSessions, getRequester: () => requester, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
      const switchCoordinator = host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator;
      const admitBootstrap = async () => {
        const admitted = await admitRequesterSessionBootstrap({
          bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: requesterToken } },
          existingSessionId: 'bob-session',
          boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
          context: { signal: new AbortController().signal,
            machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
              installationId: 'installation', role: 'use', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true },
        });
        if (!admitted) throw new Error('Missing real requester admission');
        const initial = initialBootstrap === undefined;
        initialBootstrap ??= admitted.admitted;
        admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => {
          if (initial && replacement === 'shared_predecessor_recovery') {
            return (await axios.get('https://bob-home.test/initial-admission')).status === 200;
          }
          if (pauseIncumbentCurrentness) await axios.get('https://bob-home.test/incumbent-currentness-barrier');
          return true;
        });
        return admitted.admitted;
      };
      const createRuntime = async (bootstrap: AdmittedRequesterSessionBootstrap) => {
        const runtime = await createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap,
          activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
          resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
          coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
            logger: { debug() {}, info() {}, warn() {} },
            processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
            pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
            connectedServiceAuthGroupPreTurnSwitchCoordinator: switchCoordinator },
        });
        if (!runtime) throw new Error('Missing real requester runtime');
        return runtime;
      };
      const createRequester = async () => await createRuntime(await admitBootstrap());
      requester = await createRequester();
      const initialRequester = requester;
      const launchScope = createProviderLaunchResourceScope();
      const retainsInitial = replacement === 'before_cleanup_registration' || replacement === 'shared_predecessor_recovery';
      if (!retainsInitial) launchScope.register(() => initialRequester.dispose());
      if (replacement === 'during_exit' || replacement === 'collision_during_exit') {
        // Pause the real reverse-order cleanup at a genuine HTTP boundary.
        launchScope.register(async () => { await axios.get('https://bob-home.test/exit-cleanup-barrier'); });
      }
      if (!retainsInitial) {
        await initialRequester.dispose();
        requester = await createRequester();
      }
      expect(await requester.isCurrent()).toBe(true);

      const child = spawn(process.execPath, ['-e', 'process.exitCode = 1'], { cwd: directory, stdio: 'ignore' });
      const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const pid = child.pid;
      if (pid === undefined) throw new Error('Missing fixture process identity');
      const tracked: TrackedSession = { pid, happySessionId: 'bob-session', startedBy: 'daemon',
        requesterSessionRuntimeContext: initialRequester };
      trackedSessions.set(pid, tracked);
      const transferred = launchScope.transfer();
      if (!transferred && !retainsInitial) throw new Error('Missing real launch resource custody');
      const spawnCleanupByPid = transferred ? new Map([[pid, transferred]]) : new Map<number, () => void | Promise<void>>();
      const onChildExited = createOnChildExited({ pidToTrackedSession: trackedSessions,
        spawnResourceCleanupByPid: spawnCleanupByPid, sessionAttachCleanupByPid: new Map(),
        getApiMachineForSessions: () => null });
      const exit = await exited;
      expect(exit.code).toBe(1);
      if (replacement === 'shared_predecessor_recovery') {
        retainedPredecessor = initialRequester;
        trackedSessions.set(process.pid, { pid: process.pid, happySessionId: 'bob-session', startedBy: 'terminal',
          requesterSessionRuntimeContext: initialRequester });
        initialAdmissionAvailable = false;
        const resolveRequester = createRequesterSessionRuntimeContextResolver({ trackedSessions,
          recoverBootstrap: admitBootstrap,
          getCreateRuntime: () => async bootstrap => {
            initialAdmissionAvailable = true;
            return await createRuntime(bootstrap);
          },
        });
        const recovered = await resolveRequester('bob-session');
        if (!recovered) throw new Error('Missing actual recovered requester');
        requester = recovered;
        expect(tracked.requesterSessionRuntimeContext).toBe(recovered);
        // Failed admission withdraws authority; it must not be revived. The
        // published subscription API independently observes physical retirement.
        expect(await initialRequester.isCurrent()).toBe(false);
        expect(() => {
          const unsubscribe = initialRequester.subscribeAccountSettingsSnapshot(() => {});
          unsubscribe();
        }, 'One replaced pointer must not physically retire another tracked PID\'s requester resources').not.toThrow();
      }
      if (replacement === 'before_exit' || replacement === 'shared_live_replacement' || replacement === 'shared_retiring_replacement') tracked.requesterSessionRuntimeContext = requester;
      if (replacement === 'shared_live_replacement') {
        // Foreground adoption can lend the same requester to a distinct live
        // tracked PID. The actual test process is its OS presence witness.
        trackedSessions.set(process.pid, { pid: process.pid, happySessionId: 'bob-session', startedBy: 'terminal',
          requesterSessionRuntimeContext: requester });
      }
      if (replacement === 'shared_retiring_replacement') {
        const replacementChild = spawn(process.execPath, ['-e', 'process.exitCode = 1'], { cwd: directory, stdio: 'ignore' });
        const replacementExit = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
          replacementChild.once('error', reject);
          replacementChild.once('exit', (code, signal) => resolve({ code, signal }));
        });
        const replacementPid = replacementChild.pid;
        if (replacementPid === undefined) throw new Error('Missing replacement fixture process identity');
        const replacementTracked: TrackedSession = { pid: replacementPid, happySessionId: 'bob-session', startedBy: 'terminal',
          requesterSessionRuntimeContext: requester };
        trackedSessions.set(replacementPid, replacementTracked);
        const replacementScope = createProviderLaunchResourceScope();
        replacementScope.register(async () => {
          await axios.get('https://bob-home.test/exit-cleanup-barrier');
          // The genuine dependent cleanup still consumes requester custody.
          expect(requester?.readAccountSettingsSnapshot()).toBeDefined();
        });
        const replacementCleanup = replacementScope.transfer();
        if (!replacementCleanup) throw new Error('Missing replacement fixture cleanup');
        spawnCleanupByPid.set(replacementPid, replacementCleanup);
        const observedReplacementExit = await replacementExit;
        expect(observedReplacementExit.code).toBe(1);
        pendingReplacementExit = onChildExited(replacementPid, { reason: 'process-exited', ...observedReplacementExit });
        await exitCleanupEntered;
        expect(replacementTracked.reportMarkerCustody?.retiring).toBe(true);
      }
      if (replacement === 'collision_during_exit') {
        const incumbentRequester = requester;
        const resolveRequester = createRequesterSessionRuntimeContextResolver({ trackedSessions,
          recoverBootstrap: admitBootstrap,
          getCreateRuntime: () => async bootstrap => {
            const recovered = await createRuntime(bootstrap);
            tracked.requesterSessionRuntimeContext = incumbentRequester;
            pauseIncumbentCurrentness = true;
            return recovered;
          },
        });
        pendingResolution = resolveRequester('bob-session');
        await incumbentCurrentnessEntered;
      }
      pendingExit = onChildExited(pid, { reason: 'process-exited', ...exit });
      if (replacement === 'during_exit' || replacement === 'collision_during_exit') {
        await exitCleanupEntered;
        expect(trackedSessions.get(pid)).toBe(tracked);
        if (replacement === 'during_exit') {
          expect(tracked.requesterSessionRuntimeContext).toBe(initialRequester);
          tracked.requesterSessionRuntimeContext = requester;
        } else {
          expect(tracked.reportMarkerCustody?.retiring).toBe(true);
          releaseIncumbentCurrentness?.();
          expect(await pendingResolution === null, 'Collision return must not lend requester authority after observed exit begins').toBe(true);
        }
        releaseExitCleanup?.();
      }
      await pendingExit;
      const shared = replacement === 'shared_live_replacement' || replacement === 'shared_retiring_replacement';
      expect(trackedSessions.size).toBe(shared || replacement === 'shared_predecessor_recovery' ? 1 : 0);
      expect(await requester.isCurrent(), 'Requester authority must follow its remaining tracked owner').toBe(shared);
      if (replacement === 'shared_predecessor_recovery') {
        expect(() => {
          const unsubscribe = initialRequester.subscribeAccountSettingsSnapshot(() => {});
          unsubscribe();
        }).not.toThrow();
      }
      if (replacement === 'shared_retiring_replacement') {
        releaseExitCleanup?.();
        await pendingReplacementExit;
        expect(trackedSessions.size).toBe(0);
        expect(await requester.isCurrent(), 'The final dependent cleanup must retire shared requester custody').toBe(false);
      }
    } finally {
      releaseExitCleanup?.();
      releaseIncumbentCurrentness?.();
      try {
        await Promise.all([pendingExit, pendingResolution, pendingReplacementExit]);
      } finally {
        try {
          await requester?.dispose();
          await retainedPredecessor?.dispose();
          await initialBootstrap?.dispose();
        } finally {
          try {
            await host?.dispose();
          } finally {
            get.mockRestore();
            await channel.close();
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
  },
);
