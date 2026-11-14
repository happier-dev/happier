import { expect, it } from 'vitest';
import { AccountSettingsSchema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { withdrawSavedSecretCatalogInSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createSavedSecretMaterializerFromSnapshotV1 } from './savedSecretCatalog';
import { createInvocationSavedSecretOperationContextV1 } from './savedSecretOperationContext';

const ref = 'happier:shared-secret:v1:provider-key';
const token = 'synthetic-operation-token';

function sourceSnapshot(version: number): ActiveAccountSettingsSnapshot {
  const resourceDataKey = new Uint8Array(32).fill(version);
  return {
    source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: version,
    loadedAtMs: version, scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [],
    savedSecretCatalogState: 'ready', savedSecretResources: [{
      resourceId: 'provider-key', ownerAccountId: 'owner', relationship: 'owner', displayName: 'Provider key',
      kind: 'apiKey', revision: version, encryptionMode: 'e2ee', materialStatus: 'ready', resourceDataKey,
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'provider-key', mode: 'e2ee', resourceDataKey,
        content: { v: 1, name: 'Provider key', kind: 'apiKey', value: 'synthetic-test-material' },
        randomBytes: length => new Uint8Array(length).fill(7) }),
    }],
  };
}

it.each(['initial', 'source-rebase', 'settings-replacement'] as const)(
  'keeps separate invocation readers usable when another holder refreshes (%s)', async entry => {
    let source = sourceSnapshot(1);
    const createContext = () => createInvocationSavedSecretOperationContextV1({
      snapshot: source, credentials: { token, encryption: null }, serverHttpBaseUrl: 'https://home.test',
      readSourceSnapshot: () => source, isCurrent: async () => true,
    });
    const first = createContext();
    const second = createContext();
    if (entry !== 'initial') {
      const next = sourceSnapshot(2);
      if (entry === 'source-rebase') source = next;
      else {
        await first.replaceAccountSettings(next);
        await second.replaceAccountSettings(next);
      }
    }
    const firstSnapshot = first.readSnapshot()!;
    const secondSnapshot = second.readSnapshot()!;
    const firstReader = createSavedSecretMaterializerFromSnapshotV1(firstSnapshot, { operationContext: first });
    const secondReader = createSavedSecretMaterializerFromSnapshotV1(secondSnapshot, { operationContext: second });
    expect(firstReader.resolveContent(ref).status).toBe('ready');
    expect(secondReader.resolveContent(ref).status).toBe('ready');
    first.beginRefresh();
    expect(firstReader.resolveContent(ref).status).toBe('temporarily_unavailable');
    expect(secondReader.resolveContent(ref).status).toBe('ready');
    expect(createSavedSecretMaterializerFromSnapshotV1(source).resolveContent(ref).status).toBe('ready');
    // Retiring the source must likewise leave the independent invocation usable.
    withdrawSavedSecretCatalogInSnapshot(source);
    expect(secondReader.resolveContent(ref).status).toBe('ready');
    second.beginRefresh();
    expect(secondReader.resolveContent(ref).status).toBe('temporarily_unavailable');
  },
);
