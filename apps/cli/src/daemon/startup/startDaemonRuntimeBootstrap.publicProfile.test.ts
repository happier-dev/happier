import { InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from "@/daemon/connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { startDaemonRuntimeBootstrap } from './startDaemonRuntimeBootstrap';
import { createNativePublicProfileRefreshFixture } from '../account/publicProfileRefresh.testkit';

const healthSwitchContext = { credentialHealthSwitchLeases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<import("@happier-dev/protocol").QualifiedConnectedAccountServiceRef>(), };

describe('native public-profile bootstrap composition', () => {
  const accounts: Awaited<ReturnType<typeof createNativePublicProfileRefreshFixture>>[] = [];
  afterEach(async () => {
    for (const account of accounts.splice(0)) await account.dispose();
    resetServerFeaturesClientForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('starts native Account refresh with Connected Services disabled and retires its real loop', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_ENABLED', 'false');
    const lifetime = new AbortController();
    const account = await createNativePublicProfileRefreshFixture();
    accounts.push(account);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (new URL(path).pathname === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
        features: { connectedServices: { enabled: false, quotas: { enabled: false } } }, capabilities: {},
      }));
      throw new Error(`Unexpected HTTP request ${init?.method ?? 'GET'} ${path}`);
    }));
    const unsupported = async () => { throw new Error('Connected Services are disabled'); };
    const params = {
      api: {} as never,
      credentials: { token: 'native-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } },
      logger: { debug() {}, info() {}, warn() {} },
      processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'false' },
      controlPort: 43101, machineId: 'machine-1', machineIdProvider: () => 'machine-1', runtimeId: 'runtime-1', cliVersion: '0.0.0',
      startupSource: 'manual' as const, serviceLabel: undefined, daemonLogPath: '/tmp/daemon.log', controlToken: 'control',
      publishDaemonState: () => true, happyHomeDir: '/tmp/profile-bootstrap-home', activeServerDir: '/tmp/profile-bootstrap-server',
      filesystemAccessPolicy: { kind: 'osUser' as const }, publicReleaseChannel: 'dev' as const,
      connectedServicesRestartRequestedPids: new Set<number>(), pidToTrackedSession: new Map(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: { ...healthSwitchContext, switchBeforeTurn: unsupported, applyCommittedGeneration: unsupported, applyCredentialUpdate: unsupported },
      connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      providerAccountUsageStore: createProviderAccountUsageStore(),
      publicProfileRefresh: { signal: lifetime.signal, isCurrent: account.isCurrent, actions: account.actions },
    };
    const runtime = await startDaemonRuntimeBootstrap(params);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(account.refreshes).toHaveLength(1), { interval: 0 });
      expect(account.refreshes).toHaveLength(1);
      expect(account.refreshes[0]?.snapshot.facts.tokens).toBe(10);
      expect(runtime.connectedServiceRefreshCoordinator).toBeNull();
      expect(runtime.connectedServiceQuotasCoordinator).toBeNull();
      const requestsBeforeRetirement = account.requests.length;
      lifetime.abort();
      await runtime.publicProfileRefreshHandle?.stop();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(account.requests).toHaveLength(requestsBeforeRetirement);
      expect(account.refreshes).toHaveLength(1);
    } finally {
      lifetime.abort();
      await runtime.publicProfileRefreshHandle?.stop();
      await runtime.stopDirectPeerServer();
      await runtime.stopTailscaleTransferServeLifecycle();
    }
  });
});
