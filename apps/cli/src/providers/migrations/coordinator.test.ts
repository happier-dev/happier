import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import * as persistenceBoundary from '@/persistence';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { StoredCredentials } from '@/persistence';
import type { AccountSettingsUpdateV2Deps } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

import { createLegacyProfileMigrationCoordinator } from './coordinator';
import { migrateProviderSettings } from '../settings/migration';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { PROFILE_PROVIDER_CONVERSION_ROUTE_V1, ProfileProviderConversionMutationV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { ProviderContributionV1Schema, type AccountSettingsV2UpdateResponse } from '@happier-dev/protocol';

const migrationContributionKey = 'happier.provider.deepseek/deepseek';
const migrationContribution = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'frontier',
  endpointTemplates: [{
    id: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic',
    capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'unknown' },
  }],
  catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
  legacyProfileMigrations: [{
    sourceProfileId: 'deepseek',
    migratedEnvironmentVariables: [{ name: 'ANTHROPIC_BASE_URL', value: 'https://api.deepseek.com/anthropic' }],
    retainedEnvironmentVariables: [],
  }],
});

function resolvedMigrationRegistry() {
  return {
    contributes: {
      providersByContributionKey: new Map([[migrationContributionKey, {
        provenance: 'first_party',
        source: { kind: 'bundled' },
        pluginId: 'happier.provider.deepseek',
        identity: { pluginId: 'happier.provider.deepseek', localId: 'deepseek' },
        definition: migrationContribution,
      }]]),
    },
  };
}

async function resolvePlainAccountEncryptionMode(): Promise<'plain'> {
  return 'plain';
}

/** The real Profile reader and Settings writer share one admitted Account HTTP source. */
async function installCoordinatorAccountBoundary(credentials: StoredCredentials, fetchSettings: NonNullable<AccountSettingsUpdateV2Deps['fetchSettings']>) {
  const initial = AccountSettingsV2GetResponseSchema.parse(await fetchSettings());
  if (initial.content?.t !== 'plain') throw new Error('expected plain coordinator fixture');
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(initial.content.v), rawSettings: initial.content.v,
    settingsVersion: initial.version, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  const baselineGet = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/account/settings') return { status: 200, data: AccountSettingsV2GetResponseSchema.parse(await fetchSettings()) };
    if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 1,
      content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 'absent' } };
    if (path.endsWith('/profiles/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', rows: [], complete: true,
      nextCursor: null, diagnostics: [], referenceGuardRevision: 'absent', transferControl: { status: 'absent' } } };
    return baselineGet(url, options);
  });
}

