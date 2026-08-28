import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import {
  createLegacyProfileMigrationSourceFingerprintV1,
  migrateProviderAccountSettingsV1,
  type AccountSettingsStoredContentEnvelope,
  type AccountSettingsV2UpdateResponse,
  type ProviderAccountSettingsMigrationContextV1,
  ProviderConnectionIdSchema,
} from '@happier-dev/protocol';

import {
  confirmLegacyProfileMigrationWithRetry,
  migrateProviderSettingsWithRetry,
  previewLegacyProfileMigrationWithRetry,
} from './migrateWithRetry';

function migrationParams(connectionId: string) {
  return {
    deriveContext: () => context(connectionId),
    acquireRegistryLease: async () => ({ registry: { generation: 'test' }, release: async () => undefined }),
  } as const;
}

function credentials(): Credentials {
  return {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

async function resolvePlainAccountEncryptionMode(): Promise<'plain'> {
  return 'plain';
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function context(connectionId: string): ProviderAccountSettingsMigrationContextV1 {
  return {
    migratedAt: 20,
    pendingCustomProfileIds: [],
    candidates: [{
      kind: 'connection',
      sourceProfileId: 'deepseek',
      connection: {
        v: 1,
        id: ProviderConnectionIdSchema.parse(connectionId),
        source: { kind: 'contribution', contributionKey: 'happier.deepseek/deepseek' },
        role: 'default',
        displayName: 'DeepSeek',
        displayNameMode: 'automatic',
        deployment: { kind: 'external' },
        revision: 0,
        createdAt: 20,
        updatedAt: 20,
      },
    }],
  };
}

describe('migrateProviderSettingsWithRetry', () => {
  it('previews a guided mapping from the latest raw account state without writing or returning settings', async () => {
    const reviewedMapping = {
      connection: {
        v: 1 as const, id: ProviderConnectionIdSchema.parse('pc-company'),
        source: { kind: 'custom' as const, template: {
          v: 1 as const, name: 'Company', endpointTemplates: [{
            id: 'chat', protocol: 'openai-chat' as const, baseUrl: 'https://company.example/v1',
            capabilities: { streaming: 'unknown' as const, toolRoundTrips: 'unknown' as const, statefulResponses: 'unknown' as const, reasoningControls: 'unknown' as const },
          }], catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
        } },
        role: 'named' as const, displayName: 'Company', displayNameMode: 'custom' as const,
        deployment: { kind: 'external' as const },
        revision: 0, createdAt: 1, updatedAt: 1,
      },
      credentialMoves: [], routingEnvironmentVariableNames: ['OPENAI_BASE_URL'], manualModelIds: [],
    };
    const raw = {
      profiles: [{ id: 'company', name: 'Company', environmentVariables: [{ name: 'OPENAI_BASE_URL', value: 'https://company.example/v1' }], createdAt: 1, updatedAt: 1 }],
      lastUsedProfile: 'company',
    };
    let updateCalls = 0;
    const result = await previewLegacyProfileMigrationWithRetry({
      credentials: credentials(), sourceProfileId: 'company', reviewedMapping,
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: raw }, version: 7 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (): Promise<AccountSettingsV2UpdateResponse> => {
          updateCalls += 1;
          return { success: true, version: 8 };
        },
        resolveCachePath: () => '/unused/provider-settings-cache', writeCache: async () => undefined,
      },
    });
    expect(result).toEqual({
      version: 7,
      sourceFingerprint: createLegacyProfileMigrationSourceFingerprintV1({
        rawSettings: raw, sourceProfileId: 'company', reviewedMapping,
      }),
    });
    expect(updateCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain('OPENAI_BASE_URL');
  });

  it('converges a CAS loser on the recorded winning connection without rewriting unrelated settings', async () => {
    const rawWinner = migrateProviderAccountSettingsV1(
      { schemaVersion: 7, unrelated: 'winner' },
      context('pc_winner'),
    );
    expect(rawWinner.ok).toBe(true);
    if (!rawWinner.ok) throw new Error('expected winner fixture');

    const updateCalls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];
    const result = await migrateProviderSettingsWithRetry({
      credentials: credentials(),
      ...migrationParams('pc_loser_preallocated_once'),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: { schemaVersion: 7, unrelated: 'initial' } },
          version: 1,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (request): Promise<AccountSettingsV2UpdateResponse> => {
          updateCalls.push(request);
          return {
            success: false,
            error: 'version-mismatch',
            currentVersion: 2,
            currentContent: { t: 'plain', v: rawWinner.settings },
          };
        },
        resolveCachePath: () => '/unused/provider-settings-cache',
        writeCache: async () => undefined,
      },
    });

    expect(updateCalls).toHaveLength(1);
    expect(result.version).toBe(2);
    expect(result.outcomes).toEqual([
      { sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_winner' },
    ]);
    expect(result.settings).toMatchObject({
      schemaVersion: 7,
      unrelated: 'winner',
      providerSettingsV1: { connections: [{ id: 'pc_winner' }] },
    });
  });

  it('recomputes guided-confirmation source fingerprint on the CAS winner and refuses a changed binding atomically', async () => {
    const reviewedMapping = {
      connection: {
        v: 1 as const, id: ProviderConnectionIdSchema.parse('pc-company'),
        source: { kind: 'custom' as const, template: {
          v: 1 as const, name: 'Company', endpointTemplates: [{
            id: 'chat', protocol: 'openai-chat' as const, baseUrl: 'https://company.example/v1',
            capabilities: { streaming: 'unknown' as const, toolRoundTrips: 'unknown' as const, statefulResponses: 'unknown' as const, reasoningControls: 'unknown' as const },
          }], catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
        } },
        role: 'named' as const, displayName: 'Company', displayNameMode: 'custom' as const,
        deployment: { kind: 'external' as const },
        revision: 0, createdAt: 1, updatedAt: 1,
      },
      credentialMoves: [], routingEnvironmentVariableNames: ['OPENAI_BASE_URL'], manualModelIds: [],
    };
    const raw = {
      profiles: [{ id: 'company', name: 'Company', environmentVariables: [{ name: 'OPENAI_BASE_URL', value: 'https://company.example/v1' }], createdAt: 1, updatedAt: 1 }],
      lastUsedProfile: 'company',
    };
    const fingerprint = createLegacyProfileMigrationSourceFingerprintV1({ rawSettings: raw, sourceProfileId: 'company', reviewedMapping });
    let updates = 0;
    await expect(confirmLegacyProfileMigrationWithRetry({
      credentials: credentials(), sourceProfileId: 'company', expectedSourceFingerprint: fingerprint,
      reviewedMapping, migratedAt: 20,
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: raw }, version: 1 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (): Promise<AccountSettingsV2UpdateResponse> => {
          updates += 1;
          return {
            success: false, error: 'version-mismatch', currentVersion: 2,
            currentContent: { t: 'plain', v: { ...raw, lastUsedProfile: null } },
          };
        },
        resolveCachePath: () => '/unused/provider-settings-cache', writeCache: async () => undefined,
      },
    })).rejects.toMatchObject({ reason: 'legacy_profile_source_changed' });
    expect(updates).toBe(1);
  });

  it('lets one concurrent migrator win and returns conflict without replaying the other callback', async () => {
    let version = 1;
    let content: AccountSettingsStoredContentEnvelope = {
      t: 'plain',
      v: { schemaVersion: 7, unrelated: 'keep' },
    };
    let arrivals = 0;
    let casWins = 0;
    let observedConflicts = 0;
    const attemptedConnectionIds: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const deps = {
      fetchSettings: async () => ({ content, version }),
      resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
      updateSettings: async (request: Readonly<{
        expectedVersion: number;
        content: AccountSettingsStoredContentEnvelope | null;
      }>): Promise<AccountSettingsV2UpdateResponse> => {
        arrivals += 1;
        const attemptedRoot = request.content?.t === 'plain' ? record(request.content.v) : null;
        const attemptedSettings = record(attemptedRoot?.providerSettingsV1);
        const attemptedConnections = Array.isArray(attemptedSettings?.connections) ? attemptedSettings.connections : [];
        const attemptedId = record(attemptedConnections[0])?.id;
        attemptedConnectionIds.push(typeof attemptedId === 'string' ? attemptedId : 'missing');
        if (arrivals === 2) release();
        await barrier;
        if (request.expectedVersion !== version) {
          observedConflicts += 1;
          return { success: false, error: 'version-mismatch', currentVersion: version, currentContent: content };
        }
        casWins += 1;
        version += 1;
        content = request.content ?? { t: 'plain', v: {} };
        return { success: true, version };
      },
      resolveCachePath: () => '/unused/provider-settings-cache',
      writeCache: async () => undefined,
    } as const;

    const [left, right] = await Promise.allSettled([
      migrateProviderSettingsWithRetry({ credentials: credentials(), ...migrationParams('pc_left'), deps }),
      migrateProviderSettingsWithRetry({ credentials: credentials(), ...migrationParams('pc_right'), deps }),
    ]);

    const fulfilled = [left, right].find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof migrateProviderSettingsWithRetry>>> => result.status === 'fulfilled');
    const rejected = [left, right].find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toBeDefined();
    expect(rejected?.reason).toEqual(expect.objectContaining({ message: expect.stringContaining('conflict') }));
    const winnerId = fulfilled?.value.outcomes[0]?.kind === 'connection'
      ? fulfilled.value.outcomes[0].connectionId
      : null;
    expect(winnerId).toMatch(/^pc_(left|right)$/);
    expect(arrivals).toBe(2);
    expect(casWins).toBe(1);
    expect(observedConflicts).toBe(1);
    expect(new Set(attemptedConnectionIds)).toEqual(new Set(['pc_left', 'pc_right']));
    expect(content).toMatchObject({
      t: 'plain',
      v: {
        unrelated: 'keep',
        providerSettingsV1: { connections: [{ id: winnerId }] },
      },
    });
  });

  it('returns an unrelated-settings conflict without replaying the migration callback', async () => {
    let updateAttempt = 0;
    let finalContent: AccountSettingsStoredContentEnvelope | null = null;
    await expect(migrateProviderSettingsWithRetry({
      credentials: credentials(),
      ...migrationParams('pc_after_unrelated_conflict'),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: { schemaVersion: 7, unrelated: 'initial' } },
          version: 1,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (request): Promise<AccountSettingsV2UpdateResponse> => {
          updateAttempt += 1;
          if (updateAttempt === 1) {
            return {
              success: false,
              error: 'version-mismatch',
              currentVersion: 2,
              currentContent: { t: 'plain', v: { schemaVersion: 7, unrelated: 'concurrent-winner' } },
            };
          }
          finalContent = request.content;
          return { success: true, version: 3 };
        },
        resolveCachePath: () => '/unused/provider-settings-cache',
        writeCache: async () => undefined,
      },
    })).rejects.toThrow('Account Settings mutation did not settle: conflict');

    expect(updateAttempt).toBe(1);
    expect(finalContent).toBeNull();
  });

  it('does not report a dynamic migration as complete when its submitted CAS outcome is unknown', async () => {
    let releaseCount = 0;
    let updateCalls = 0;

    await expect(migrateProviderSettingsWithRetry({
      credentials: credentials(),
      deriveContext: () => context('pc_outcome_unknown'),
      acquireRegistryLease: async () => ({
        registry: { generation: 'test' },
        release: async () => { releaseCount += 1; },
      }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: { schemaVersion: 7, unrelated: 'initial' } },
          version: 1,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (): Promise<AccountSettingsV2UpdateResponse> => {
          updateCalls += 1;
          throw new Error('connection reset after CAS submission');
        },
        resolveCachePath: () => '/unused/provider-settings-cache',
        writeCache: async () => undefined,
      },
    })).rejects.toThrow('Account Settings mutation did not settle: outcomeUnknown');

    expect(updateCalls).toBe(1);
    expect(releaseCount).toBe(1);
  });

  it('re-derives candidates from each CAS winner while retaining one registry lease', async () => {
    const derivations: unknown[] = [];
    let released = 0;
    let updateAttempt = 0;
    const result = await migrateProviderSettingsWithRetry({
      credentials: credentials(),
      acquireRegistryLease: async () => ({
        registry: { generation: 'accepted-generation' },
        release: async () => { released += 1; },
      }),
      deriveContext: (settings, registry) => {
        derivations.push({ unrelated: settings.unrelated, registry });
        return context(settings.unrelated === 'winner' ? 'pc_from_winner' : 'pc_initial');
      },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: { schemaVersion: 7, unrelated: 'initial' } }, version: 1,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (request): Promise<AccountSettingsV2UpdateResponse> => {
          updateAttempt += 1;
          if (updateAttempt === 1) {
            return {
              success: false, error: 'version-mismatch', currentVersion: 2,
              currentContent: { t: 'plain', v: { schemaVersion: 7, unrelated: 'winner' } },
            };
          }
          return { success: true, version: 3 };
        },
        resolveCachePath: () => '/unused/provider-settings-cache',
        writeCache: async () => undefined,
      },
    });
    expect(derivations).toEqual([
      { unrelated: 'initial', registry: { generation: 'accepted-generation' } },
      { unrelated: 'winner', registry: { generation: 'accepted-generation' } },
    ]);
    expect(result.outcomes).toContainEqual({
      sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_from_winner',
    });
    expect(released).toBe(1);
  });
});
