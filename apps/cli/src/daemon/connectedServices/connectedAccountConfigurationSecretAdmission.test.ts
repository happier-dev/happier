import axios from 'axios';
import { isDeepStrictEqual } from 'node:util';
import {
  AccountSettingsSchema,
  FeaturesResponseSchema,
  PluginConnectedAccountAuthenticationModeV2Schema,
  formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, sealConnectedAccountCatalogContentV1, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectedAccountConfigurationError,
  createConnectedAccountConfigurationOwner,
} from '@happier-dev/cli-common/connectedAccounts';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshotListener,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { hydrateSavedSecretCatalog } from "@/settings/secrets/savedSecretCatalogRead";

import {
  createActiveAccountSettingsConnectedAccountSecrets,
  createQualifiedConnectedAccountDaemonPersistence,
} from './qualifiedConnectedAccountDaemonPersistence';

// System boundaries only: the Home HTTP transport (catalog list and features)
// and the credentials file. Account Settings, the Saved Secret catalog, the
// daemon configuration persistence and the configuration owner are real.
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
const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });
const generation = Object.freeze({
  occurrenceId: 'occurrence-1',
  sourceCustody: Object.freeze({
    kind: 'managed' as const,
    immutableGenerationId: 'sha256:artifact-1',
    installSource: 'archive' as const,
  }),
});
const mode = PluginConnectedAccountAuthenticationModeV2Schema.parse({
  id: 'oauth',
  kind: 'oauthDeviceCode',
  outcomeReconciliation: 'providerCheck',
  configuration: {
    scope: 'service',
    changeBehavior: 'refresh',
    fields: [{
      id: 'endpoint',
      title: 'Endpoint',
      schema: { type: 'string', minLength: 1 },
      required: true,
    }, {
      id: 'clientSecret',
      title: 'Client secret',
      schema: { type: 'string', minLength: 1 },
      secret: true,
      required: true,
    }],
  },
});
const resourceId = 'resource-client-secret';
const sharedRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
const sharedRow = {
  resourceId,
  encryptionMode: 'plain' as const,
  entry: {
    ref: sharedRef,
    source: 'shared_resource' as const,
    relationship: 'recipient' as const,
    name: 'Shared client secret',
    kind: 'apiKey' as const,
    ownerAccountId: 'owner-account',
    revision: 3,
    materialStatus: 'ready' as const,
    capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
  },
  storedContent: sealSavedSecretResourceStoredContentV1({
    resourceId,
    mode: 'plain',
    content: { v: 1, name: 'Shared client secret', kind: 'apiKey', value: 'shared-client-secret' },
  }),
  recipientEnvelope: null,
};
const teamsEnabled = FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} });
const configurationRecord: ConnectedAccountCatalogRecordV1 = { key: 'configurations', value: { v: 1, entries: [{
  service, modeId: 'oauth', revision: 'configuration-1',
  values: { endpoint: 'https://api.example.test' }, secretRefs: { clientSecret: sharedRef },
}] } };

function mockHomeGet(resources: readonly typeof sharedRow[]) {
  const emptyPrivateCatalogPaths = new Set([
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ACP_CATALOG_ROWS_ROUTE_V1, MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
    `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, CONNECTED_PRESENTATION_ROWS_ROUTE_V1,
    CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, NOTIFICATION_CHANNELS_ROUTE_V1, REMOTE_HOST_ROWS_ROUTE_V1,
  ]);
  vi.mocked(axios.get).mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`) return { status: 200, data: {
      status: 'present', revision: 1,
      content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null, record: configurationRecord }),
    } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === PROFILE_TRANSFER_ROUTE_V1 || emptyPrivateCatalogPaths.has(path)) return { status: 200, data: { status: 'absent' } };
    if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({
      status: 'listed', rows: [],
    }) };
    if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources } };
    throw new Error(`Unexpected Home read: ${path}`);
  });
}

function savedSecretReadCount() {
  return vi.mocked(axios.get).mock.calls.filter(([input]) =>
    new URL(String(input)).pathname === '/v1/account/saved-secrets/resources/materials').length;
}

function createConfigurationOwner() {
  const persistence = createQualifiedConnectedAccountDaemonPersistence({
    credentials: { token, encryption: null },
    getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
    readCredential: vi.fn(async () => null),
    readConfiguration: vi.fn(async () => null),
    mutateCredential: vi.fn(),
    mutateConfiguration: vi.fn(),
    secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }),
  });
  return createConnectedAccountConfigurationOwner({
    ...persistence.configuration,
    isRuntimeCurrent: () => true,
  });
}

describe('Connected Account service configuration admits its shared Saved Secret refs', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.mocked(axios.get).mockReset();
    persistenceMocks.readStoredCredentials.mockReset();
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(teamsEnabled)));
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      rawSettings: {},
      connectedConfigurationCatalog: { status: 'ready', revision: 1, record: configurationRecord,
        cleanup: { status: 'complete' } },
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey,
    });
  });

  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.unstubAllGlobals();
  });

  it('refuses a new operation after a revocation whose AccountChange hint was missed', async () => {
    mockHomeGet([sharedRow]);
    await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });
    // The Home revokes the grant; the daemon never receives the hint.
    mockHomeGet([]);

    await expect(createConfigurationOwner().admit({
      intent: 'connect',
      service,
      mode,
      ...generation,
    })).rejects.toBeInstanceOf(ConnectedAccountConfigurationError);
    expect(savedSecretReadCount()).toBe(2);
  });

  it('admits a still-authorized ref without waking any Account Settings consumer', async () => {
    mockHomeGet([sharedRow]);
    // Establish the clean-Home precondition through the real cleanup owner so
    // an invalid transport fixture cannot masquerade as a publication defect.
    await expect(normalizeCliAccountSettingsHistoryAfterTransfer({
      credentials: { token, encryption: null }, serverBaseUrl: resolveServerHttpBaseUrl(),
      isCurrent: () => true, destinationAuthority: { activeTransferredRoots: [] },
    })).resolves.toEqual({ status: 'complete' });
    await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });
    const publications = vi.fn<ActiveAccountSettingsSnapshotListener>();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(publications);
    try {
      const admitted = await createConfigurationOwner().admit({
        intent: 'connect',
        service,
        mode,
        ...generation,
      });

      if (admitted.status !== 'ready') throw new Error(`expected ready admission, got ${admitted.status}`);
      await expect(admitted.snapshot.getSecret('clientSecret')).resolves.toBe('shared-client-secret');
      expect(savedSecretReadCount()).toBe(2);
      // Admission re-observed an unchanged catalog, so no purpose watch or
      // direct reconciler is woken by the operation's own admission.
      expect(publications.mock.calls.map(([previous, next]) => ({
        changedFields: [...new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])]
          .filter(key => !isDeepStrictEqual(Reflect.get(previous ?? {}, key), Reflect.get(next ?? {}, key))),
        previousCatalog: previous?.connectedConfigurationCatalog,
        nextCatalog: next?.connectedConfigurationCatalog,
      }))).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
