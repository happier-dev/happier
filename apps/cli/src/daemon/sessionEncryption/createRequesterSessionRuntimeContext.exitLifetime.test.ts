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
import type { SpawnResourceCleanupByKey } from '../sessions/cleanupSessionResources';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../types';
import { createRequesterSessionRuntimeContext } from './createRequesterSessionRuntimeContext';
import { createRequesterSessionAccountContextCustody } from './requesterSessionAccountContextCustody';
import { retireExactTerminalControlServiceability } from '../sessions/retireTerminalControlServiceability';
import { SessionMetadataTuplePatchV1Schema, createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { encodeStoredCredentials } from '@/persistence';
import { admitRequesterSessionBootstrap, createRequesterSessionRuntimeContextResolver, releaseUnretainedRequesterSessionRuntimeContext,
  type AdmittedRequesterSessionBootstrap } from './requesterSessionCredentials';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

it.each(['before_exit', 'during_exit', 'before_cleanup_registration', 'collision_during_exit', 'shared_live_replacement', 'shared_retiring_replacement', 'shared_predecessor_recovery', 'stop_publication', 'stop_publication_e2ee', 'stop_publication_failed', 'stop_publication_home_changed'] as const)(
  'retires current requester custody across %s',
  async replacement => {
    const directory = await mkdtemp(join(tmpdir(), 'requester-exit-lifetime-'));
    // The substituted Home authenticates this token; requester owners still
    // consume its real Account subject, including the Follow cache boundary.
    const requesterToken = `e30.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
    const accountMode = replacement === 'stop_publication_e2ee' ? 'e2ee' : 'plain';
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(23) };
    const contentKeyFingerprint = accountMode === 'e2ee'
      ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint)
      : null;
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
    let stopRunner: Readonly<{ pid: number; startTimeMs: number }> | undefined;
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
      const metadata = { machineId: 'machine', path: '/repo', ...(stopRunner ? {
        hostPid: stopRunner.pid, hostProcessStartTimeMs: stopRunner.startTimeMs,
        lifecycleState: 'running', terminal: { mode: 'plain' },
      } : {}) };
      return { status: 200, data: url.endsWith('/v2/sessions/bob-session')
        ? { session: createSessionRecordFixture({ id: 'bob-session', encryptionMode: accountMode,
          metadataLayoutVersion: 0, metadataVersion: 1,
          metadata: accountMode === 'e2ee' ? encryptSessionPayload({ ctx: { encryptionKey: material.secret,
            encryptionVariant: 'legacy' }, payload: metadata }) : JSON.stringify(metadata), dataEncryptionKey: null, share: null }) }
        : url.endsWith('/profile') ? { id: 'bob' }
        : url.endsWith('/currentness')
          ? { mode: accountMode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint, updatedAt: 1,
            recipientEnvelopeReadiness: accountMode === 'e2ee' ? { status: 'available' } : { status: 'unavailable', reason: 'plain_account' } }
          : accountMode === 'e2ee' && url.endsWith('/v2/account/settings') ? { content: null, version: 0 }
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
      const trackedSessions = new Map<SessionTrackingKey, TrackedSession>();
      host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
        serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
        credentials: { token: 'alice', encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
        registry, trackedSessions, getRequester: () => requester, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
      const switchCoordinator = host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator;
      const admitBootstrap = async () => {
        const admitted = await admitRequesterSessionBootstrap({
          bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials({ token: requesterToken,
            encryption: accountMode === 'e2ee' ? material : null }) },
          existingSessionId: 'bob-session',
          boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
          context: { signal: new AbortController().signal,
            machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
              installationId: 'installation', role: 'use', encryptionMode: accountMode },
            verifyMachineAdmissionCurrent: async () => true },
        });
        if (!admitted) throw new Error('Missing real requester admission');
        const initial = initialBootstrap === undefined;
        initialBootstrap ??= admitted.admitted;
        // Machine permission was admitted once. The retained Home identity
        // observation still belongs to the runtime's local custody lifetime.
        admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => true, async () => {
          if ((initial && replacement === 'shared_predecessor_recovery') || replacement === 'stop_publication_home_changed') {
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
            trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry: registry,
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
      const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: 'bob-session', startedBy: 'daemon',
        requesterSessionRuntimeContext: initialRequester };
      trackedSessions.set(tracked.trackingKey, tracked);
      const transferred = launchScope.transfer();
      if (!transferred && !retainsInitial) throw new Error('Missing real launch resource custody');
      const spawnCleanupByKey: SpawnResourceCleanupByKey = transferred ? new Map([[tracked.trackingKey, transferred]]) : new Map();
      const onChildExited = createOnChildExited({ trackedSessionsByKey: trackedSessions,
        spawnResourceCleanupByKey: spawnCleanupByKey, sessionAttachCleanupByKey: new Map(),
        getApiMachineForSessions: () => null });
      const exit = await exited;
      expect(exit.code).toBe(1);
      if (replacement.startsWith('stop_publication')) {
        const expectedRunner = { pid, startTimeMs: 100 };
        stopRunner = expectedRunner;
        tracked.processStartTimeMs = stopRunner.startTimeMs;
        tracked.requesterSessionRuntimeContext = requester;
        const custody = createRequesterSessionAccountContextCustody({ trackedSessions,
          resolveRequesterSessionRuntimeContext: async () => requester,
          releaseRequesterSessionRuntimeContext: context => releaseUnretainedRequesterSessionRuntimeContext(context,
            [...trackedSessions.values()].map(session => session.requesterSessionRuntimeContext)),
          externalActionAccountId: 'alice', serverId: 'bob-home', machineId: 'machine', isRetired: () => false });
        const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
          const tuple = SessionMetadataTuplePatchV1Schema.parse(body);
          if (tuple.mode !== 'owner' && tuple.mode !== 'owner_migration') throw new Error('Expected owner tuple mutation');
          if (replacement === 'stop_publication_failed') throw new Error('Fixture Home write failed');
          return { status: 200, data: { success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: (tuple.mode === 'owner' ? tuple.sharedMetadata.expectedVersion : tuple.source.metadata.version) + 1 },
            agentState: { version: tuple.mode === 'owner' ? tuple.agentState.expectedVersion : tuple.source.agentState.version } } };
        });
        try {
          const publication = custody.withSessionAccountContext('bob-session', async context => {
            if (!context) throw new Error('Missing admitted requester Account');
            pendingExit = onChildExited(pid, { reason: 'process-exited', ...exit });
            await pendingExit;
            expect(trackedSessions.size).toBe(0);
            if (replacement === 'stop_publication_home_changed') initialAdmissionAvailable = false;
            // Stop captured this Account before physical exit; its exact final
            // publication follows the real runner resource/requester cleanup.
            return await retireExactTerminalControlServiceability({ sessionId: 'bob-session',
              credentials: context.bootstrap.credentials, currentness: { verifyCurrent: () => context.isCurrent() },
              terminalMode: 'plain', expectedRunner, stoppedAt: 1234 });
          });
          if (replacement === 'stop_publication_failed') await expect(publication).rejects.toThrow('Fixture Home write failed');
          else if (replacement === 'stop_publication_home_changed') {
            await expect(publication).rejects.toMatchObject({ code: 'session_publisher_authority_lost' });
            expect(patch).not.toHaveBeenCalled();
          } else {
            await expect(publication).resolves.toBe('retired');
            const tuple = SessionMetadataTuplePatchV1Schema.parse(patch.mock.calls.at(-1)?.[1]);
            if (tuple.mode !== 'owner' && tuple.mode !== 'owner_migration') throw new Error('Expected owner tuple mutation');
            const envelope = tuple.mode === 'owner' ? tuple.ownerMetadata : tuple.target.ownerMetadata;
            const opened = openSessionOwnerMetadataEnvelopeV1(accountMode === 'e2ee'
              ? { accountMode, material, envelope } : { accountMode, envelope });
            expect(opened).toMatchObject({ ok: true, ownerMetadata: { runtime: { lifecycleState: 'stopped', lifecycleStateSince: 1234 } } });
          }
          expect(await requester.isCurrent(), 'Final publication releases the last operation custody').toBe(false);
          const retiredRequester = requester;
          expect(() => retiredRequester.subscribeAccountSettingsSnapshot(() => {}, {})).toThrow();
        } finally {
          patch.mockRestore();
        }
        return;
      }
      if (replacement === 'shared_predecessor_recovery') {
        retainedPredecessor = initialRequester;
        trackedSessions.set(legacyPidSessionTrackingKey(process.pid), { trackingKey: legacyPidSessionTrackingKey(process.pid),
          pid: process.pid, happySessionId: 'bob-session', startedBy: 'terminal',
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
          const unsubscribe = initialRequester.subscribeAccountSettingsSnapshot(() => {}, {});
          unsubscribe();
        }, 'One replaced pointer must not physically retire another tracked PID\'s requester resources').not.toThrow();
      }
      if (replacement === 'before_exit' || replacement === 'shared_live_replacement' || replacement === 'shared_retiring_replacement') tracked.requesterSessionRuntimeContext = requester;
      if (replacement === 'shared_live_replacement') {
        // Foreground adoption can lend the same requester to a distinct live
        // tracked PID. The actual test process is its OS presence witness.
        trackedSessions.set(legacyPidSessionTrackingKey(process.pid), { trackingKey: legacyPidSessionTrackingKey(process.pid),
          pid: process.pid, happySessionId: 'bob-session', startedBy: 'terminal',
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
        const replacementTracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(replacementPid), pid: replacementPid, happySessionId: 'bob-session', startedBy: 'terminal',
          requesterSessionRuntimeContext: requester };
        trackedSessions.set(replacementTracked.trackingKey, replacementTracked);
        const replacementScope = createProviderLaunchResourceScope();
        replacementScope.register(async () => {
          await axios.get('https://bob-home.test/exit-cleanup-barrier');
          // The genuine dependent cleanup still consumes requester custody.
          expect(requester?.readAccountSettingsSnapshot()).toBeDefined();
        });
        const replacementCleanup = replacementScope.transfer();
        if (!replacementCleanup) throw new Error('Missing replacement fixture cleanup');
        spawnCleanupByKey.set(replacementTracked.trackingKey, replacementCleanup);
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
        expect(trackedSessions.get(tracked.trackingKey)).toBe(tracked);
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
          const unsubscribe = initialRequester.subscribeAccountSettingsSnapshot(() => {}, {});
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
