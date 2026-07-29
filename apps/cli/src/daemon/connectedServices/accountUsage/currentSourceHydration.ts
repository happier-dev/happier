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

type CurrentSourceApi = Readonly<{
  listConnectedServiceProfiles: (params: Readonly<{
    serviceId: ConnectedServiceId;
    forceRefresh?: boolean;
  }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: readonly Readonly<{ profileId: string }>[];
  }>>;
  listConnectedServiceAuthGroups: (params: Readonly<{ serviceId: ConnectedServiceId }>) =>
    Promise<readonly ConnectedServiceAuthGroupV1[]>;
  resolveProviderAccountUsageSource: (params: Readonly<{ source: ConnectedServiceUsageSourceV1 }>) =>
    Promise<Readonly<{
      source: ConnectedServiceUsageSourceV1;
      recordId: ProviderAccountUsageRecordId;
      providerAccountId: string;
      fetchedAt: number | null;
      staleAfterMs: number | null;
    }> | null>;
  getAccountEncryptionMode?: () => Promise<'plain' | 'e2ee' | 'unknown'>;
  getProviderAccountUsageSnapshotPlain?: (params: Readonly<{ recordId: ProviderAccountUsageRecordId }>) =>
    Promise<null | Readonly<{
      content: Readonly<{ t: 'plain'; v: ProviderAccountUsageSnapshotV1 }>;
      sources?: readonly ConnectedServiceUsageSourceV1[];
    }>>;
  getProviderAccountUsageSnapshotSealed?: (params: Readonly<{ recordId: ProviderAccountUsageRecordId }>) =>
    Promise<null | Readonly<{
      sealed: SealedProviderAccountUsageSnapshotV1;
      metadata?: Readonly<{
        fetchedAt: number;
        staleAfterMs: number;
        status: 'ok' | 'unavailable' | 'estimated' | 'error';
        materialFingerprint?: string;
      }>;
      sources?: readonly ConnectedServiceUsageSourceV1[];
    }>>;
  registerProviderAccountUsageSnapshotSealed?: (args: Readonly<{
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageSnapshotV1['recordKey'];
    source?: ConnectedServiceUsageSourceV1;
    sealed: SealedProviderAccountUsageSnapshotV1;
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }>) => Promise<void>;
}>;

type SourceResolution = Awaited<ReturnType<CurrentSourceApi['resolveProviderAccountUsageSource']>>;

const CURRENT_SOURCE_RESOLUTION_CONCURRENCY = 4;

export type ConnectedServiceCurrentSourceHydrationResult = Readonly<{
  sources: ConnectedServiceUsageSourceV1[];
  hydration: Readonly<{
    hydratedRecordIds: ProviderAccountUsageRecordId[];
    dispositions: ProviderAccountUsageCurrentSourceHydrationDisposition[];
    refreshSources: ConnectedServiceUsageSourceV1[];
  }>;
}>;

function buildCurrentSources(input: Readonly<{
  serviceId: ConnectedServiceId;
  profiles: Readonly<{ serviceId: ConnectedServiceId; profiles: readonly Readonly<{ profileId: string }>[] }>;
  groups: readonly ConnectedServiceAuthGroupV1[];
}>): ConnectedServiceUsageSourceV1[] {
  if (input.profiles.serviceId !== input.serviceId) {
    throw new Error('Connected service profile inventory returned a mismatched service');
  }
  const sources = input.profiles.profiles.map((profile) => ConnectedServiceUsageSourceV1Schema.parse({
    serviceId: input.serviceId,
    profileId: profile.profileId,
    bindingKind: 'profile',
  }));
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

async function listCurrentSources(input: Readonly<{
  serviceIds: readonly ConnectedServiceId[];
  api: Pick<CurrentSourceApi, 'listConnectedServiceProfiles' | 'listConnectedServiceAuthGroups'>;
}>): Promise<ConnectedServiceUsageSourceV1[]> {
  const inventories = await Promise.all(input.serviceIds.map(async (serviceId) => {
    const [profiles, groups] = await Promise.all([
      input.api.listConnectedServiceProfiles({ serviceId, forceRefresh: true }),
      input.api.listConnectedServiceAuthGroups({ serviceId }),
    ]);
    return buildCurrentSources({ serviceId, profiles, groups });
  }));
  return [...new Map(inventories.flat().map((source) => [
    buildProviderAccountUsageCurrentSourceKey(source), source,
  ])).values()];
}

async function resolveSources(input: Readonly<{
  sources: readonly ConnectedServiceUsageSourceV1[];
  resolve: CurrentSourceApi['resolveProviderAccountUsageSource'];
}>): Promise<Map<string, SourceResolution>> {
  const resolutions = new Array<SourceResolution>(input.sources.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const workerCount = Math.min(input.sources.length, CURRENT_SOURCE_RESOLUTION_CONCURRENCY);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!failed && nextIndex < input.sources.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        resolutions[index] = await input.resolve({ source: input.sources[index]! });
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }));
  if (failed) throw firstError;
  return new Map(input.sources.map((source, index) => [
    buildProviderAccountUsageCurrentSourceKey(source),
    resolutions[index] ?? null,
  ]));
}