describe('legacy profile migration coordinator', () => {
  beforeEach(() => {
    // The real migration helper now reads the canonical Account memory row.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/authoring-memory/lastUsedProfile')) return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: null } } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (String(url).endsWith(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
      if (String(url).endsWith(REMOTE_HOST_ROWS_ROUTE_V1) || String(url).endsWith(NOTIFICATION_CHANNELS_ROUTE_V1)) {
        return { status: 200, data: { status: 'absent' } };
      }
      throw new Error(`Unexpected Account read: ${String(url)}`);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it('automatically promotes a descriptor-classified literal before the accepted Profile and Provider catalog transaction', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-auto' })).toString('base64url')}.signature` };
    let raw: Record<string, unknown> = { profiles: [{ id: 'deepseek', name: 'Retained DeepSeek', environmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: 'https://api.deepseek.com/anthropic' },
      { name: 'DEEPSEEK_AUTH_TOKEN', value: 'private-inline-key' }, { name: 'TEAM_FLAG', value: 'public' }], createdAt: 1, updatedAt: 1 }],
      profileEnabledById: { deepseek: true }, unknown: { keep: true } };
    let version = 7;
    let promotedResourceId: string | null = null;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(raw), rawSettings: raw,
      settingsVersion: version, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    // Only credential persistence, HTTP, DNS, clock/id allocation and cache I/O are boundaries.
    // The accepted contribution, context builder, authorization and migration remain real.
    vi.spyOn(persistenceBoundary, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {},
    }), { status: 200 }));
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/account/settings') return { status: 200, data: { version, content: { t: 'plain', v: raw } } };
      if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
      if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`
        || path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`
        || path === ACP_CATALOG_ROWS_ROUTE_V1 || path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1
        || path === REMOTE_HOST_ROWS_ROUTE_V1 || path === NOTIFICATION_CHANNELS_ROUTE_V1) {
        return { status: 200, data: { status: 'absent' } };
      }
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: { mode: 'plain', version: 1, settingsVersion: version, signingKeyFingerprint: null, contentKeyFingerprint: null,
          updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
      if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 'absent' } };
      if (path.endsWith('/profiles/transfer')) return { status: 200, data: { status: 'absent' } };
      if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', rows: [], complete: true,
        nextCursor: null, diagnostics: [], referenceGuardRevision: 'absent', transferControl: { status: 'absent' } } };
      if (path.endsWith('/authoring-memory/lastUsedProfile')) return { status: 200, data: { status: 'absent' } };
      if (path.endsWith('/saved-secrets/resources/materials')) return { status: 200, data: { resources: promotedResourceId ? [{
        resourceId: promotedResourceId, encryptionMode: 'plain', recipientEnvelope: null,
        storedContent: { t: 'plain', v: { v: 1, name: 'Retained DeepSeek', kind: 'apiKey', value: 'private-inline-key' } },
        entry: { ref: formatSharedSavedSecretRefV1(promotedResourceId), source: 'shared_resource', relationship: 'owner',
          ownerAccountId: 'account-auto', name: 'Retained DeepSeek', kind: 'apiKey', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
          capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
      }] : [] } };
      throw new Error(`Unexpected automatic migration HTTP read: ${path}`);
    });
    const writes: string[] = [];
    let promotedReference: string | null = null;
    let boundaryFailure: unknown;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      try {
        const path = new URL(String(url)).pathname;
        if (path === PROFILE_PROVIDER_CONVERSION_ROUTE_V1) {
          const mutation = ProfileProviderConversionMutationV1Schema.parse(body);
          expect(mutation.expectedSettingsVersion).toBe(version);
          expect(promotedReference).not.toBeNull();
          expect(mutation.providerMutation.content).toMatchObject({ t: 'plain', v: {
            secretBindingsByConnectionId: { 'pc-auto-deepseek': { account: { apiKey: promotedReference } } },
          } });
          expect(mutation.providerMutation).toMatchObject({ expectedRevision: 1, referencedSavedSecretIds: [promotedReference],
            savedSecretRevisions: [{ resourceId: promotedResourceId, expectedRevision: 1 }] });
          expect(mutation.nextSettings).toMatchObject({ t: 'plain', v: { unknown: { keep: true } } });
          if (mutation.nextSettings?.t !== 'plain') throw new Error('plain Account requires plain Settings');
          expect(mutation.nextSettings.v).not.toHaveProperty('providerSettingsV1');
          raw = mutation.nextSettings.v;
          version += 1;
          writes.push('provider-catalog');
          return { status: 200, data: { status: 'updated', settingsVersion: version, providerRevision: 2,
            rows: [], referenceGuardRevision: 'absent' } };
        }
        const mutation = SharedSavedSecretPromoteInputV1Schema.parse(body);
        expect(mutation.expectedSettingsVersion).toBe(version);
        expect(mutation).toMatchObject({ encryptionMode: 'plain', storedContent: { t: 'plain', v: { value: 'private-inline-key' } },
          referenceCensus: { accountMode: 'plain', profileTransferRevision: 'absent', profiles: { referenceGuardRevision: 'absent', rows: [] },
            catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 1, connectedConfigurations: 'absent', connectedPurposes: 'absent' } },
          profileMutations: [] });
        if (mutation.nextSettings?.t !== 'plain') throw new Error('plain Account requires plain Settings');
        promotedReference = formatSharedSavedSecretRefV1(mutation.resourceId);
        promotedResourceId = mutation.resourceId;
        raw = mutation.nextSettings.v;
        version += 1;
        writes.push('saved-secret-promotion');
        return { status: 200, data: { resourceId: mutation.resourceId, settingsVersion: version } };
      } catch (error) {
        // The real owner maps disconnected commits to unknown; preserve fixture failures for diagnosis.
        boundaryFailure = error;
        throw error;
      }
    });
    const definition = ProviderContributionV1Schema.parse({ ...migrationContribution,
      credential: { kind: 'apiKey', slotId: 'apiKey', required: true, transports: [{ id: 'key', protocols: ['anthropic'], uses: ['probe', 'runtime'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
      legacyProfileMigrations: [{ sourceProfileId: 'deepseek', credentialBinding: { legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey' },
        migratedEnvironmentVariables: [{ name: 'ANTHROPIC_BASE_URL', value: 'https://api.deepseek.com/anthropic' },
          { name: 'DEEPSEEK_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }], retainedEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'public' }] }] });
    const accepted = resolvedMigrationRegistry();
    const previous = accepted.contributes.providersByContributionKey.get(migrationContributionKey)!;
    accepted.contributes.providersByContributionKey.set(migrationContributionKey, { ...previous, definition });
    const coordinator = createLegacyProfileMigrationCoordinator({
      acquireRegistryLease: async () => ({ registry: accepted, release: async () => undefined }),
      migrate: (params) => migrateProviderSettings({ ...params, deps: {
        resolveCachePath: () => '/unused/automatic-provider-migration-cache', writeCache: async () => undefined,
      } }),
      createConnectionId: () => 'pc-auto-deepseek', now: () => 20, processEnv: {}, resolveAddresses: async () => ['8.8.8.8'],
    });
    const result = await coordinator.ensureMigrated({ credentials, accountKey: resolveAccountSettingsScopeKey(credentials),
      providersEnabled: true, machineId: 'machine-auto' });
    if (boundaryFailure) throw boundaryFailure;
    expect(result.status === 'complete' ? true : result).toBe(true);
    expect(result).toMatchObject({ status: 'complete', version: 9, outcomes: [{ sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc-auto-deepseek' }] });
    expect(writes).toEqual(['saved-secret-promotion', 'provider-catalog']);
    expect(raw).toMatchObject({ unknown: { keep: true }, profiles: [{ v: 2, id: 'deepseek', extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'public' }] }] });
    expect(JSON.stringify(raw)).not.toContain('private-inline-key');
    expect(JSON.stringify(result)).not.toContain('private-inline-key');
  });

  it('fails closed before acquiring registry/settings when providers are disabled', async () => {
    let acquired = 0;
    const coordinator = createLegacyProfileMigrationCoordinator({
      acquireRegistryLease: async () => {
        acquired += 1;
        throw new Error('must not run');
      },
      migrate: async () => { throw new Error('must not run'); },
      createConnectionId: () => 'pc-never',
      now: () => 1,
    });
    await expect(coordinator.ensureMigrated({ accountKey: 'account-a', credentials: {} as never, providersEnabled: false, machineId: 'machine-a' }))
      .resolves.toEqual({ status: 'feature_disabled' });
    expect(acquired).toBe(0);
  });

  it('defers registry acquisition failures and clears single-flight state for a later retry', async () => {
    let acquisitions = 0;
    const coordinator = createLegacyProfileMigrationCoordinator({
      acquireRegistryLease: async () => {
        acquisitions += 1;
        throw new Error('registry unavailable');
      },
      migrate: async () => { throw new Error('must not run'); },
      createConnectionId: () => 'pc-never',
      now: () => 1,
    });

    await expect(coordinator.ensureMigrated({
      accountKey: 'account-a',
      credentials: {} as never,
      providersEnabled: true,
      machineId: 'machine-a',
    })).resolves.toMatchObject({ status: 'deferred' });
    await expect(coordinator.ensureMigrated({
      accountKey: 'account-a',
      credentials: {} as never,
      providersEnabled: true,
      machineId: 'machine-a',
    })).resolves.toMatchObject({ status: 'deferred' });
    expect(acquisitions).toBe(2);
  });

  it('single-flights one account and keeps allocated ids stable across per-attempt derivation', async () => {
    let migrations = 0;
    let releases = 0;
    const seenIds: string[] = [];
    const registry = {
      contributes: {
        providersByContributionKey: new Map([['provider:key', {
          definition: { legacyProfileMigrations: [{ sourceProfileId: 'deepseek' }] },
        }]]),
      },
    };
    const coordinator = createLegacyProfileMigrationCoordinator({
      acquireRegistryLease: async () => ({ registry, release: async () => { releases += 1; } }),
      migrate: async (params) => {
        migrations += 1;
        const first = await params.deriveContext({ favoriteProfiles: ['deepseek'] }, registry, DEFAULT_PROVIDER_SETTINGS_V1);
        const second = await params.deriveContext({ lastUsedProfile: 'deepseek' }, registry, DEFAULT_PROVIDER_SETTINGS_V1);
        seenIds.push(
          (first.candidates[0] as any).connection.id,
          (second.candidates[0] as any).connection.id,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { version: 2, settings: {} as never, outcomes: [] };
      },
      buildContext: ({ allocatedConnectionIdsBySourceProfileId }) => ({
        migratedAt: 1,
        pendingCustomProfileIds: [],
        candidates: [{
          kind: 'connection', sourceProfileId: 'deepseek',
          connection: { id: allocatedConnectionIdsBySourceProfileId.deepseek },
        }],
      } as never),
      createConnectionId: () => 'pc-stable',
      now: () => 1,
    });
    const [left, right] = await Promise.all([
      coordinator.ensureMigrated({ accountKey: 'account-a', credentials: {} as never, providersEnabled: true, machineId: 'machine-a' }),
      coordinator.ensureMigrated({ accountKey: 'account-a', credentials: {} as never, providersEnabled: true, machineId: 'machine-a' }),
    ]);
    expect(left).toEqual(right);
    expect(migrations).toBe(1);
    expect(releases).toBe(1);
    expect(seenIds).toEqual(['pc-stable', 'pc-stable']);
  });

  it('allocates arbitrary legacy source ids in a poison-safe record', async () => {
    const registry = {
      contributes: {
        providersByContributionKey: new Map([['provider:key', {
          definition: { legacyProfileMigrations: [{ sourceProfileId: '__proto__' }] },
        }]]),
      },
    };
    let allocated: Readonly<Record<string, string>> | null = null;
    const coordinator = createLegacyProfileMigrationCoordinator({
      acquireRegistryLease: async () => ({ registry, release: async () => undefined }),
      migrate: async (params) => {
        await params.deriveContext({}, registry, DEFAULT_PROVIDER_SETTINGS_V1);
        return { version: 1, outcomes: [] };
      },
      buildContext: (input) => {
        allocated = input.allocatedConnectionIdsBySourceProfileId;
        return { migratedAt: 1, pendingCustomProfileIds: [], candidates: [] };
      },
      createConnectionId: () => 'pc-poison-safe',
      now: () => 1,
    });
    await coordinator.ensureMigrated({ accountKey: 'account-a', credentials: {} as never, providersEnabled: true, machineId: 'machine-a' });
    expect(Object.prototype.hasOwnProperty.call(allocated, '__proto__')).toBe(true);
    expect(allocated?.['__proto__']).toBe('pc-poison-safe');
  });

  it('releases one registry lease exactly once through the real CAS migration helper', async () => {
    const credentials: StoredCredentials = { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const fetchSettings = async () => ({ content: { t: 'plain' as const, v: { providerDefaultModelSelectionsByAgentTargetKeyV1: {} } }, version: 1 });
    await installCoordinatorAccountBoundary(credentials, fetchSettings);
    let releases = 0;
    const lease = {
      registry: { contributes: { providersByContributionKey: new Map() } },
      release: async () => {
        releases += 1;
        if (releases > 1) throw new Error('registry lease released twice');
      },
    };
    const coordinator = createLegacyProfileMigrationCoordinator({
      acquireRegistryLease: async () => lease,
      migrate: (params) => migrateProviderSettings({
        ...params,
        deps: {
          fetchSettings,
          resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
          updateSettings: async (): Promise<AccountSettingsV2UpdateResponse> => ({ success: true, version: 2 }),
          resolveCachePath: () => '/unused/provider-migration-cache',
          writeCache: async () => undefined,
        },
      }),
      now: () => 1,
    });
    await expect(coordinator.ensureMigrated({
      accountKey: 'account-a',
      credentials,
      providersEnabled: true,
      machineId: 'machine-a',
    })).resolves.toMatchObject({ status: 'complete', version: 1 });
    expect(releases).toBe(1);
  });

  it('resolves DNS once and returns a terminal conflict without rebuilding grants against the CAS winner', async () => {
    const credentials: StoredCredentials = { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const fetchSettings = async () => ({ content: { t: 'plain' as const, v: { profiles: [], favoriteProfiles: ['deepseek'] } }, version: 1 });
    await installCoordinatorAccountBoundary(credentials, fetchSettings);
    const registry = resolvedMigrationRegistry();
    let dnsAttempt = 0;
    let updateAttempt = 0;
    const attemptedMutations: ReturnType<typeof ProfileProviderConversionMutationV1Schema.parse>[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe(PROFILE_PROVIDER_CONVERSION_ROUTE_V1);
      updateAttempt += 1;
      attemptedMutations.push(ProfileProviderConversionMutationV1Schema.parse(body));
      return { status: 200, data: { status: 'settings-conflict', revision: 2 } };
    });
    const coordinator = createLegacyProfileMigrationCoordinator({
      acquireRegistryLease: async () => ({ registry, release: async () => undefined }),
      migrate: (params) => migrateProviderSettings({
        ...params,
        deps: {
          fetchSettings,
          resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
          resolveCachePath: () => '/unused/provider-migration-cache',
          writeCache: async () => undefined,
        },
      }),
      createConnectionId: () => 'pc_deepseek',
      now: () => 20,
      resolveAddresses: async () => (++dnsAttempt === 1 ? ['8.8.8.8'] : ['10.0.0.8']),
    });

    await expect(coordinator.ensureMigrated({
      accountKey: 'account-a',
      credentials,
      providersEnabled: true,
      machineId: 'machine-a',
    })).resolves.toEqual({
      status: 'deferred',
      reason: 'Provider settings migration refused: legacy_profile_source_changed',
    });
    expect(updateAttempt).toBe(1);
    expect(attemptedMutations).toHaveLength(1);
    expect(attemptedMutations[0]?.providerMutation.content).toMatchObject({ t: 'plain', v: { accountGrants: [{ connectionId: 'pc_deepseek' }] } });
    const nextSettings = attemptedMutations[0]?.nextSettings;
    expect(nextSettings?.t).toBe('plain');
    if (nextSettings?.t === 'plain') expect(nextSettings.v).not.toHaveProperty('providerSettingsV1');
    expect(dnsAttempt).toBe(1);
  });
});
