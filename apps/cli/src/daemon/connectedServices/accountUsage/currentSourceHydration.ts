import {
  ConnectedServiceIdSchema,
  ConnectedServiceUsageSourceV1Schema,
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
  QualifiedConnectedAccountServiceRefSchema,
  QualifiedConnectedServiceUsageSourceV4Schema,
  type ConnectedServiceId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordId,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountServiceRef,
  type QualifiedConnectedServiceUsageSourceV4,
} from '@happier-dev/protocol';

import {
  resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import type { StoredCredentials } from '@/persistence';

import {
  buildProviderAccountUsageCurrentSourceKey,
  hydrateProviderAccountUsageStoreFromCurrentSources,
  type ProviderAccountUsageCurrentSourceHydrationDisposition,
  type ProviderAccountUsageCurrentSourceResolution,
  type ProviderAccountUsageHydrationApi,
  type ProviderAccountUsageHydrationSource,
} from './hydration';
import { createProviderAccountUsageStore, type ProviderAccountUsageStore } from './store';

type CurrentSourceApi = ProviderAccountUsageHydrationApi & Readonly<{
  listAccounts: (params: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
  }>) => Promise<Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    accounts: readonly QualifiedConnectedAccountProfileV4[];
  }>>;
  listGroups: (params: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
  }>) => Promise<Readonly<{
    groups: readonly QualifiedConnectedAccountGroupV4[];
  }>>;
  resolveSource: (params: Readonly<{
    source: QualifiedConnectedServiceUsageSourceV4;
  }>) => Promise<ProviderAccountUsageCurrentSourceResolution | null>;
}>;

type SourceResolution = Awaited<ReturnType<CurrentSourceApi['resolveSource']>>;

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

function sameQualifiedService(
  leftInput: QualifiedConnectedAccountServiceRef,
  rightInput: QualifiedConnectedAccountServiceRef,
): boolean {
  const left = QualifiedConnectedAccountServiceRefSchema.parse(leftInput);
  const right = QualifiedConnectedAccountServiceRefSchema.parse(rightInput);
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function buildQualifiedUsageSourceKey(
  sourceInput: QualifiedConnectedServiceUsageSourceV4,
): string {
  const source = QualifiedConnectedServiceUsageSourceV4Schema.parse(sourceInput);
  return source.bindingKind === 'account'
    ? JSON.stringify([
      source.ref.service.pluginId,
      source.ref.service.localId,
      source.ref.accountId,
      'account',
    ])
    : JSON.stringify([
      source.ref.service.pluginId,
      source.ref.service.localId,
      source.ref.accountId,
      'group_member',
      source.groupId,
      source.groupGeneration ?? null,
    ]);
}

function sourcePairsMatch(
  left: ProviderAccountUsageHydrationSource,
  right: ProviderAccountUsageHydrationSource,
): boolean {
  return buildProviderAccountUsageCurrentSourceKey(left.localSource)
    === buildProviderAccountUsageCurrentSourceKey(right.localSource)
    && buildQualifiedUsageSourceKey(left.qualifiedSource)
      === buildQualifiedUsageSourceKey(right.qualifiedSource);
}

function buildCurrentSources(input: Readonly<{
  serviceId: ConnectedServiceId;
  qualifiedService: QualifiedConnectedAccountServiceRef;
  accounts: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    accounts: readonly QualifiedConnectedAccountProfileV4[];
  }>;
  groups: Readonly<{ groups: readonly QualifiedConnectedAccountGroupV4[] }>;
}>): ProviderAccountUsageHydrationSource[] {
  const qualifiedService = QualifiedConnectedAccountServiceRefSchema.parse(
    input.qualifiedService,
  );
  const accountsService = QualifiedConnectedAccountServiceRefSchema.parse(
    input.accounts.service,
  );
  if (!sameQualifiedService(accountsService, qualifiedService)) {
    throw new Error('Qualified connected-account inventory returned a mismatched service');
  }

  const sources: ProviderAccountUsageHydrationSource[] = [];
  for (const rawAccount of input.accounts.accounts) {
    const account = QualifiedConnectedAccountProfileV4Schema.parse(rawAccount);
    if (!sameQualifiedService(account.ref.service, qualifiedService)) {
      throw new Error('Qualified connected-account profile inventory is inconsistent');
    }
    sources.push({
      localSource: ConnectedServiceUsageSourceV1Schema.parse({
        serviceId: input.serviceId,
        profileId: account.ref.accountId,
        bindingKind: 'profile',
      }),
      qualifiedSource: QualifiedConnectedServiceUsageSourceV4Schema.parse({
        ref: account.ref,
        bindingKind: 'account',
      }),
    });
  }

  for (const rawGroup of input.groups.groups) {
    const group = QualifiedConnectedAccountGroupV4Schema.parse(rawGroup);
    if (!sameQualifiedService(group.ref.service, qualifiedService)) {
      throw new Error('Qualified connected-account group inventory returned a mismatched service');
    }
    for (const member of group.members) {
      if (!member.enabled) continue;
      sources.push({
        localSource: ConnectedServiceUsageSourceV1Schema.parse({
          serviceId: input.serviceId,
          profileId: member.connectedAccountId,
          bindingKind: 'group_member',
          groupId: group.ref.groupId,
          groupGeneration: group.generation,
        }),
        qualifiedSource: QualifiedConnectedServiceUsageSourceV4Schema.parse({
          ref: {
            service: qualifiedService,
            accountId: member.connectedAccountId,
          },
          bindingKind: 'group_member',
          groupId: group.ref.groupId,
          groupGeneration: group.generation,
        }),
      });
    }
  }
  return sources;
}

