import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createQualifiedConnectedAccountDaemonPersistence } from './qualifiedConnectedAccountDaemonPersistence';

const claudeSubscriptionService = Object.freeze({
  pluginId: 'happier.agent.claude',
  localId: 'claude-subscription',
});
const revisionedPeerFeatures = FeaturesResponseSchema.parse({
  features: {},
  capabilities: { connectedServices: { credentialDelete: { revisionGuard: true } } },
});
const exactPeerFeatures = FeaturesResponseSchema.parse({
  features: { sharing: { pendingQueueV2: { enabled: true } } },
  capabilities: {},
});

describe('qualified Connected Account daemon old-peer refusal', () => {
  it.each([
    { name: 'revisioned scalar peer', service: claudeSubscriptionService, exactPeer: false },
    { name: 'historical Gemini OAuth scalar peer', service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' }, exactPeer: false },
    { name: 'exact released unfenced peer', service: claudeSubscriptionService, exactPeer: true },
  ])('refuses $name before credential reads or outward effects', async ({ service, exactPeer }) => {
    // These injected ports are genuine V4 network/storage boundaries. An old
    // peer must be refused before dispatch; retained 0.2 DATA is tested through
    // qualified snapshots in the established-owner and default-resolver suites.
    const getAccountEncryptionMode = vi.fn(async () => 'plain' as const);
    const listProfiles = vi.fn(async () => { throw new Error('Unexpected qualified list dispatch'); });
    const readCredential = vi.fn(async () => null);
    const readConfiguration = vi.fn(async () => null);
    const mutateCredential = vi.fn();
    const mutateConfiguration = vi.fn();
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } },
      getAccountEncryptionMode,
      listProfiles,
      readCredential,
      readConfiguration,
      mutateCredential,
      mutateConfiguration,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: exactPeer ? exactPeerFeatures : revisionedPeerFeatures }),
      ...(exactPeer ? {
        resolveSessionSyncPendingInputServerContractResult: () => ({
          mode: 'released_server_v0_2_1' as const,
          runtimeActivity: 'legacy' as const,
          pendingInput: 'released_server_v0_2_1' as const,
          publisherAuthority: 'indeterminate' as const,
          sessionConnectionEpoch: 4,
          socket: { connected: true },
        }),
      } : {}),
      secrets: { admit: vi.fn(async () => undefined), has: vi.fn(async () => false), read: vi.fn(async () => null) },
    });

    await expect(persistence.profiles.list(service)).rejects.toMatchObject({ code: 'connected_account_capability_indeterminate' });
    await expect(persistence.attempts.accounts.readExact({ service, accountId: 'work' })).rejects.toMatchObject({ code: 'connected_account_capability_indeterminate' });
    expect(listProfiles).not.toHaveBeenCalled();
    expect(readCredential).not.toHaveBeenCalled();
    expect(readConfiguration).not.toHaveBeenCalled();
    expect(mutateCredential).not.toHaveBeenCalled();
    expect(mutateConfiguration).not.toHaveBeenCalled();
  });
});
