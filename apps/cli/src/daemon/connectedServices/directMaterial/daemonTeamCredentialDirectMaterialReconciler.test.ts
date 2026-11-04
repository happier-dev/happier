import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createConnectedAccountTeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse, type ActionExecutorDeps } from '@happier-dev/protocol';
import {
  NO_TEAM_CAPABILITIES_V1,
  TeamCredentialResourcePageV1Schema,
  TeamCredentialResourceSummaryV1Schema,
  TeamsPageV1Schema,
  type TeamCredentialResourceSummaryV1,
} from '@happier-dev/protocol/teams';
import type { TeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';
import { logger } from '@/utils/logger';

vi.mock('./teamCredentialDirectMaterialHttp', () => ({
  fetchTeamCredentialDirectMaterialCensus: vi.fn(async () => ({ recipients: [], nextCursor: null })),
  fetchTeamCredentialDirectMaterialPreparation: vi.fn(),
  upsertTeamCredentialDirectMaterial: vi.fn(),
  withdrawTeamCredentialDirectMaterial: vi.fn(async () => ({})),
}));

import { createDaemonTeamCredentialDirectMaterialReconciler, subscribeTeamCredentialDirectMaterialSourceChanges } from './daemonTeamCredentialDirectMaterialReconciler';
import {
  beginActiveConnectedAccountCatalogRefresh,
  beginActiveProviderConnectionsCatalogRefresh,
  beginActiveSavedSecretCatalogRefresh,
  clearActiveAccountSettingsSnapshot,
  commitActiveAcpCatalog,
  commitActiveNotificationChannelCatalog,
  commitActiveProviderConnectionsCatalog,
  commitActiveSavedSecretCatalog,
  getActiveAccountSettingsSnapshotLifetimeToken,
  getActiveAccountSettingsSnapshot,
  notifyActiveAccountConnectedServicesProjection,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/selection/v1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { ConnectedAccountCatalogRecordV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import {
  fetchTeamCredentialDirectMaterialPreparation,
  withdrawTeamCredentialDirectMaterial,
} from './teamCredentialDirectMaterialHttp';
import { commitActiveConnectedAccountCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const ACCOUNT_ID = 'custodian';

it.each(['connection', 'account-grant', 'machine-grant', 'binding', 'gateway'] as const)(
  'publishes exactly one material wake for a %s change', change => {
    const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/p' },
        deployment: { kind: change === 'gateway' ? 'managedLocal' : 'external' },
        role: 'default', displayName: 'A', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }] });
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'source-account', settings: accountSettingsParse({}),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], providerConnectionsCatalog: { status: 'ready', revision: 1, catalog } });
    const wake = vi.fn();
    const unsubscribe = subscribeTeamCredentialDirectMaterialSourceChanges(wake);
    try {
      const next = ProviderConnectionsCatalogV1Schema.parse({ ...catalog,
        ...(change === 'connection' ? { connections: [] } : {}),
        ...(change === 'account-grant' ? { accountGrants: [{ v: 1, connectionId: 'pc_a', connectionSecurityFingerprint: 'security', confirmedAt: 1 }] } : {}),
        ...(change === 'machine-grant' ? { machineGrants: [{ v: 1, connectionId: 'pc_a', machineId: 'machine',
          connectionSecurityFingerprint: 'security', endpointSetFingerprint: 'endpoints', confirmedAt: 1 }] } : {}),
        ...(change === 'binding' ? { secretBindingsByConnectionId: { pc_a: { account: { apiKey: 'secret' } } } } : {}),
        ...(change === 'gateway' ? { connections: catalog.connections.map(connection => ({ ...connection,
          deployment: { kind: 'managedLocal' },
          gatewayPlacement: { kind: 'machine', machineId: 'gateway' } })) } : {}),
      });
      commitActiveProviderConnectionsCatalog({ scopeKey: 'source-account', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
        catalog: { status: 'ready', revision: 2, catalog: next } });
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake.mock.calls[0]?.[2].predicates).toEqual(['provider-catalog-authority']);
    } finally { unsubscribe(); resetActiveAccountSettingsSnapshotForTests(); }
  },
);

