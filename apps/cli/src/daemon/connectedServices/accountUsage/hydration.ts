import {
  ConnectedServiceUsageSourceV1Schema,
  ProviderAccountUsageRecordIdSchema,
  QualifiedConnectedServiceUsageSourceV4Schema,
  openProviderAccountUsageSnapshotCiphertext,
  parseBuiltInLegacyProviderAccountUsageSnapshotV1,
  parseQualifiedPluginContributionKey,
  readBuiltInLegacyConnectedServiceIdForQualifiedService,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
  type QualifiedConnectedServiceUsageSourceV4,
} from '@happier-dev/protocol';
import { isConnectedServiceUsageProviderCompatible } from '@happier-dev/agents';

import {
  ConnectedServiceStoredContentUnavailableError,
} from '@/cloud/connectedServices/connectedServiceStoredContentUnavailable';
import { AccountStoredContentClientUpgradeRequiredError } from '@/api/clientCompatibility/accountStoredContentActivation';
import type { StoredCredentials } from '@/persistence';

import type { ProviderAccountUsageStore } from './store';

type ProviderAccountUsageV4Record = Readonly<{
  content:
    | Readonly<{ t: 'plain'; v: unknown }>
    | Readonly<{ t: 'encrypted'; c: string }>;
  metadata: Readonly<{
    fetchedAt: number;
    staleAfterMs: number;
    status: 'ok' | 'unavailable' | 'estimated' | 'error';
  }>;
  sources: readonly QualifiedConnectedServiceUsageSourceV4[];
}>;

export type ProviderAccountUsageHydrationApi = Readonly<{
  getAccountEncryptionMode?: () => Promise<'plain' | 'e2ee' | 'unknown'>;
  readProviderAccountUsageRecord: (args: Readonly<{
    recordId: ProviderAccountUsageRecordId;
  }>) => Promise<ProviderAccountUsageV4Record | null>;
}>;

/**
 * The local store's canonical source keys use the qualified Connected Account
 * service identity, and its source truth comes only from this qualified V4 pair.
 */
export type ProviderAccountUsageHydrationSource = Readonly<{
  localSource: ConnectedServiceUsageSourceV1;
  qualifiedSource: QualifiedConnectedServiceUsageSourceV4;
}>;

export type ProviderAccountUsageCurrentSourceResolution = Readonly<{
  source: QualifiedConnectedServiceUsageSourceV4;
  recordId: ProviderAccountUsageRecordId;
  providerAccountId: string;
  fetchedAt: number | null;
  staleAfterMs: number | null;
}>;

function accountScopedMaterial(
  credentials: StoredCredentials,
): Parameters<typeof openProviderAccountUsageSnapshotCiphertext>[0]['material'] | null {
  if (!credentials.encryption) return null;
  return credentials.encryption.type === 'legacy'
    ? { type: 'legacy', secret: credentials.encryption.secret }
    : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function parseProviderAccountUsageSnapshot(value: unknown): ProviderAccountUsageSnapshotV1 | null {
  try {
    return parseBuiltInLegacyProviderAccountUsageSnapshotV1(value);
  } catch {
    return null;
  }
}

function parseProviderAccountUsageSnapshotForRecordId(input: Readonly<{
  value: unknown;
  recordId: ProviderAccountUsageRecordId;
}>): ProviderAccountUsageSnapshotV1 {
  const snapshot = parseProviderAccountUsageSnapshot(input.value);
  if (!snapshot || snapshot.recordId !== input.recordId) {
    throw new ConnectedServiceStoredContentUnavailableError(
      'provider_account_usage_snapshot',
      'stored_content_corrupt',
      { recordId: input.recordId },
    );
  }
  return snapshot;
}

function sameQualifiedUsageSource(
  leftInput: QualifiedConnectedServiceUsageSourceV4,
  rightInput: QualifiedConnectedServiceUsageSourceV4,
): boolean {
  const left = QualifiedConnectedServiceUsageSourceV4Schema.parse(leftInput);
  const right = QualifiedConnectedServiceUsageSourceV4Schema.parse(rightInput);
  if (
    left.ref.service.pluginId !== right.ref.service.pluginId
    || left.ref.service.localId !== right.ref.service.localId
    || left.ref.accountId !== right.ref.accountId
    || left.bindingKind !== right.bindingKind
  ) {
    return false;
  }
  if (left.bindingKind === 'account') return true;
  if (right.bindingKind !== 'group_member') return false;
  return left.groupId === right.groupId
    && (left.groupGeneration ?? null) === (right.groupGeneration ?? null);
}

type HydratedProviderAccountUsageSnapshot = Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  sources: readonly QualifiedConnectedServiceUsageSourceV4[];
}>;

