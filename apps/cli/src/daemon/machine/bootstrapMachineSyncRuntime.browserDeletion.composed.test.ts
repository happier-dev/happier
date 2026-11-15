import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { createBrowserRoutePublication } from '../browser/control/routePublication';
import type { BrowserProfileStore } from '../browser/profiles/store';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '../serverWork';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt } from './bootstrapMachineSyncRuntime';

it('purges an inactive deleted Session browser profile through the Machine deletion subscription, preserving other profiles', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'browser-session-deletion-' }, async ({ homeDir }) => {
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: homeDir,
      controller: pluginReloadController, coldStart: true, plugins: [{
        manifest: { schemaVersion: 2, id: 'acme.browser-deletion-test', version: '1.0.0', displayName: 'Browser deletion fixture',
          engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' }, contributes: {} },
        files: { 'daemon.mjs': 'export function activate() {}' },
      }] });
    const credentials = { token: 'e30.eyJzdWIiOiJvd25lciJ9.signature', encryption: null } as const;
    const features = FeaturesResponseSchema.parse({ features: {} });
    let store: BrowserProfileStore | undefined;
    const publication = createBrowserRoutePublication({ params: {
      machineId: 'browser-machine', credentials, serverBaseUrl: 'http://127.0.0.1:3030', processEnv: {},
      getApiMachineForSessions: () => null,
      daemonSessionMutationCustody: createDaemonSessionMutationCustody({ credentials }),
      onBrowserStoragePurgeOwnerReady: owner => { store = owner.store; },
    }, readSessionAccountId: () => 'owner', runtimeActionRouteProviderTarget: {},
      setGuardBrowserResourceOwner: () => {}, shutdownSignal: new AbortController().signal,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) });
    if (!store) throw new Error('Browser storage owner was not published');
    const profiles = store;
    const rows = [
      profiles.register({ profileId: 'session-deleted-default', storageMode: 'session', owner: { kind: 'session', id: 'deleted' } }),
      profiles.register({ profileId: 'session-deleted-ephemeral', storageMode: 'ephemeral', owner: { kind: 'session', id: 'deleted' }, cleanupOnSessionClose: true }),
      profiles.register({ profileId: 'session-neighbour-default', storageMode: 'session', owner: { kind: 'session', id: 'neighbour' } }),
      await profiles.registerPersistentProfile({ profileId: 'saved-profile', storageMode: 'user', owner: { kind: 'user', id: 'owner' } }),
    ];
    for (const profile of rows) {
      const directory = join(profiles.resolveProfileDirectory(profile.profileId), 'Default');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'marker'), profile.profileId);
    }
    const listeners = new Set<Parameters<ApiMachineClient['onSessionDeletedChange']>[0]>();
    // The Machine socket is the external boundary. Bootstrap's subscription,
    // deletion ordering, route publication and on-disk profile purge stay real.
    const transport = { ...createApiMachineTransportFixture(), connect() {}, setRPCHandlers: () => ({}),
      onSessionDeletedChange: (listener: Parameters<ApiMachineClient['onSessionDeletedChange']>[0]) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
      }, updateDaemonState: async () => {}, updateMachineMetadata: async () => {},
      emitExternalSessionTranscriptUpdate() {}, sendMachineTransferEnvelope() {}, sendTransferRelayV2Envelope() {},
    };
    let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
    try {
      const input = { cliVersion: 'test', machineId: 'browser-machine', credentials,
        machine: { id: 'browser-machine', encryptionMode: 'plain' as const, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
        preferredHost: 'localhost', happyHomeDir: homeDir, happyLibDir: homeDir,
        filesystemAccessPolicy: { kind: 'osUser' as const }, takeoverRequested: false, isShuttingDown: () => false,
        createConnectedApiMachine: () => transport as unknown as ApiMachineClient,
        attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
        startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
        spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
        spawnSessionForInternalResume: async () => ({ type: 'success' as const, sessionId: 'unused' }),
        // Archive already retired this Session's runner, so there is no child-exit signal.
        stopSession: async () => ({ status: 'not_found' as const }), isSessionAlreadyRunning: async () => false,
        purgeBrowserStorageForSessionDeleted: publication.purgeBrowserStorageForSessionDeleted,
        loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown() {},
        directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
        connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
        daemonServerWorkScheduler: createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) }),
        getServerFeaturesSnapshot: () => ({ status: 'ready' as const, features }),
      };
      runtime = await bootstrapMachineSyncRuntime(input);
      expect(listeners.size).toBeGreaterThan(0);
      for (const listener of listeners) await listener({ sessionId: 'deleted' });
      for (const profile of rows.slice(0, 2)) {
        await expect(access(profiles.resolveProfileDirectory(profile.profileId))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      for (const profile of rows.slice(2)) {
        expect(await readFile(join(profiles.resolveProfileDirectory(profile.profileId), 'Default', 'marker'), 'utf8')).toBe(profile.profileId);
      }
      // Replay is idempotent and keeps the unrelated Session's storage intact.
      for (const listener of listeners) await listener({ sessionId: 'deleted' });
      expect(await readFile(join(profiles.resolveProfileDirectory(rows[2]!.profileId), 'Default', 'marker'), 'utf8')).toBe(rows[2]!.profileId);
    } finally {
      if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
      await publication.dispose();
      await fixture.dispose();
    }
  });
});