async function listCurrentSources(input: Readonly<{
  serviceIds: readonly ConnectedServiceId[];
  api: Pick<CurrentSourceApi, 'listAccounts' | 'listGroups'>;
}>): Promise<ProviderAccountUsageHydrationSource[]> {
  const inventories = await Promise.all(input.serviceIds.map(async (serviceId) => {
    const qualifiedService = resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId(
      serviceId,
    );
    if (!qualifiedService) {
      throw new Error(`Connected-service PAU V4 identity is unavailable for ${serviceId}`);
    }
    const [accounts, groups] = await Promise.all([
      input.api.listAccounts({ service: qualifiedService }),
      input.api.listGroups({ service: qualifiedService }),
    ]);
    return buildCurrentSources({
      serviceId,
      qualifiedService,
      accounts,
      groups,
    });
  }));

  const sourcesByLocalKey = new Map<string, ProviderAccountUsageHydrationSource>();
  for (const source of inventories.flat()) {
    const localKey = buildProviderAccountUsageCurrentSourceKey(source.localSource);
    const existing = sourcesByLocalKey.get(localKey);
    if (existing && !sourcePairsMatch(existing, source)) {
      throw new Error('Connected-service PAU V4 inventory has conflicting source ownership');
    }
    sourcesByLocalKey.set(localKey, source);
  }
  return [...sourcesByLocalKey.values()];
}

async function resolveSources(input: Readonly<{
  sources: readonly ProviderAccountUsageHydrationSource[];
  resolve: CurrentSourceApi['resolveSource'];
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
        resolutions[index] = await input.resolve({
          source: input.sources[index]!.qualifiedSource,
        });
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
    buildQualifiedUsageSourceKey(source.qualifiedSource),
    resolutions[index] ?? null,
  ]));
}

function inventoriesMatch(
  first: readonly ProviderAccountUsageHydrationSource[],
  second: readonly ProviderAccountUsageHydrationSource[],
): boolean {
  if (first.length !== second.length) return false;
  const secondByLocalKey = new Map(second.map((source) => [
    buildProviderAccountUsageCurrentSourceKey(source.localSource),
    source,
  ]));
  return first.every((source) => {
    const current = secondByLocalKey.get(
      buildProviderAccountUsageCurrentSourceKey(source.localSource),
    );
    return current !== undefined && sourcePairsMatch(source, current);
  });
}

function resolutionMatches(
  first: NonNullable<SourceResolution>,
  second: SourceResolution,
): boolean {
  return second !== null
    && buildQualifiedUsageSourceKey(first.source)
      === buildQualifiedUsageSourceKey(second.source)
    && first.recordId === second.recordId
    && first.providerAccountId.trim() === second.providerAccountId.trim();
}

/** Hydrates only from the exact current V4 inventory, committing atomically after revalidation. */
export async function hydrateProviderAccountUsageStoreFromConnectedServiceInventory(input: Readonly<{
  serviceIds: Iterable<ConnectedServiceId>;
  api: CurrentSourceApi;
  credentials: StoredCredentials;
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot'>;
  nowMs: number;
}>): Promise<ConnectedServiceCurrentSourceHydrationResult> {
  const serviceIds = [...new Set([...input.serviceIds].map((id) => ConnectedServiceIdSchema.parse(id)))];
  const sources = await listCurrentSources({ serviceIds, api: input.api });
  const firstResolutions = await resolveSources({
    sources,
    resolve: async (params) => await input.api.resolveSource(params),
  });
  const stagingStore = createProviderAccountUsageStore();
  const hydration = await hydrateProviderAccountUsageStoreFromCurrentSources({
    sources,
    resolveRecordIdForSource: async (source) => (
      firstResolutions.get(buildQualifiedUsageSourceKey(source)) ?? null
    ),
    api: input.api,
    credentials: input.credentials,
    store: stagingStore,
    nowMs: input.nowMs,
  });
  const currentSources = await listCurrentSources({ serviceIds, api: input.api });
  if (!inventoriesMatch(sources, currentSources)) {
    throw new ConnectedServiceCurrentSourceHydrationConflictError(
      'Connected service provider-account usage inventory changed during hydration',
    );
  }
  const secondResolutions = await resolveSources({
    sources,
    resolve: async (params) => await input.api.resolveSource(params),
  });
  for (const source of sources) {
    const key = buildQualifiedUsageSourceKey(source.qualifiedSource);
    const first = firstResolutions.get(key) ?? null;
    if (first && !resolutionMatches(first, secondResolutions.get(key) ?? null)) {
      throw new ConnectedServiceCurrentSourceHydrationConflictError(
        'Connected service provider-account usage source changed during hydration',
      );
    }
  }
  for (const recordId of hydration.hydratedRecordIds) {
    const snapshot = stagingStore.resolveRecordId(recordId);
    if (!snapshot) throw new Error('Provider-account usage hydration staging record is missing');
    input.store.recordSnapshot(snapshot, {
      sources: hydration.dispositions.flatMap((item) => item.recordId === recordId ? [item.source] : []),
    });
  }
  return {
    sources: sources.map((source) => source.localSource),
    hydration,
  };
}