async function resolveAccountEncryptionModeForHydration(
  api: ProviderAccountUsageHydrationApi,
): Promise<'plain' | 'e2ee' | 'unknown'> {
  if (!api.getAccountEncryptionMode) return 'unknown';
  try {
    return await api.getAccountEncryptionMode();
  } catch (error) {
    if (error instanceof AccountStoredContentClientUpgradeRequiredError) {
      throw error;
    }
    return 'unknown';
  }
}

function parseQualifiedUsageSources(
  value: unknown,
): readonly QualifiedConnectedServiceUsageSourceV4[] {
  const parsed = QualifiedConnectedServiceUsageSourceV4Schema.array().safeParse(
    value,
  );
  return parsed.success ? parsed.data : [];
}

async function openProviderAccountUsageSnapshotForHydration(input: Readonly<{
  api: ProviderAccountUsageHydrationApi;
  credentials: StoredCredentials;
  recordId: ProviderAccountUsageRecordId;
  accountEncryptionMode: 'plain' | 'e2ee' | 'unknown';
}>): Promise<HydratedProviderAccountUsageSnapshot | null> {
  const response = await input.api.readProviderAccountUsageRecord({
    recordId: input.recordId,
  });
  if (!response) return null;
  if (input.accountEncryptionMode === 'plain') {
    if (response.content.t !== 'plain') {
      throw new ConnectedServiceStoredContentUnavailableError(
        'provider_account_usage_snapshot',
        'stored_content_corrupt',
        { recordId: input.recordId },
      );
    }
    return {
      snapshot: parseProviderAccountUsageSnapshotForRecordId({
        value: response.content.v,
        recordId: input.recordId,
      }),
      sources: parseQualifiedUsageSources(response.sources),
    };
  }
  if (input.accountEncryptionMode !== 'e2ee') {
    throw new ConnectedServiceStoredContentUnavailableError(
      'provider_account_usage_snapshot',
      'account_mode_unavailable',
      { recordId: input.recordId },
    );
  }
  if (response.content.t !== 'encrypted') {
    throw new ConnectedServiceStoredContentUnavailableError(
      'provider_account_usage_snapshot',
      'stored_content_corrupt',
      { recordId: input.recordId },
    );
  }
  const material = accountScopedMaterial(input.credentials);
  if (!material) {
    throw new ConnectedServiceStoredContentUnavailableError(
      'provider_account_usage_snapshot',
      'encryption_material_unavailable',
      { recordId: input.recordId },
    );
  }
  let openedValue: unknown = null;
  try {
    openedValue = openProviderAccountUsageSnapshotCiphertext({
      material,
      ciphertext: response.content.c,
    })?.value;
  } catch {
    throw new ConnectedServiceStoredContentUnavailableError(
      'provider_account_usage_snapshot',
      'stored_content_corrupt',
      { recordId: input.recordId },
    );
  }
  if (!openedValue) {
    throw new ConnectedServiceStoredContentUnavailableError(
      'provider_account_usage_snapshot',
      'stored_content_corrupt',
      { recordId: input.recordId },
    );
  }
  return {
    snapshot: parseProviderAccountUsageSnapshotForRecordId({
      value: openedValue,
      recordId: input.recordId,
    }),
    sources: parseQualifiedUsageSources(response.sources),
  };
}

