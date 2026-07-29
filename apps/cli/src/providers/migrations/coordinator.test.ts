import { describe, expect, it } from 'vitest';

import { createLegacyProfileMigrationCoordinator } from './coordinator';
import { migrateProviderSettingsWithRetry } from '../settings/migrateWithRetry';
import { ProviderContributionV1Schema, type AccountSettingsStoredContentEnvelope, type AccountSettingsV2UpdateResponse } from '@happier-dev/protocol';

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

describe('legacy profile migration coordinator', () => {
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
        const first = await params.deriveContext({ favoriteProfiles: ['deepseek'] }, registry);
        const second = await params.deriveContext({ lastUsedProfile: 'deepseek' }, registry);
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
        params.deriveContext({}, registry);
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
      migrate: (params) => migrateProviderSettingsWithRetry({
        ...params,
        deps: {
          fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 1 }),
          updateSettings: async (): Promise<AccountSettingsV2UpdateResponse> => ({ success: true, version: 2 }),
          resolveCachePath: () => '/unused/provider-migration-cache',
          writeCache: async () => undefined,
        },
      }),
      now: () => 1,
    });
    await expect(coordinator.ensureMigrated({
      accountKey: 'account-a',
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      providersEnabled: true,
      machineId: 'machine-a',
    })).resolves.toMatchObject({ status: 'complete', version: 1 });
    expect(releases).toBe(1);
  });

  it('re-resolves DNS on every CAS attempt and drops a grant when the winning attempt becomes private', async () => {
    const registry = resolvedMigrationRegistry();
    let dnsAttempt = 0;
    let updateAttempt = 0;
    const attemptedContents: AccountSettingsStoredContentEnvelope[] = [];
    const coordinator = createLegacyProfileMigrationCoordinator({
      acquireRegistryLease: async () => ({ registry, release: async () => undefined }),
      migrate: (params) => migrateProviderSettingsWithRetry({
        ...params,
        deps: {
          fetchSettings: async () => ({ content: { t: 'plain', v: { favoriteProfiles: ['deepseek'] } }, version: 1 }),
          updateSettings: async (request): Promise<AccountSettingsV2UpdateResponse> => {
            updateAttempt += 1;
            if (request.content) attemptedContents.push(request.content);
            if (updateAttempt === 1) {
              return {
                success: false,
                error: 'version-mismatch',
                currentVersion: 2,
                currentContent: { t: 'plain', v: { favoriteProfiles: ['deepseek'], concurrent: true } },
              };
            }
            return { success: true, version: 3 };
          },
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
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      providersEnabled: true,
      machineId: 'machine-a',
    })).resolves.toMatchObject({ status: 'complete', version: 3 });
    expect(attemptedContents).toHaveLength(2);
    expect(attemptedContents[0]).toMatchObject({ t: 'plain', v: { providerSettingsV1: { accountGrants: [{ connectionId: 'pc_deepseek' }] } } });
    expect(attemptedContents[1]).toMatchObject({ t: 'plain', v: { concurrent: true, providerSettingsV1: { accountGrants: [] } } });
    expect(dnsAttempt).toBe(2);
  });
});
