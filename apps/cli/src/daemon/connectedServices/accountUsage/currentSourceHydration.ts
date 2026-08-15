import {
  ConnectedServiceAuthGroupV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceUsageSourceV1Schema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
  type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

import {
  buildProviderAccountUsageCurrentSourceKey,
  hydrateProviderAccountUsageStoreFromCurrentSources,
  type ProviderAccountUsageCurrentSourceHydrationDisposition,
} from './hydration';
import { createProviderAccountUsageStore, type ProviderAccountUsageStore } from './store';

type ConnectedServiceCurrentSourceHydrationApi = Readonly<{
  listConnectedServiceProfiles: (params: Readonly<{
    serviceId: ConnectedServiceId;
    forceRefresh?: boolean;
  }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: readonly Readonly<{ profileId: string }>[];
  }>>;
  listConnectedServiceAuthGroups: (
    params: Readonly<{ serviceId: ConnectedServiceId }>,
  ) => Promise<readonly ConnectedServiceAuthGroupV1[]>;
  resolveProviderAccountUsageSource: (params: Readonly<{
    source: ConnectedServiceUsageSourceV1;
  }>) => Promise<Readonly<{
    source: ConnectedServiceUsageSourceV1;
    recordId: ProviderAccountUsageRecordId;
    providerAccountId: string;
    fetchedAt: number | null;
    staleAfterMs: number | null;
  }> | null>;
  getAccountEncryptionMode?: () => Promise<'plain' | 'e2ee' | 'unknown'>;
  getProviderAccountUsageSnapshotPlain?: (params: Readonly<{
    recordId: ProviderAccountUsageRecordId;
  }>) => Promise<null | Readonly<{
    content: Readonly<{ t: 'plain'; v: ProviderAccountUsageSnapshotV1 }>;
    sources?: readonly ConnectedServiceUsageSourceV1[];
  }>>;
  getProviderAccountUsageSnapshotSealed?: (params: Readonly<{
    recordId: ProviderAccountUsageRecordId;
  }>) => Promise<null | Readonly<{
    sealed: SealedProviderAccountUsageSnapshotV1;
    sources?: readonly ConnectedServiceUsageSourceV1[];
  }>>;
}>;

type ConnectedServiceCurrentSourceResolution = Awaited<
  ReturnType<ConnectedServiceCurrentSourceHydrationApi['resolveProviderAccountUsageSource']>
>;

const CURRENT_SOURCE_RESOLUTION_CONCURRENCY = 4;

/**
 * The inventory changed while an atomic startup snapshot was being assembled.
 * This is safe to retry from the canonical startup owner because the staging
 * store has not yet been committed.
 */
export class ConnectedServiceCurrentSourceHydrationConflictError extends Error {
  override readonly name = 'ConnectedServiceCurrentSourceHydrationConflictError';
}

export type ConnectedServiceCurrentSourceHydrationResult = Readonly<{
  sources: ConnectedServiceUsageSourceV1[];
  hydration: Readonly<{
    hydratedRecordIds: ProviderAccountUsageRecordId[];
    dispositions: ProviderAccountUsageCurrentSourceHydrationDisposition[];
    refreshSources: ConnectedServiceUsageSourceV1[];
  }>;
}>;

function buildCurrentSourcesForService(input: Readonly<{
  serviceId: ConnectedServiceId;
  profiles: Readonly<{
    serviceId: ConnectedServiceId;
    profiles: readonly Readonly<{ profileId: string }>[];
  }>;
  groups: readonly ConnectedServiceAuthGroupV1[];
}>): ConnectedServiceUsageSourceV1[] {
  if (input.profiles.serviceId !== input.serviceId) {
    throw new Error('Connected service profile inventory returned a mismatched service');
  }
  const sources: ConnectedServiceUsageSourceV1[] = input.profiles.profiles.map((profile) => (
    ConnectedServiceUsageSourceV1Schema.parse({
      serviceId: input.serviceId,
      profileId: profile.profileId,
      bindingKind: 'profile',
    })
  ));

  for (const rawGroup of input.groups) {
    const group = ConnectedServiceAuthGroupV1Schema.parse(rawGroup);
    if (group.serviceId !== input.serviceId) {
      throw new Error('Connected service group inventory returned a mismatched service');
    }
    for (const member of group.members) {
      if (!member.enabled) continue;
      if (member.serviceId !== input.serviceId || member.groupId !== group.groupId) {
        throw new Error('Connected service group member inventory is inconsistent');
      }
      sources.push(ConnectedServiceUsageSourceV1Schema.parse({
        serviceId: input.serviceId,
        profileId: member.profileId,
        bindingKind: 'group_member',
        groupId: group.groupId,
        groupGeneration: group.generation,
      }));
    }
  }
  return sources;
}

function currentSourceResolutionMatches(
  first: NonNullable<ConnectedServiceCurrentSourceResolution>,
  second: ConnectedServiceCurrentSourceResolution,
): boolean {
  return second !== null
    && buildProviderAccountUsageCurrentSourceKey(first.source)
      === buildProviderAccountUsageCurrentSourceKey(second.source)
    && first.recordId === second.recordId
    && first.providerAccountId.trim() === second.providerAccountId.trim();
}

async function mapWithBoundedConcurrency<TInput, TOutput>(input: Readonly<{
  items: readonly TInput[];
  concurrency: number;
  map: (item: TInput, index: number) => Promise<TOutput>;
}>): Promise<TOutput[]> {
  if (input.items.length === 0) return [];
  const results = new Array<TOutput>(input.items.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const workerCount = Math.min(
    input.items.length,
    Math.max(1, Math.trunc(input.concurrency)),
  );
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!failed && nextIndex < input.items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await input.map(input.items[index]!, index);
      } catch (error: unknown) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }));
  if (failed) throw firstError;
  return results;
}

