import * as z from 'zod/mini';
import { ConnectedServiceUsageSourceV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';
import { canRetainUsageReadFailure } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { isConnectedServiceQuotaObservationFresh } from '@happier-dev/protocol/connect/quotaObservationTime';
import { ProviderAccountUsageRecordIdSchema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { isProviderAccountUsageIdentityMatch, type ProviderAccountUsageOrganizationContext } from '@happier-dev/protocol/connect/accountUsage';
import type { PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/protocol';
import { openProviderAccountUsageEncryptedContentV4 } from '@happier-dev/protocol/connect/accountUsage';
import { parseBuiltInLegacyProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServiceUsageSourceV1, ProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1, QualifiedConnectedServiceUsageSourceV4, QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol';
import { isConnectedServiceUsageProviderCompatible } from '@happier-dev/agents';

import {
  ConnectedServiceStoredContentUnavailableError,
} from '@/cloud/connectedServices/connectedServiceStoredContentUnavailable';
import type { StoredCredentials } from '@/persistence';

import type { ProviderAccountUsageStore } from './store';
import { isProviderAccountUsageOwnershipRefusalCode } from './persistence';

type ProviderAccountUsageV4Record = Readonly<{
  content:
    | Readonly<{ t: 'plain'; v: unknown }>
    | Parameters<typeof openProviderAccountUsageEncryptedContentV4>[0]['content'];
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

export type ProviderAccountUsageUsageIdentityResolver = (
  service: QualifiedConnectedAccountServiceRef,
) => Promise<PluginConnectedAccountDescriptorContributionV2['usageIdentity'] | null>;

export type ProviderAccountUsageCurrentSourceIdentityResolver = (
  source: QualifiedConnectedServiceUsageSourceV4,
) => Promise<ProviderAccountUsageOrganizationContext | null>;

export type ProviderAccountUsageCurrentSourceResolution = Readonly<{
  source: QualifiedConnectedServiceUsageSourceV4;
  recordId: ProviderAccountUsageRecordId;
  providerAccountId: string;
  fetchedAt: number | null;
  staleAfterMs: number | null;
}>;

function accountScopedMaterial(
  credentials: StoredCredentials,
): Parameters<typeof openProviderAccountUsageEncryptedContentV4>[0]['material'] | null {
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
  } catch {
    return 'unknown';
  }
}

function parseQualifiedUsageSources(
  value: unknown,
): readonly QualifiedConnectedServiceUsageSourceV4[] {
  const parsed = createStoredReadSchema(z.array(QualifiedConnectedServiceUsageSourceV4Schema)).safeParse(
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
  let openedSnapshot: ProviderAccountUsageSnapshotV1 | null = null;
  try {
    openedSnapshot = openProviderAccountUsageEncryptedContentV4({
      material,
      content: response.content,
    });
  } catch {
    throw new ConnectedServiceStoredContentUnavailableError(
      'provider_account_usage_snapshot',
      'stored_content_corrupt',
      { recordId: input.recordId },
    );
  }
  if (!openedSnapshot) {
    throw new ConnectedServiceStoredContentUnavailableError(
      'provider_account_usage_snapshot',
      'stored_content_corrupt',
      { recordId: input.recordId },
    );
  }
  return {
    snapshot: parseProviderAccountUsageSnapshotForRecordId({
      value: openedSnapshot,
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
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'removeSource'>;
  nowMs: number;
  resolveUsageIdentity?: ProviderAccountUsageUsageIdentityResolver;
  resolveCurrentProviderAccountIdentityForSource?: ProviderAccountUsageCurrentSourceIdentityResolver;
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
  const refuseSource = (source: ProviderAccountUsageHydrationSource): void => {
    input.store.removeSource(source.localSource);
    dispositions.push({ source: source.localSource, status: 'ownership_unproven' });
    refreshSources.push(source.localSource);
  };

  for (const source of sourcesByKey.values()) {
    let resolved: ProviderAccountUsageCurrentSourceResolution | null;
    try {
      resolved = await input.resolveRecordIdForSource(source.qualifiedSource);
    } catch (error) {
      const code = readActionErrorCodeV1(error);
      if (!canRetainUsageReadFailure(code ?? undefined)) {
        if (!isProviderAccountUsageOwnershipRefusalCode(code)) {
          input.store.removeSource(source.localSource);
          throw error;
        }
        refuseSource(source);
        continue;
      }
      if (code) throw error;
      resolved = null;
    }
    const parsedRecordId = ProviderAccountUsageRecordIdSchema.safeParse(
      resolved?.recordId,
    );
    const resolvedSource = createStoredReadSchema(QualifiedConnectedServiceUsageSourceV4Schema).safeParse(
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
      refuseSource(source);
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
    let identityProven = false;
    let providerCompatible = false;
    try {
      const usageIdentity = await input.resolveUsageIdentity?.(source.qualifiedSource.ref.service);
      const current = input.resolveCurrentProviderAccountIdentityForSource
        ? await input.resolveCurrentProviderAccountIdentityForSource(source.qualifiedSource)
        : { providerAccountId: providerAccountId || null, providerOrganizationId: null };
      identityProven = isProviderAccountUsageIdentityMatch(hydrated.snapshot.recordKey, current, usageIdentity);
      providerCompatible = Boolean(usageIdentity?.providerId)
        || isProviderCompatibleWithConnectedServiceSource({ providerId: hydrated.snapshot.providerId, source: source.localSource });
    } catch {
      identityProven = false;
    }
    const freshnessProven = (resolved?.fetchedAt === null
      || resolved?.fetchedAt === hydrated.snapshot.fetchedAtMs)
      && (resolved?.staleAfterMs === null
        || resolved?.staleAfterMs === hydrated.snapshot.staleAfterMs);
    if (
      !sourceProven
      || !identityProven
      || !accountIdentityProven
      || !freshnessProven
      || !providerCompatible
    ) {
      refuseSource(source);
      continue;
    }

    input.store.recordSnapshot(hydrated.snapshot, {
      sources: [source.localSource],
    });
    hydratedRecordIds.add(parsedRecordId.data);
    const fetchedAtMs = resolved?.fetchedAt ?? hydrated.snapshot.fetchedAtMs;
    const staleAfterMs = resolved?.staleAfterMs ?? hydrated.snapshot.staleAfterMs;
    const isFresh = isConnectedServiceQuotaObservationFresh({
      observedAtMs: fetchedAtMs,
      nowMs,
      maxAgeMs: staleAfterMs,
    });
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