// Both page shapes are built through their own released schemas, so a fixture
// the reconciler's parser would reject fails here instead of silently
// producing an empty resource list.
const teamsPage = TeamsPageV1Schema.parse({
  items: [{
    id: 'team',
    name: 'Team',
    description: null,
    logo: null,
    archivedAt: null,
    recovery: null,
    policy: {
      v: 1,
      sessionCreationPolicy: 'private_default',
      externalSharingPolicy: 'allowed',
      defaultSessionHistoryAccess: 'from_membership',
      admissionMode: 'invite_only',
      authenticationPolicy: null,
      authenticationPolicyStatus: 'available',
    },
    viewerRole: 'member',
    capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
    admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
    counts: null,
  }],
  nextCursor: null,
});

function summary(input: Readonly<{ id: string; custodianAccountId?: string }>): TeamCredentialResourceSummaryV1 {
  return TeamCredentialResourceSummaryV1Schema.parse({
    id: input.id,
    teamId: 'team',
    custodianAccountId: input.custodianAccountId ?? ACCOUNT_ID,
    sourceOwnerDisplayName: null,
    displayName: input.id,
    enabled: true,
    revision: 1,
    deliveryPolicy: { preferredAllowedModes: ['direct'] },
    sessionUsePolicy: 'personal_allowed',
    source: {
      v: 1,
      kind: 'provider_connection',
      connectionId: 'pc_source',
      connectionSecurityFingerprint: 'connection-security:v1:test',
      credentialSlotId: 'apiKey',
    },
    sourcePresentation: {
      kind: 'provider',
      provider: { identity: { pluginId: 'provider.test', localId: 'test' }, definitionRevision: 1 },
    },
    directExportSupport: 'supported',
    activeUsageLimitCount: 0,
    requestPolicy: null,
    brokerPlacement: null,
    allMembersAllowedRoutes: ['direct'],
    groupGrants: [],
    memberGrants: [],
    readiness: { kind: 'available' },
    recoveryAction: null,
    brokerPresentation: {
      selectedTarget: null,
      eligibleTargets: [],
      selectedPool: null,
      eligiblePools: [],
    },
    capabilities: {
      manageAudience: false,
      managePolicy: false,
      manageLimits: false,
      updateBrokerPlacement: false,
      narrowDisclosure: false,
      widenDisclosure: false,
      refreshDirectMaterial: false,
      disable: false,
      enable: false,
      delete: false,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

const sourceSnapshot = {
  currentness: {
    sourceMember: { kind: 'provider_credential_slot', connectionId: 'pc_source', credentialSlotId: 'apiKey' },
    sourceVersion: 'source-v1',
    isCurrent: async () => true,
  },
  material: {
    kind: 'provider_api_key',
    value: 'source-secret',
    runtimeBinding: {
      provider: { identity: { pluginId: 'provider.test', localId: 'test' }, definitionRevision: 1 },
      endpoint: {
        endpointTemplateId: 'responses',
        normalizedUrl: 'https://api.example.test/v1',
        protocol: 'openai-responses',
        publicHeaders: {},
      },
      credentialTransport: {
        id: 'api-key', protocols: ['openai-responses'], uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
      },
    },
  },
} as unknown as TeamCredentialSourceSnapshot;

function reconciler(homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>) {
  return createDaemonTeamCredentialDirectMaterialReconciler({
    token: 'token',
    accountId: ACCOUNT_ID,
    homeDomainAction,
    establishedRuntimeOwner: { readMaterialSnapshot: vi.fn() },
    listAccounts: vi.fn(async () => ({ accounts: [] })),
    readGroup: vi.fn(async () => null),
    resolveProviderSource: vi.fn(async () => sourceSnapshot),
  });
}

describe('daemon Team credential direct-material reconciler', () => {
  beforeEach(() => { vi.mocked(fetchTeamCredentialDirectMaterialPreparation).mockReset(); });

  it('reads only the custodian selection across 101 Teams and 351 resources, preserving source withdrawal and recovery', async () => {
    const admitted = await createAdmittedPluginRuntimeFixture();
    try {
      const teams = Array.from({ length: 101 }, (_, index) => ({ ...teamsPage.items[0]!, id: `team-${index}` }));
      const account = { service: { pluginId: 'happier.voice.openai', localId: 'openai' }, accountId: 'source-account' };
      const source = { v: 1 as const, kind: 'connected_account' as const,
        target: { kind: 'account' as const, account }, credentialIncarnation: 'incarnation' };
      let credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
      let sourceReads = 0;
      const establishedRuntimeOwner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: admitted.controller, credentials: { token: 'synthetic', encryption: null },
        getAccountEncryptionMode: async () => 'plain',
        // The qualified credential HTTP reader and configuration persistence are
        // boundaries. Admission, opening and currentness stay with their real owner.
        readCredential: async () => { sourceReads++; return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
          ref: account, revisionSemantics: 'revisioned', credentialRevision, authenticationModeId: 'api-key', configurationRevision: null,
          content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
            payload: { v: 1, values: { token: 'synthetic' } }, randomBytes: length => new Uint8Array(length) }), metadata: { scopes: [] },
        }); },
        configuration: { read: async () => null, secrets: { admit: async () => undefined, has: async () => false, read: async () => null } },
      });
      const material = await establishedRuntimeOwner.readMaterialSnapshot({ account });
      const snapshot = createConnectedAccountTeamCredentialSourceSnapshot({ source, material,
        authenticationKind: 'manual', isPersistedSourceCurrent: () => true })!;
      let owned = TeamCredentialResourceSummaryV1Schema.parse({ ...summary({ id: 'owned' }), teamId: 'team-100', source,
        sourcePresentation: { kind: 'connected_service', service: account.service } });
      const unrelated = Array.from({ length: 350 }, (_, index) => TeamCredentialResourceSummaryV1Schema.parse({
        ...summary({ id: `foreign-${index}`, custodianAccountId: 'other-custodian' }), teamId: `team-${index % teams.length}`,
      }));
      let reads = 0;
      sourceReads = 0;
      let connected = true;
      const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async request => {
        reads++;
        const input = request.input;
        const cursor = input && typeof input === 'object' && 'cursor' in input ? Number(input.cursor ?? 0) : 0;
        if (request.actionId === 'teams.list') return TeamsPageV1Schema.parse({
          items: teams.slice(cursor, cursor + 100), nextCursor: cursor + 100 < teams.length ? String(cursor + 100) : null,
        });
        const selected = input && typeof input === 'object' && 'scope' in input && input.scope === 'custodian'
          ? (owned.custodianAccountId === ACCOUNT_ID ? [owned] : [])
          : [...unrelated, owned].filter(row => input && typeof input === 'object' && 'teamId' in input && row.teamId === input.teamId);
        return TeamCredentialResourcePageV1Schema.parse({ resources: selected.slice(cursor, cursor + 50),
          nextCursor: cursor + 50 < selected.length ? String(cursor + 50) : null,
          viewer: { manageCredentials: false, offerOwnCredential: true } });
      };
      const owner = createDaemonTeamCredentialDirectMaterialReconciler({ token: 'synthetic', accountId: ACCOUNT_ID,
        homeDomainAction, establishedRuntimeOwner,
        listAccounts: async () => ({ accounts: connected ? [{ revisionSemantics: 'revisioned', credentialRevision,
          ref: account, status: 'connected', authenticationModeId: 'api-key', configurationReady: true, configurationRevision: null, scopes: [] }] : [] }),
        readGroup: async () => null, resolveProviderSource: async () => null,
      });
      vi.mocked(fetchTeamCredentialDirectMaterialPreparation).mockResolvedValue({
        homeServerIdentityId: 'home', teamId: owned.teamId, resourceId: owned.id, resourceRevision: owned.revision,
        source: owned.source!, sourceMember: snapshot.currentness.sourceMember,
        sourceCredentialIncarnation: 'incarnation', publishedSourceVersion: snapshot.currentness.sourceVersion, recipients: [], nextCursor: null,
      });
      vi.mocked(withdrawTeamCredentialDirectMaterial).mockClear();
      expect(await owner.reconcile('startup')).toMatchObject({ failures: [] });
      expect(reads).toBe(1);
      const initialSourceReads = sourceReads;
      expect(initialSourceReads).toBeGreaterThan(0);
      connected = false;
      expect(await owner.reconcile('source-snapshot')).toMatchObject({ failures: [{ reason: 'source_unavailable' }] });
      expect(reads).toBe(2);
      expect(withdrawTeamCredentialDirectMaterial).toHaveBeenCalledOnce();
      connected = true;
      credentialRevision = `csr_${'x'.repeat(22)}`;
      expect(await owner.reconcile('account-reconnect')).toMatchObject({ failures: [] });
      expect(reads).toBe(3);
      expect(sourceReads).toBeGreaterThan(initialSourceReads);
      const recoveredSourceReads = sourceReads;
      owned = { ...owned, custodianAccountId: 'new-custodian' };
      expect(await owner.reconcile('account-changes')).toMatchObject({ failures: [] });
      expect(reads).toBe(4);
      expect(sourceReads).toBe(recoveredSourceReads);
    } finally { await admitted.dispose(); }
  });


  it('does no resource or account reads for 25 unrelated and cleanup-only publications across 20 resources and 5 sources', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const resources = Array.from({ length: 20 }, (_, index) => TeamCredentialResourceSummaryV1Schema.parse({
      ...summary({ id: `resource-${index}` }),
      source: {
        v: 1, kind: 'connected_account', credentialIncarnation: 'incarnation',
        target: { kind: 'account', account: {
          service: { pluginId: 'service.test', localId: `source-${index % 5}` }, accountId: 'account',
        } },
      },
    }));
    const homeDomainAction = vi.fn<NonNullable<ActionExecutorDeps['homeDomainAction']>>(async request => {
      if (request.actionId === 'teams.list') return teamsPage;
      return TeamCredentialResourcePageV1Schema.parse({
        resources, viewer: { manageCredentials: false, offerOwnCredential: true }, nextCursor: null,
      });
    });
    const listAccounts = vi.fn(async (_service: { pluginId: string; localId: string }) => ({ accounts: [] }));
    let observerCurrent = true;
    const passLog = vi.spyOn(logger, 'debug');
    const passRecords = () => passLog.mock.calls.filter(([message]) => message === '[DAEMON RUN] Team credential direct-material pass');
    const owner = createDaemonTeamCredentialDirectMaterialReconciler({
      token: 'token', accountId: ACCOUNT_ID, homeDomainAction, listAccounts,
      isAccountChangesObserverCurrent: () => observerCurrent,
      // Unavailable accounts must never reach material admission; the real
      // reconciliation path below stops at the HTTP account-list boundary.
      establishedRuntimeOwner: { readMaterialSnapshot: async () => { throw new Error('Unexpected material read'); } },
      readGroup: async () => null,
      resolveProviderSource: async () => null,
    });
    vi.mocked(fetchTeamCredentialDirectMaterialPreparation).mockImplementation(async request => {
      const resource = resources.find(candidate => candidate.id === request.resourceId)!;
      const source = resource.source;
      if (source?.kind !== 'connected_account') throw new Error('Unexpected source');
      return {
        homeServerIdentityId: 'home', teamId: 'team', resourceId: resource.id, resourceRevision: 1,
        source, sourceMember: { kind: 'connected_account', service: source.target.account.service, connectedAccountId: 'account' },
        sourceCredentialIncarnation: 'incarnation', publishedSourceVersion: null, recipients: [], nextCursor: null,
      };
    });
    const providerCatalog = { status: 'ready' as const, revision: 1, catalog: ProviderConnectionsCatalogV1Schema.parse({
      ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/p' },
        role: 'default', displayName: 'A', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }],
    }) };
    const configurationCatalog = { status: 'ready' as const, revision: 1,
      record: ConnectedAccountCatalogRecordV1Schema.parse({ key: 'configurations', value: { v: 1, entries: [] } }) };
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'source-account',
      settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      savedSecretResources: [], savedSecretCatalogState: 'ready',
      providerConnectionsCatalog: providerCatalog, connectedConfigurationCatalog: configurationCatalog });
    const incumbent = { scopeKey: 'source-account', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const passes: Promise<unknown>[] = [];
    const sourceChanges = vi.fn();
    const unsubscribe = subscribeTeamCredentialDirectMaterialSourceChanges((...args) => {
      sourceChanges(...args);
      passes.push(owner.reconcile('source-snapshot', args[2]));
    });
    try {
      // Establish that the fixture actually reaches every owned source.
      await owner.reconcile('startup');
      expect(homeDomainAction).toHaveBeenCalledTimes(2);
      expect(listAccounts).toHaveBeenCalledTimes(5);
      expect(passRecords()).toEqual([['[DAEMON RUN] Team credential direct-material pass', {
        wakeReason: 'startup', observerCurrent: true, selectedServiceCount: 5,
        readsIssued: { teamPages: 1, resourcePages: 1, qualifiedAccountLists: 5,
          qualifiedGroupReads: 0, preparationPages: 20, censusPages: 20 },
      }]]);
      homeDomainAction.mockClear(); listAccounts.mockClear();
      for (let index = 0; index < 25; index++) {
        // Projection-only notices must not publish in-flight withdrawals or
        // turn an unchanged reobservation into another source-authority change.
        beginActiveProviderConnectionsCatalogRefresh(incumbent);
        notifyActiveAccountConnectedServicesProjection(incumbent.scopeKey);
        expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog?.status).toBe('loading');
        commitActiveProviderConnectionsCatalog({ ...incumbent, catalog: structuredClone(providerCatalog) });
        beginActiveConnectedAccountCatalogRefresh({ ...incumbent, key: 'configurations' });
        notifyActiveAccountConnectedServicesProjection(incumbent.scopeKey);
        expect(getActiveAccountSettingsSnapshot()?.connectedConfigurationCatalog?.status).toBe('loading');
        commitActiveConnectedAccountCatalog({ ...incumbent, key: 'configurations', catalog: structuredClone(configurationCatalog) });
        beginActiveSavedSecretCatalogRefresh(incumbent);
        notifyActiveAccountConnectedServicesProjection(incumbent.scopeKey);
        expect(getActiveAccountSettingsSnapshot()?.savedSecretCatalogState).toBe('temporarily_unavailable');
        commitActiveSavedSecretCatalog({ ...incumbent, resources: [], state: 'ready' });
        commitActiveNotificationChannelCatalog({ ...incumbent, catalog: { status: 'ready', revision: index, channels: [], diagnostics: [] } });
        commitActiveProviderConnectionsCatalog({ ...incumbent, catalog: { ...providerCatalog,
          cleanup: { status: 'cleanup-pending', reason: `maintenance-${index}` } } });
        commitActiveConnectedAccountCatalog({ ...incumbent, key: 'configurations', catalog: { ...configurationCatalog,
          cleanup: index % 2 ? { status: 'complete' } : { status: 'cleanup-pending', reason: 'history-incomplete' } } });
        // An independent catalog can settle while material admission is
        // withdrawn in other facets. Its publication must not expose those
        // transient withdrawals as credential changes.
        beginActiveProviderConnectionsCatalogRefresh(incumbent);
        beginActiveConnectedAccountCatalogRefresh({ ...incumbent, key: 'configurations' });
        beginActiveSavedSecretCatalogRefresh(incumbent);
        commitActiveNotificationChannelCatalog({ ...incumbent, catalog: {
          status: 'ready', revision: 100 + index, channels: [], diagnostics: [],
        } });
        expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog?.status).toBe('loading');
        expect(getActiveAccountSettingsSnapshot()?.connectedConfigurationCatalog?.status).toBe('loading');
        expect(getActiveAccountSettingsSnapshot()?.savedSecretCatalogState).toBe('temporarily_unavailable');
        commitActiveAcpCatalog({ ...incumbent, catalog: {
          status: 'ready', revision: index + 1, record: { v: 1, definitions: [] },
        } });
        commitActiveProviderConnectionsCatalog({ ...incumbent, catalog: structuredClone(providerCatalog) });
        commitActiveConnectedAccountCatalog({ ...incumbent, key: 'configurations', catalog: structuredClone(configurationCatalog) });
        commitActiveSavedSecretCatalog({ ...incumbent, resources: [], state: 'ready' });
      }
      await Promise.all(passes);
      expect(homeDomainAction).toHaveBeenCalledTimes(0);
      expect(listAccounts).toHaveBeenCalledTimes(0);
      expect(passRecords()).toHaveLength(1);

      for (let index = 0; index < 25; index++) {
        commitActiveProviderConnectionsCatalog({ ...incumbent, catalog: { ...providerCatalog, revision: index + 2,
          catalog: ProviderConnectionsCatalogV1Schema.parse({ ...providerCatalog.catalog,
            modelPickerVisibilityByConnectionId: { pc_a: index % 2 === 0 },
            modelVisibilityByRef: { [serializeModelVisibilityRefV1({ scope: 'allAgents', providerConnectionId: ProviderConnectionIdSchema.parse('pc_a'), modelId: 'listed' })]: 'hidden' },
            manualModelsByConnectionId: { pc_a: [{ id: `manual-${index}`, addedAt: 1 }] },
            experimentalBindingConfirmations: [{ v: 1, connectionId: 'pc_a', agentTargetKey: 'agent:codex',
              modelId: null, compatibilityFingerprint: 'test', confirmedAt: index }],
          }) } });
      }
      await Promise.all(passes);
      expect(homeDomainAction).toHaveBeenCalledTimes(0);
      expect(listAccounts).toHaveBeenCalledTimes(0);
      expect(passRecords()).toHaveLength(1);

      commitActiveProviderConnectionsCatalog({ ...incumbent, catalog: { ...providerCatalog, revision: 27,
        catalog: { ...providerCatalog.catalog, secretBindingsByConnectionId: { [ProviderConnectionIdSchema.parse('pc_a')]: { account: { apiKey: 'secret' } } } } } });
      await Promise.all(passes);
      expect(homeDomainAction).toHaveBeenCalledTimes(2);
      expect(listAccounts).toHaveBeenCalledTimes(5);
      expect(sourceChanges.mock.calls.at(-1)?.[2]).toEqual({
        predicates: ['provider-catalog-authority'],
        previousRevisions: { settings: 1, providerCatalog: 26, connectedConfiguration: 1, accountLifetime: incumbent.lifetimeToken },
        nextRevisions: { settings: 1, providerCatalog: 27, connectedConfiguration: 1, accountLifetime: incumbent.lifetimeToken },
      });
      expect(passRecords().at(-1)?.[1]).toEqual({
        wakeReason: 'source-snapshot', observerCurrent: true, selectedServiceCount: 5,
        ...sourceChanges.mock.calls.at(-1)?.[2],
        readsIssued: { teamPages: 1, resourcePages: 1, qualifiedAccountLists: 5,
          qualifiedGroupReads: 0, preparationPages: 20, censusPages: 20 },
      });
      commitActiveConnectedAccountCatalog({ ...incumbent, key: 'configurations', catalog: { ...configurationCatalog, revision: 2 } });
      await Promise.all(passes);
      expect(homeDomainAction).toHaveBeenCalledTimes(4);
      expect(listAccounts).toHaveBeenCalledTimes(10);
      expect(sourceChanges.mock.calls.at(-1)?.[2].predicates).toEqual(['connected-configuration-revision']);
      commitActiveProviderConnectionsCatalog({ ...incumbent, catalog: { status: 'unavailable', reason: 'forbidden' } });
      await Promise.all(passes);
      expect(homeDomainAction).toHaveBeenCalledTimes(6);
      expect(listAccounts).toHaveBeenCalledTimes(15);

      // One refused service read must not be repeated for each resource in a
      // pass, and must be attempted afresh by the next reconciliation.
      listAccounts.mockRejectedValue(new Error('service unavailable'));
      observerCurrent = false;
      const refused = await owner.reconcile('account-changes');
      expect(refused.failures).toHaveLength(20);
      expect(listAccounts).toHaveBeenCalledTimes(20);
      expect(passRecords().at(-1)?.[1]).toEqual({
        wakeReason: 'account-changes', observerCurrent: false, selectedServiceCount: 5,
        accountInvalidationReason: 'changes',
        readsIssued: { teamPages: 1, resourcePages: 1, qualifiedAccountLists: 5,
          qualifiedGroupReads: 0, preparationPages: 20, censusPages: 20 },
      });
      listAccounts.mockResolvedValue({ accounts: [] });
      await owner.reconcile();
      expect(listAccounts).toHaveBeenCalledTimes(25);
      expect(passRecords()).toHaveLength(6);
      listAccounts.mockImplementation(async service => {
        if (service.localId === 'source-0') throw new Error('service unavailable');
        return { accounts: [] };
      });
      await owner.reconcile();
      expect(listAccounts).toHaveBeenCalledTimes(30);
      expect(passRecords()).toHaveLength(7);
      expect(passRecords().at(-1)?.[1]).toMatchObject({
        selectedServiceCount: 5, readsIssued: { qualifiedAccountLists: 5 },
      });
      // A failed administration read is still one attributed pass; no payload
      // or error detail may leak into this bounded cost record.
      homeDomainAction.mockRejectedValueOnce(new Error('private transport detail'));
      await expect(owner.reconcile('account-reconnect')).rejects.toThrow('private transport detail');
      expect(passRecords()).toHaveLength(8);
      expect(passRecords().at(-1)?.[1]).toEqual({
        wakeReason: 'account-reconnect', observerCurrent: false, selectedServiceCount: 0,
        accountInvalidationReason: 'reconnect',
        readsIssued: { teamPages: 1, resourcePages: 0, qualifiedAccountLists: 0,
          qualifiedGroupReads: 0, preparationPages: 0, censusPages: 0 },
      });
    } finally {
      unsubscribe();
      await Promise.all(passes);
      resetActiveAccountSettingsSnapshotForTests();
      passLog.mockRestore();
    }
  });

  it('attributes every fired source predicate with payload-free revisions and Account retirement', () => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'private-scope',
      settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      savedSecretResources: [], savedSecretCatalogState: 'ready',
      providerConnectionsCatalog: { status: 'ready', revision: 3, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 },
      connectedConfigurationCatalog: { status: 'ready', revision: 4,
        record: ConnectedAccountCatalogRecordV1Schema.parse({ key: 'configurations', value: { v: 1, entries: [] } }) },
    });
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const listener = vi.fn();
    const wakes = () => listener.mock.calls.map(args => args[2]);
    const unsubscribe = subscribeTeamCredentialDirectMaterialSourceChanges(listener);
    try {
      setActiveAccountSettingsSnapshot({ source: 'cache', scopeKey: 'other-private-scope',
        settings: accountSettingsParse({ secrets: [{ id: 'private-id', name: 'private-name', kind: 'token',
          encryptedValue: { _isSecretValue: true, value: 'private-value' }, createdAt: 1, updatedAt: 1 }] }),
        settingsVersion: 2, loadedAtMs: 2, settingsSecretsReadKeys: [new Uint8Array([9])],
        savedSecretResources: [], savedSecretCatalogState: 'temporarily_unavailable',
        providerConnectionsCatalog: { status: 'unavailable', reason: 'forbidden' },
        connectedConfigurationCatalog: { status: 'unavailable', reason: 'forbidden' },
      });
      expect(wakes()).toEqual([{
        predicates: ['provider-catalog-authority', 'connected-configuration-revision', 'connected-configuration-content',
          'saved-secret-resources', 'saved-secret-state', 'secrets', 'read-keys', 'source', 'scope', 'account-lifetime'],
        previousRevisions: { settings: 1, providerCatalog: 3, connectedConfiguration: 4, accountLifetime: lifetime },
        nextRevisions: { settings: 2, providerCatalog: null, connectedConfiguration: null, accountLifetime: lifetime + 1 },
      }]);
      // Availability/content can change independently of a numeric row revision.
      commitActiveConnectedAccountCatalog({ scopeKey: 'other-private-scope',
        lifetimeToken: lifetime + 1, key: 'configurations', catalog: { status: 'unavailable', reason: 'unreachable' } });
      expect(wakes().at(-1)?.predicates).toEqual(['connected-configuration-content']);
      clearActiveAccountSettingsSnapshot();
      expect(wakes().at(-1)).toMatchObject({ predicates: expect.arrayContaining(['account-lifetime']),
        previousRevisions: { accountLifetime: lifetime + 1 },
        nextRevisions: { settings: null, providerCatalog: null, connectedConfiguration: null, accountLifetime: null },
      });
    } finally {
      unsubscribe();
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('wakes for source authority and Account lifetime changes without reconciling unrelated catalog publications', () => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: 'source-account',
    });
    const observed: string[] = [];
    const unsubscribe = subscribeTeamCredentialDirectMaterialSourceChanges((_previous, next) => {
      observed.push(next === null ? 'account-cleared' : next.savedSecretCatalogState ?? 'provider-authority');
    });
    const incumbent = { scopeKey: 'source-account', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const providerCatalog = { status: 'ready' as const, revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
    try {
      commitActiveNotificationChannelCatalog({ ...incumbent, catalog: { status: 'ready', revision: 1, channels: [], diagnostics: [] } });
      expect(observed).toEqual([]);
      commitActiveProviderConnectionsCatalog({ ...incumbent, catalog: providerCatalog });
      expect(observed).toEqual(['provider-authority']);
      commitActiveNotificationChannelCatalog({ ...incumbent, catalog: { status: 'ready', revision: 2, channels: [], diagnostics: [] } });
      expect(observed).toEqual(['provider-authority']);
      setActiveAccountSettingsSnapshot({
        ...getActiveAccountSettingsSnapshot()!,
        settings: accountSettingsParse({ analyticsOptOut: true }),
        settingsVersion: 2,
      });
      expect(observed).toEqual(['provider-authority']);
      commitActiveSavedSecretCatalog({ ...incumbent, resources: [], state: 'temporarily_unavailable' });
      expect(observed).toEqual(['provider-authority', 'temporarily_unavailable']);
      clearActiveAccountSettingsSnapshot();
      expect(observed).toEqual(['provider-authority', 'temporarily_unavailable', 'account-cleared']);
    } finally {
      unsubscribe();
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  // Qualification can empty a candidate page without ending its keyset.
  it('drains every custodian page, including an empty intermediate page', async () => {
    const owned = summary({ id: 'owned-on-page-two' });
    const homeDomainAction = vi.fn(async (request: Readonly<{ actionId: string; input?: unknown }>) => {
      if (request.actionId === 'teams.list') return { ...teamsPage, retiredPageField: true,
        items: teamsPage.items.map(team => ({ ...team, retiredTeamField: true })) };
      const input = request.input as Readonly<{ cursor?: string | null; filter?: string; scope?: string }>;
      // The Home's default administration read probes broker readiness. Direct
      // preparation must use its existing delivery filter on every page.
      expect(input.filter).toBe('direct');
      expect(input.scope).toBe('custodian');
      const page = TeamCredentialResourcePageV1Schema.parse(input?.cursor === 'page-two'
        ? {
          resources: [owned],
          viewer: { manageCredentials: false, offerOwnCredential: true },
          nextCursor: null,
        }
        : {
          resources: [],
          viewer: { manageCredentials: false, offerOwnCredential: true },
          nextCursor: 'page-two',
        });
      return { ...page, retiredPageField: true,
        resources: page.resources.map(resource => ({ ...resource, retiredResourceField: true })) };
    }) as unknown as NonNullable<ActionExecutorDeps['homeDomainAction']>;
    vi.mocked(fetchTeamCredentialDirectMaterialPreparation).mockResolvedValue({
      homeServerIdentityId: 'home',
      teamId: 'team',
      resourceId: owned.id,
      resourceRevision: 1,
      source: owned.source!,
      sourceMember: { kind: 'provider_credential_slot', connectionId: 'pc_source', credentialSlotId: 'apiKey' },
      sourceCredentialIncarnation: null,
      publishedSourceVersion: null,
      recipients: [],
      nextCursor: null,
    } as never);

    await expect(reconciler(homeDomainAction).reconcile()).resolves.toMatchObject({ prepared: 0, failures: [] });

    expect(fetchTeamCredentialDirectMaterialPreparation).toHaveBeenCalledTimes(1);
    expect(fetchTeamCredentialDirectMaterialPreparation).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: owned.id }),
    );
  });
});