async function resolveCurrentSourcesBounded(input: Readonly<{
  sources: readonly ConnectedServiceUsageSourceV1[];
  resolve: ConnectedServiceCurrentSourceHydrationApi['resolveProviderAccountUsageSource'];
}>): Promise<Map<string, ConnectedServiceCurrentSourceResolution>> {
  const resolutions = await mapWithBoundedConcurrency({
    items: input.sources,
    concurrency: CURRENT_SOURCE_RESOLUTION_CONCURRENCY,
    map: async (source) => await input.resolve({ source }),
  });
  return new Map(input.sources.map((source, index) => [
    buildProviderAccountUsageCurrentSourceKey(source),
    resolutions[index] ?? null,
  ]));
}

async function listCurrentSourcesForServices(input: Readonly<{
  serviceIds: readonly ConnectedServiceId[];
  api: Pick<ConnectedServiceCurrentSourceHydrationApi,
    'listConnectedServiceProfiles' | 'listConnectedServiceAuthGroups'>;
}>): Promise<ConnectedServiceUsageSourceV1[]> {
  const inventory = await Promise.all(input.serviceIds.map(async (serviceId) => {
    const [profiles, groups] = await Promise.all([
      input.api.listConnectedServiceProfiles({ serviceId, forceRefresh: true }),
      input.api.listConnectedServiceAuthGroups({ serviceId }),
    ]);
    return buildCurrentSourcesForService({ serviceId, profiles, groups });
  }));
  return [...new Map(
    inventory.flat().map((source) => [buildProviderAccountUsageCurrentSourceKey(source), source]),
  ).values()];
}

function currentSourceInventoriesMatch(
  first: readonly ConnectedServiceUsageSourceV1[],
  second: readonly ConnectedServiceUsageSourceV1[],
): boolean {
  if (first.length !== second.length) return false;
  const secondKeys = new Set(second.map(buildProviderAccountUsageCurrentSourceKey));
  return first.every((source) => secondKeys.has(buildProviderAccountUsageCurrentSourceKey(source)));
}

/**
 * Builds the authoritative current connected-service source inventory and passively hydrates PAU.
 *
 * Inventory is completed before the first store mutation. Any profile/group enumeration failure
 * therefore rejects the startup barrier rather than activating quota policy from partial truth.
 * Refresh work remains explicit data for the serialized startup owner to schedule after hydration.
 */
export async function hydrateProviderAccountUsageStoreFromConnectedServiceInventory(input: Readonly<{
  serviceIds: Iterable<ConnectedServiceId>;
  api: ConnectedServiceCurrentSourceHydrationApi;
  credentials: Credentials;
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot'>;
  nowMs: number;
}>): Promise<ConnectedServiceCurrentSourceHydrationResult> {
  const serviceIds = [...new Set(
    [...input.serviceIds].map((serviceId) => ConnectedServiceIdSchema.parse(serviceId)),
  )];
  const sources = await listCurrentSourcesForServices({ serviceIds, api: input.api });
  const resolutionsBySourceKey = await resolveCurrentSourcesBounded({
    sources,
    resolve: async (params) => await input.api.resolveProviderAccountUsageSource(params),
  });
  const stagingStore = createProviderAccountUsageStore();
  const hydration = await hydrateProviderAccountUsageStoreFromCurrentSources({
    sources,
    resolveRecordIdForSource: async (source) => {
      const resolution = resolutionsBySourceKey.get(buildProviderAccountUsageCurrentSourceKey(source)) ?? null;
      if (!resolution) return null;
      return {
        recordId: resolution.recordId,
        providerAccountId: resolution.providerAccountId,
        fetchedAt: resolution.fetchedAt,
        staleAfterMs: resolution.staleAfterMs,
      };
    },
    api: input.api,
    credentials: input.credentials,
    store: stagingStore,
    nowMs: input.nowMs,
  });
  const currentSources = await listCurrentSourcesForServices({ serviceIds, api: input.api });
  if (!currentSourceInventoriesMatch(sources, currentSources)) {
    throw new ConnectedServiceCurrentSourceHydrationConflictError(
      'Connected service provider-account usage inventory changed during hydration',
    );
  }
  const currentResolutionsBySourceKey = await resolveCurrentSourcesBounded({
    sources,
    resolve: async (params) => await input.api.resolveProviderAccountUsageSource(params),
  });
  for (const source of sources) {
    const key = buildProviderAccountUsageCurrentSourceKey(source);
    const first = resolutionsBySourceKey.get(key) ?? null;
    if (!first) continue;
    const current = currentResolutionsBySourceKey.get(key) ?? null;
    if (!currentSourceResolutionMatches(first, current)) {
      throw new ConnectedServiceCurrentSourceHydrationConflictError(
        'Connected service provider-account usage source changed during hydration',
      );
    }
  }
  for (const recordId of hydration.hydratedRecordIds) {
    const snapshot = stagingStore.resolveRecordId(recordId);
    if (!snapshot) {
      throw new Error('Provider-account usage hydration staging record is missing');
    }
    const recordSources = hydration.dispositions.flatMap((disposition) => (
      disposition.recordId === recordId ? [disposition.source] : []
    ));
    input.store.recordSnapshot(snapshot, { sources: recordSources });
  }
  return { sources, hydration };
}