export type ProviderAccountUsageCurrentSourceHydrationDisposition = Readonly<{
  source: ConnectedServiceUsageSourceV1;
  status: 'hydrated_fresh' | 'hydrated_stale' | 'missing' | 'ownership_unproven';
  recordId?: ProviderAccountUsageRecordId;
}>;

export function buildProviderAccountUsageCurrentSourceKey(source: ConnectedServiceUsageSourceV1): string {
  const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
  return parsed.bindingKind === 'profile'
    ? JSON.stringify([parsed.serviceId, parsed.profileId, 'profile'])
    : JSON.stringify([
      parsed.serviceId,
      parsed.profileId,
      'group_member',
      parsed.groupId,
      parsed.groupGeneration ?? null,
    ]);
}

/**
 * Adapter seam for the bundled Agents ownership helper: it decides against
 * released scalar `supportedServiceIds`, while the local store's canonical
 * source keys are qualified contribution keys. A recognized built-in qualified
 * service is projected to its sole Protocol-owned released scalar inverse
 * before the ownership decision; a scalar key is preserved, and a qualified key
 * with no built-in inverse stays qualified so a direct
 * `providerId === serviceId` match can still prove ownership instead of
 * collapsing arbitrary local ids onto some scalar.
 */
function isProviderCompatibleWithConnectedServiceSource(input: Readonly<{
  providerId: string;
  source: ConnectedServiceUsageSourceV1;
}>): boolean {
  const qualified = parseQualifiedPluginContributionKey(input.source.serviceId);
  if (!qualified) {
    return isConnectedServiceUsageProviderCompatible({
      providerId: input.providerId,
      serviceId: input.source.serviceId,
    });
  }
  const legacyServiceId = readBuiltInLegacyConnectedServiceIdForQualifiedService(qualified);
  return isConnectedServiceUsageProviderCompatible({
    providerId: input.providerId,
    serviceId: legacyServiceId ?? input.source.serviceId,
  });
}

/**
 * Passively reconstructs canonical PAU state for exact V4 source links. The
 * scalar source is installed only as a local consumer projection after the
 * qualified record, record resolution, provider identity, and freshness agree.
 */