function inventoriesMatch(
  first: readonly ConnectedServiceUsageSourceV1[],
  second: readonly ConnectedServiceUsageSourceV1[],
): boolean {
  if (first.length !== second.length) return false;
  const keys = new Set(second.map(buildProviderAccountUsageCurrentSourceKey));
  return first.every((source) => keys.has(buildProviderAccountUsageCurrentSourceKey(source)));
}

function resolutionMatches(first: NonNullable<SourceResolution>, second: SourceResolution): boolean {
  return second !== null
    && buildProviderAccountUsageCurrentSourceKey(first.source) === buildProviderAccountUsageCurrentSourceKey(second.source)
    && first.recordId === second.recordId
    && first.providerAccountId.trim() === second.providerAccountId.trim();
}

/** Hydrates only from the exact current connected-service inventory, committing atomically after revalidation. */
export async function hydrateProviderAccountUsageStoreFromConnectedServiceInventory(input: Readonly<{
  serviceIds: Iterable<ConnectedServiceId>;
  api: CurrentSourceApi;
  credentials: Credentials;
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot'>;
  nowMs: number;
  randomBytes?: (length: number) => Uint8Array;
}>): Promise<ConnectedServiceCurrentSourceHydrationResult> {
  const serviceIds = [...new Set([...input.serviceIds].map((id) => ConnectedServiceIdSchema.parse(id)))];
  const sources = await listCurrentSources({ serviceIds, api: input.api });
  const firstResolutions = await resolveSources({
    sources,
    resolve: async (params) => await input.api.resolveProviderAccountUsageSource(params),
  });
  const stagingStore = createProviderAccountUsageStore();
  const hydration = await hydrateProviderAccountUsageStoreFromCurrentSources({
    sources,
    resolveRecordIdForSource: async (source) => {
      const resolution = firstResolutions.get(buildProviderAccountUsageCurrentSourceKey(source)) ?? null;
      return resolution ? {
        recordId: resolution.recordId,
        providerAccountId: resolution.providerAccountId,
        fetchedAt: resolution.fetchedAt,
        staleAfterMs: resolution.staleAfterMs,
      } : null;
    },
    api: input.api,
    credentials: input.credentials,
    store: stagingStore,
    nowMs: input.nowMs,
    ...(input.randomBytes ? { randomBytes: input.randomBytes } : {}),
  });
  const currentSources = await listCurrentSources({ serviceIds, api: input.api });
  if (!inventoriesMatch(sources, currentSources)) {
    throw new Error('Connected service provider-account usage inventory changed during hydration');
  }
  const secondResolutions = await resolveSources({
    sources,
    resolve: async (params) => await input.api.resolveProviderAccountUsageSource(params),
  });
  for (const source of sources) {
    const key = buildProviderAccountUsageCurrentSourceKey(source);
    const first = firstResolutions.get(key) ?? null;
    if (first && !resolutionMatches(first, secondResolutions.get(key) ?? null)) {
      throw new Error('Connected service provider-account usage source changed during hydration');
    }
  }
  for (const recordId of hydration.hydratedRecordIds) {
    const snapshot = stagingStore.resolveRecordId(recordId);
    if (!snapshot) throw new Error('Provider-account usage hydration staging record is missing');
    input.store.recordSnapshot(snapshot, {
      sources: hydration.dispositions.flatMap((item) => item.recordId === recordId ? [item.source] : []),
    });
  }
  return { sources, hydration };
}
