import { randomUUID } from 'node:crypto';

import type { Credentials } from '@/persistence';
import {
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  type ProviderAccountSettingsMigrationContextV1,
  type ProviderContributionV1,
} from '@happier-dev/protocol';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';

import { authorizeLegacyProfileMigrationContext } from './authorizeContext';
import { buildLegacyProfileMigrationContext } from './buildContext';

type RegistryLease = Readonly<{
  registry: unknown;
  release: () => Promise<void>;
}>;

type MigrationInvocation = Readonly<{
  credentials: Credentials;
  acquireRegistryLease: () => Promise<RegistryLease>;
  deriveContext: (
    latestRawSettings: Readonly<Record<string, unknown>>,
    acceptedRegistry: unknown,
  ) => ProviderAccountSettingsMigrationContextV1 | Promise<ProviderAccountSettingsMigrationContextV1>;
}>;

type MigrationResult = Readonly<{
  version: number;
  settings?: unknown;
  outcomes: readonly unknown[];
}>;

export type LegacyProfileMigrationCoordinatorResult = Readonly<
  | { status: 'feature_disabled' }
  | { status: 'complete'; version: number; outcomes: readonly unknown[] }
  | { status: 'deferred'; reason: string }
>;

export function readLegacyProfileMigrationContributionMap(registry: unknown): ReadonlyMap<string, Readonly<{ definition: ProviderContributionV1 }>> {
  if (!registry || typeof registry !== 'object') return new Map();
  const contributes = Reflect.get(registry, 'contributes');
  const map = contributes && typeof contributes === 'object'
    ? Reflect.get(contributes, 'providersByContributionKey')
    : undefined;
  if (!(map instanceof Map)) return new Map();
  return map as ReadonlyMap<string, Readonly<{ definition: ProviderContributionV1 }>>;
}

function resolvedContributionMap(registry: unknown): ReadonlyMap<string, ResolvedProviderContribution> {
  return readLegacyProfileMigrationContributionMap(registry) as ReadonlyMap<string, ResolvedProviderContribution>;
}

export function allocateLegacyProfileMigrationConnectionIds(
  providersByContributionKey: ReadonlyMap<string, Readonly<{ definition: ProviderContributionV1 }>>,
  createConnectionId: (sourceProfileId: string) => string,
): Readonly<Record<string, string>> {
  const allocated: Record<string, string> = Object.create(null);
  for (const entry of providersByContributionKey.values()) {
    for (const descriptor of entry.definition?.legacyProfileMigrations ?? []) {
      const sourceProfileId = descriptor?.sourceProfileId;
      if (typeof sourceProfileId === 'string' && !Object.prototype.hasOwnProperty.call(allocated, sourceProfileId)) {
        allocated[sourceProfileId] = createConnectionId(sourceProfileId);
      }
    }
  }
  return allocated;
}

export function createLegacyProfileMigrationCoordinator(deps: Readonly<{
  acquireRegistryLease: () => Promise<RegistryLease>;
  migrate: (params: MigrationInvocation) => Promise<MigrationResult>;
  buildContext?: typeof buildLegacyProfileMigrationContext;
  createConnectionId?: (sourceProfileId: string) => string;
  now?: () => number;
  processEnv?: Readonly<Record<string, string | undefined>>;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
}>) {
  const inFlightByAccount = new Map<string, Promise<LegacyProfileMigrationCoordinatorResult>>();
  const buildContext = deps.buildContext ?? buildLegacyProfileMigrationContext;
  const createConnectionId = deps.createConnectionId ?? (() => `pc_migration_${randomUUID()}`);
  const now = deps.now ?? Date.now;

  const ensureMigrated = (
    input: Readonly<{ accountKey: string; credentials: Credentials; providersEnabled: boolean; machineId: string }>,
  ): Promise<LegacyProfileMigrationCoordinatorResult> => {
    if (input.providersEnabled !== true) return Promise.resolve({ status: 'feature_disabled' } as const);
    const existing = inFlightByAccount.get(input.accountKey);
    if (existing) return existing;
    const operation = (async (): Promise<LegacyProfileMigrationCoordinatorResult> => {
      try {
        const lifetime = createProviderOperationLifetime({
          wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
        });
        const lease = await deps.acquireRegistryLease();
        try {
          const providersByContributionKey = readLegacyProfileMigrationContributionMap(lease.registry);
          const allocatedConnectionIdsBySourceProfileId = allocateLegacyProfileMigrationConnectionIds(
            providersByContributionKey,
            createConnectionId,
          );
          const migratedAt = now();
          const result = await deps.migrate({
            credentials: input.credentials,
            // The coordinator owns this lease across id allocation and every CAS
            // retry. The migration helper receives an explicit borrowed view so
            // its normal finally path cannot release the same generation twice.
            acquireRegistryLease: async () => ({ registry: lease.registry, release: async () => undefined }),
            deriveContext: async (latestRawSettings, acceptedRegistry) => {
              const providersByContributionKey = resolvedContributionMap(acceptedRegistry);
              const context = buildContext({
                rawSettings: latestRawSettings,
                providersByContributionKey,
                allocatedConnectionIdsBySourceProfileId,
                migratedAt,
                processEnv: deps.processEnv,
              });
              return authorizeLegacyProfileMigrationContext({
                rawSettings: latestRawSettings,
                context,
                providersByContributionKey,
                machineId: input.machineId,
                ...(deps.resolveAddresses ? { resolveAddresses: deps.resolveAddresses } : {}),
                lifetime,
              });
            },
          });
          return { status: 'complete', version: result.version, outcomes: result.outcomes };
        } finally {
          await lease.release();
        }
      } catch (error) {
        return {
          status: 'deferred',
          reason: error instanceof Error ? error.message : 'legacy_profile_migration_failed',
        };
      }
    })();
    inFlightByAccount.set(input.accountKey, operation);
    const clearInFlight = () => {
      if (inFlightByAccount.get(input.accountKey) === operation) inFlightByAccount.delete(input.accountKey);
    };
    void operation.then(clearInFlight, clearInFlight);
    return operation;
  };

  return Object.freeze({ ensureMigrated });
}