export async function hydrateProviderAccountUsageStoreFromCurrentSources(input: Readonly<{
  sources: Iterable<ProviderAccountUsageHydrationSource>;
  resolveRecordIdForSource: (
    source: QualifiedConnectedServiceUsageSourceV4,
  ) => Promise<ProviderAccountUsageCurrentSourceResolution | null>;
  api: ProviderAccountUsageHydrationApi;
  credentials: StoredCredentials;
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot'>;
  nowMs: number;
}>): Promise<Readonly<{
  hydratedRecordIds: ProviderAccountUsageRecordId[];
  dispositions: ProviderAccountUsageCurrentSourceHydrationDisposition[];
  refreshSources: ConnectedServiceUsageSourceV1[];
}>> {
  const sourcesByKey = new Map<string, ProviderAccountUsageHydrationSource>();
  for (const rawSource of input.sources) {
    const local = ConnectedServiceUsageSourceV1Schema.safeParse(
      rawSource.localSource,
    );
    const qualified = QualifiedConnectedServiceUsageSourceV4Schema.safeParse(
      rawSource.qualifiedSource,
    );
    if (!local.success || !qualified.success) continue;
    sourcesByKey.set(buildProviderAccountUsageCurrentSourceKey(local.data), {
      localSource: local.data,
      qualifiedSource: qualified.data,
    });
  }

  const hydratedRecordIds = new Set<ProviderAccountUsageRecordId>();
  const dispositions: ProviderAccountUsageCurrentSourceHydrationDisposition[] = [];
  const refreshSources: ConnectedServiceUsageSourceV1[] = [];
  const snapshotsByRecordId = new Map<
    ProviderAccountUsageRecordId,
    HydratedProviderAccountUsageSnapshot | null
  >();
  const nowMs = Number.isFinite(input.nowMs)
    ? Math.max(0, Math.trunc(input.nowMs))
    : 0;
  const accountEncryptionMode = await resolveAccountEncryptionModeForHydration(
    input.api,
  );

  for (const source of sourcesByKey.values()) {
    const resolved = await input.resolveRecordIdForSource(
      source.qualifiedSource,
    ).catch(() => null);
    const parsedRecordId = ProviderAccountUsageRecordIdSchema.safeParse(
      resolved?.recordId,
    );
    const resolvedSource = QualifiedConnectedServiceUsageSourceV4Schema.safeParse(
      resolved?.source,
    );
    if (!parsedRecordId.success) {
      dispositions.push({ source: source.localSource, status: 'missing' });
      refreshSources.push(source.localSource);
      continue;
    }
    if (
      !resolvedSource.success
      || !sameQualifiedUsageSource(
        source.qualifiedSource,
        resolvedSource.data,
      )
    ) {
      dispositions.push({
        source: source.localSource,
        status: 'ownership_unproven',
      });
      refreshSources.push(source.localSource);
      continue;
    }

    let hydrated = snapshotsByRecordId.get(parsedRecordId.data);
    if (hydrated === undefined) {
      hydrated = await openProviderAccountUsageSnapshotForHydration({
        api: input.api,
        credentials: input.credentials,
        recordId: parsedRecordId.data,
        accountEncryptionMode,
      });
      snapshotsByRecordId.set(parsedRecordId.data, hydrated);
    }
    if (!hydrated) {
      dispositions.push({ source: source.localSource, status: 'missing' });
      refreshSources.push(source.localSource);
      continue;
    }

    const sourceProven = hydrated.sources.some((candidate) =>
      sameQualifiedUsageSource(candidate, source.qualifiedSource),
    );
    const providerAccountId = resolved?.providerAccountId.trim() ?? '';
    const accountIdentityProven = hydrated.snapshot.recordKey.subjectKind === 'account'
      && providerAccountId.length > 0
      && hydrated.snapshot.recordKey.accountSubjectId === providerAccountId;
    const freshnessProven = (resolved?.fetchedAt === null
      || resolved?.fetchedAt === hydrated.snapshot.fetchedAtMs)
      && (resolved?.staleAfterMs === null
        || resolved?.staleAfterMs === hydrated.snapshot.staleAfterMs);
    if (
      !sourceProven
      || !accountIdentityProven
      || !freshnessProven
      || !isProviderCompatibleWithConnectedServiceSource({
        providerId: hydrated.snapshot.providerId,
        source: source.localSource,
      })
    ) {
      dispositions.push({
        source: source.localSource,
        status: 'ownership_unproven',
      });
      refreshSources.push(source.localSource);
      continue;
    }

    input.store.recordSnapshot(hydrated.snapshot, {
      sources: [source.localSource],
    });
    hydratedRecordIds.add(parsedRecordId.data);
    const fetchedAtMs = resolved?.fetchedAt ?? hydrated.snapshot.fetchedAtMs;
    const staleAfterMs = resolved?.staleAfterMs ?? hydrated.snapshot.staleAfterMs;
    const isFresh = nowMs < fetchedAtMs + staleAfterMs;
    dispositions.push({
      source: source.localSource,
      status: isFresh ? 'hydrated_fresh' : 'hydrated_stale',
      recordId: parsedRecordId.data,
    });
    if (!isFresh) refreshSources.push(source.localSource);
  }

  return {
    hydratedRecordIds: [...hydratedRecordIds],
    dispositions,
    refreshSources,
  };
}
