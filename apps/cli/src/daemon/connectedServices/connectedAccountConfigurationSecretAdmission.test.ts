import axios from 'axios';
import { isDeepStrictEqual } from 'node:util';
import {
  AccountSettingsSchema,
  FeaturesResponseSchema,
  PluginConnectedAccountAuthenticationModeV2Schema,
  PluginConnectedAccountDescriptorContributionV2Schema,
  formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1,
  type SavedSecretResourceMaterialV1,
} from '@happier-dev/protocol';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRecordV1Schema, sealConnectedAccountCatalogContentV1, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
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
  createConnectedAccountEstablishedRuntimeDispatcher,
} from '@happier-dev/cli-common/connectedAccounts';
import { createConnectedAccountPurposeBindingOwner } from './purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from './purposeBindings/resolveTarget';
import { createConnectedAccountPluginHttpPurposeHost } from '@/plugins/runtime/fetch/connectedAccountPurpose';
import { createPluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import {
  resetActiveAccountSettingsSnapshotForTests,
  getActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshotListener,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { hydrateSavedSecretCatalog } from "@/settings/secrets/savedSecretCatalogRead";
import { createSecretSourceHostFixture } from '@/plugins/testkit/secretSources';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createCliPersonalSavedSecretActionExecute } from '@/settings/secrets/personalSavedSecretActionHost';
import { SharedSavedSecretUpdateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

import {
  createActiveAccountSettingsConnectedAccountSecrets,
  createAccountSettingsConnectedAccountSecrets,
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

const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner-account' })).toString('base64url')}.signature`;
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
    // Parsed-catalog defaults (the row type is the schema output).
    encryptionMode: null,
    owner: null,
    audience: null,
    accessSources: [],
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

function mockHomeGet(resources: readonly SavedSecretResourceMaterialV1[], record = configurationRecord) {
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
      content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null, record }),
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

function createConfigurationOwner(operationContext?: SavedSecretOperationContextV1) {
  const persistence = createQualifiedConnectedAccountDaemonPersistence({
    credentials: { token, encryption: null },
    getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
    readCredential: vi.fn(async () => null),
    readConfiguration: vi.fn(async () => null),
    mutateCredential: vi.fn(),
    mutateConfiguration: vi.fn(),
    secrets: operationContext
      ? createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey, operationContext })
      : createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }),
    ...(operationContext ? { operationContext } : {}),
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

  it('keeps a configured API token reference through vault export, rotation, unlock repair and recovery', async () => {
    let vaultValue = 'shared-client-secret';
    let locked = false;
    let acquisitions = 0;
    const source = await createSecretSourceHostFixture({ runtime: {
      async store(input) {
        vaultValue = input.value;
        return { ok: true, account: input.account, reference: 'op://vault/item/token' };
      },
      async acquire() {
        acquisitions += 1;
        return locked ? { ok: false, code: 'authentication_required', repair: 'unlock' }
          : { ok: true, value: vaultValue };
      },
    } });
    const apiMode = PluginConnectedAccountAuthenticationModeV2Schema.parse({
      id: 'native-api', kind: 'manual', outcomeReconciliation: 'none', fields: [],
      configuration: { scope: 'service', changeBehavior: 'refresh', fields: [
        { id: 'token', title: 'API token', schema: { type: 'string', minLength: 1 }, secret: true, required: true },
      ] },
    });
    const record = ConnectedAccountCatalogRecordV1Schema.parse({ key: 'configurations', value: { v: 1, entries: [{
      service, modeId: 'native-api', revision: 'configuration-1', values: {}, secretRefs: { token: sharedRef },
    }] } });
    let resource: Extract<SavedSecretResourceMaterialV1, { resourceId: string }> = {
      ...sharedRow, entry: { ...sharedRow.entry, relationship: 'owner',
        audience: { accounts: [{ kind: 'account', accountId: 'owner-account', name: null, firstName: null, lastName: null,
          username: null, avatarUrl: null }], teams: [], groups: [] },
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
    };
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Missing Account snapshot');
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null },
      snapshot: { ...snapshot, connectedConfigurationCatalog: { status: 'ready', revision: 1, record,
        cleanup: { status: 'complete' } } }, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      isCurrent: async () => true, secretSources: source.host });
    const owner = createConfigurationOwner(operationContext);
    const account = { service, accountId: 'configured-token' };
    const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
    const purpose = { consumer: { pluginId: 'acme.consumer', localId: 'action' }, purpose: 'api' };
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({ id: service.localId, title: 'Configured API',
      authentication: { defaultModeId: apiMode.id, modes: [apiMode] } });
    const dispatcher = createConnectedAccountEstablishedRuntimeDispatcher();
    const materializeAccount = async () => {
      const admitted = await owner.admit({ intent: 'connect', service, mode: apiMode, ...generation });
      if (admitted.status !== 'ready') throw new Error(`Expected configured API token, got ${admitted.status}`);
      const context = { account, configuration: admitted.snapshot, credentials: { get: async () => null } };
      // This is the fixture service's actual native-api callback; generic dispatch and custody stay real.
      return dispatcher.invokeEstablishedRuntime({ async materialize(_request, ctx: typeof context) {
        const value = await ctx.configuration.getSecret('token');
        if (value === null) throw new Error('Configured API token is missing');
        return { kind: 'httpHeaders' as const, headers: { authorization: `Bearer ${value}` } };
      } }, descriptor, context, { target: { account, expectedCredentialRevision: credentialRevision,
        expectedRuntimeConfigurationRevision: admitted.snapshot.revision }, operation: { kind: 'materialize',
        request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] } }, context,
        isConfigurationCurrent: candidate => owner.isCurrent(candidate), isCredentialRevisionCurrent: () => true },
      () => {}, async () => {});
    };
    const unexpected = async (): Promise<never> => { throw new Error('No selection or inventory writes'); };
    const purposeOwner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account } }] }),
        update: unexpected, subscribe: () => ({ dispose() {} }) }, selectTarget: unexpected,
      resolveTarget: createPurposeTargetResolver({ available: true, resolveService: async () => ({ service,
        authentication: descriptor.authentication }), listAccounts: async () => [{ ref: account, status: 'connected',
        authenticationModeId: apiMode.id, revisionSemantics: 'revisioned', credentialRevision,
        configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null, displayName: 'Configured API', scopes: [] }] }),
      resolveCredentialRevision: async () => credentialRevision, materializeAccount: async input => {
        input.credentialRevisionBasis?.captureCredentialRevision(credentialRevision);
        return materializeAccount();
      },
      projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected, subscribeInvalidations: () => ({ dispose() {} }),
    });
    const http = createConnectedAccountPluginHttpPurposeHost(purposeOwner, { registerRawForRedaction() {} });
    const materialize = async () => {
      const seed = { plugin: { id: purpose.consumer.pluginId, version: '1.0.0' }, contribution: { id: purpose.consumer.localId,
        qualifiedId: 'acme.consumer/actions/action' }, occurrenceId: 'consumer-1', correlationId: 'operation', surface: 'cli' as const,
        signal: new AbortController().signal, isOccurrenceCurrent: () => true };
      let value: string | undefined;
      const response = await http.requestStream({ seed, signal: seed.signal,
        serviceBinding: { ...createPluginInvocationServiceBinding(seed.occurrenceId, 'purpose'), connectedAccountScopes: [
          { purpose: purpose.purpose, serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] },
        ] }, request: { url: 'https://api.example.test/data', method: 'GET', redirect: 'error', credentialBinding: {
          kind: 'connectedAccountPurpose', purpose: purpose.purpose, origin: 'https://api.example.test', method: 'GET', headerNames: ['authorization'],
        } }, async execute(injection) {
          value = injection?.headers.authorization;
          return { status: 200, finalUrl: 'https://api.example.test/data', headers: {},
            chunks: { async *[Symbol.asyncIterator]() {} }, async dispose() {} };
        } });
      await response.dispose();
      return value;
    };
    try {
      mockHomeGet([resource], record);
      await expect(materialize()).resolves.toBe('Bearer shared-client-secret');
      expect(acquisitions).toBe(0);
      const execute = createCliPersonalSavedSecretActionExecute({ credentials: { token, encryption: null }, operationContext,
        home: async ({ actionId, input }) => {
          expect(actionId).toBe('secrets.shared.update');
          const update = SharedSavedSecretUpdateInputV1Schema.parse(input);
          resource = { ...resource, storedContent: update.storedContent, entry: { ...resource.entry, revision: 4 } };
          mockHomeGet([resource], record);
          return { resourceId, revision: 4 };
        } });
      await expect(execute({ actionId: 'secrets.export', input: {
        target: { contribution: source.contribution, account: 'chosen-account', vaultId: 'vault' },
        secrets: [{ secretId: resourceId, expectedUpdatedAt: 3 }],
      }, context: { surface: 'cli' } })).resolves.toEqual({ results: [{ secretId: resourceId,
        secretRef: sharedRef, status: 'exported', updatedAt: 4 }] });
      expect(record).toMatchObject({ value: { entries: [{ secretRefs: { token: sharedRef } }] } });
      await expect(materialize()).resolves.toBe('Bearer shared-client-secret');
      vaultValue = 'rotated-vault-token';
      await expect(materialize()).resolves.toBe('Bearer rotated-vault-token');
      locked = true;
      await expect(materialize()).rejects.toMatchObject({ code: 'secret_missing', details: {
        materialStatus: 'repair_required', sourceFailure: { code: 'authentication_required', repair: 'unlock' },
      } });
      locked = false;
      await expect(materialize()).resolves.toBe('Bearer rotated-vault-token');
      expect(acquisitions).toBe(4);
    } finally {
      await source.dispose();
    }
  });

  it('refuses a new operation after a revocation whose AccountChange hint was missed', async () => {
    mockHomeGet([sharedRow]);
    await hydrateSavedSecretCatalog({ token });
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
    await hydrateSavedSecretCatalog({ token });
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
