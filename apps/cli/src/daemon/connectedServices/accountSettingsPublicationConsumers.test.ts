import axios from 'axios';
import {
  AccountSettingsSchema,
  FeaturesResponseSchema,
  formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  notifyActiveAccountConnectedServicesProjection,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshotChanges,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { hydrateSavedSecretCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';

import { createDaemonConnectedAccountPurposeBindingRuntime } from './purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';

// Only the Home HTTP transport and the credentials file are system boundaries
// here. The Saved Secret catalog owner, the Account Settings publication cut,
// the Account Settings purpose-binding store and the daemon purpose runtime
// (with its Session restart owner) are all real.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: Object.assign(Object.create(actual.default), { get: vi.fn() }) };
});

const persistenceMocks = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: persistenceMocks.readStoredCredentials,
}));

const token = 'account-token';
const purpose = {
  consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
  purpose: 'realtime_upstream',
} as const;
const service = { pluginId: 'happier.voice.openai', localId: 'openai' } as const;
const teamsEnabled = FeaturesResponseSchema.parse({
  features: { teams: { enabled: true } },
  capabilities: {},
});
const resourceId = 'resource-configuration-secret';
const sharedRow = {
  resourceId,
  encryptionMode: 'plain' as const,
  entry: {
    ref: formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId }),
    source: 'shared_resource' as const,
    relationship: 'recipient' as const,
    name: 'Shared client secret',
    kind: 'apiKey' as const,
    ownerAccountId: 'owner-account',
    revision: 2,
    materialStatus: 'ready' as const,
    capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
  },
  storedContent: sealSavedSecretResourceStoredContentV1({
    resourceId,
    mode: 'plain',
    content: { v: 1, name: 'Shared client secret', kind: 'apiKey', value: 'client-secret' },
  }),
  recipientEnvelope: null,
};

function createRuntime() {
  return createDaemonConnectedAccountPurposeBindingRuntime({
    resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    // A watch never materializes; these network-facing owners must stay untouched.
    establishedRuntimeOwner: {
      invokeWithReceipt: vi.fn(async () => {
        throw new Error('a watch must not materialize');
      }),
      invokeDirectMaterial: vi.fn(async () => {
        throw new Error('a watch must not materialize');
      }),
    } as never,
    runtimeRegistry: {
      subscribe: () => () => undefined,
      async acquire() {
        throw new Error('a watch must not acquire the runtime registry');
      },
    },
  });
}

describe('Account Settings publication consumers', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.mocked(axios.get).mockReset();
    persistenceMocks.readStoredCredentials.mockReset();
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
  });

  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('restarts a watching Session for a real catalog revocation but not for an unchanged refresh or a projection it already receives', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [sharedRow] } });
    await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });

    const runtime = createRuntime();
    const requestSessionRestart = vi.fn();
    runtime.bindSessionRestartOwner(requestSessionRestart);
    const resync = vi.fn(async () => undefined);
    const watch = runtime.owner.watch({
      purpose,
      serviceRefs: [service],
      sessionId: 'session-1',
      listener: resync,
    });
    try {
      // Every AccountChange wake and every operation admission re-hydrates the
      // catalog. When the Home answers the same authorized material, nothing
      // the watch consumes changed.
      await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });
      await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });
      // The Connected Services projection reaches purpose watches through the
      // runtime's own invalidation, paired with this publication at its one
      // producer; the Account Settings store must not deliver it a second time.
      notifyActiveAccountConnectedServicesProjection(resolveAccountSettingsScopeKeyForToken(token));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resync).not.toHaveBeenCalled();
      expect(requestSessionRestart).not.toHaveBeenCalled();

      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });
      await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });

      await vi.waitFor(() => expect(requestSessionRestart).toHaveBeenCalledOnce());
      expect(resync).toHaveBeenCalledOnce();
      expect(requestSessionRestart).toHaveBeenCalledWith({ sessionId: 'session-1', purpose });
    } finally {
      watch.dispose();
    }
  });

  // `startDaemon` subscribes the direct-material reconciler through this
  // subscription; its connected-service facts arrive through the AccountChange wake.
  it('wakes the direct-material subscription for a real catalog revocation but not for an unchanged refresh or a projection re-publication', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [sharedRow] } });
    await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });
    const reconcile = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshotChanges(() => reconcile());
    try {
      // The reconciler's own source admission re-hydrates the catalog; an
      // unchanged answer must not start another reconciliation.
      await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });
      notifyActiveAccountConnectedServicesProjection(resolveAccountSettingsScopeKeyForToken(token));
      expect(reconcile).not.toHaveBeenCalled();

      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });
      await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });
      expect(reconcile).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });
});
