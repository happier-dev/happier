import {
  ConnectedServiceUsageSourceV1Schema,
  ProviderAccountUsageRecordIdSchema,
  openProviderAccountUsageSnapshotCiphertext,
  parseBuiltInLegacyProviderAccountUsageSnapshotV1,
  resealProviderAccountUsageSnapshotCiphertextIfHistoricalAlias,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
  type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { isConnectedServiceUsageProviderCompatible } from '@happier-dev/agents';

import {
  ConnectedServiceStoredContentUnavailableError,
} from '@/cloud/connectedServices/connectedServiceStoredContentUnavailable';
import { AccountStoredContentClientUpgradeRequiredError } from '@/api/clientCompatibility/accountStoredContentActivation';
import type { StoredCredentials } from '@/persistence';

import type { ProviderAccountUsageStore } from './store';

type ProviderAccountUsageHydrationApi = Readonly<{
  getAccountEncryptionMode?: () => Promise<'plain' | 'e2ee' | 'unknown'>;
  getProviderAccountUsageSnapshotPlain?: (args: Readonly<{ recordId: ProviderAccountUsageRecordId }>) => Promise<
    | null
    | Readonly<{
        content: Readonly<{ t: 'plain'; v: ProviderAccountUsageSnapshotV1 }>;
        sources?: readonly ConnectedServiceUsageSourceV1[];
      }>
  >;
  getProviderAccountUsageSnapshotSealed?: (args: Readonly<{ recordId: ProviderAccountUsageRecordId }>) => Promise<
    | null
    | Readonly<{
        sealed: SealedProviderAccountUsageSnapshotV1;
        metadata?: Readonly<{
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          materialFingerprint?: string;
        }>;
        sources?: readonly ConnectedServiceUsageSourceV1[];
      }>
  >;
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

function parseConnectedServiceUsageSources(value: unknown): readonly ConnectedServiceUsageSourceV1[] {
  const parsed = ConnectedServiceUsageSourceV1Schema.array().safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

type HydratedProviderAccountUsageSnapshot = Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  sources: readonly ConnectedServiceUsageSourceV1[];
  historicalAliasReseal?: Readonly<{
    sealed: SealedProviderAccountUsageSnapshotV1;
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint: string;
    };
  }>;
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

function isProviderCompatibleWithConnectedServiceSource(input: Readonly<{
  providerId: string;
  source: ConnectedServiceUsageSourceV1;
}>): boolean {
  return isConnectedServiceUsageProviderCompatible({
    providerId: input.providerId,
    serviceId: input.source.serviceId,
  });
}

async function openPlainProviderAccountUsageSnapshot(input: Readonly<{
  api: ProviderAccountUsageHydrationApi;
  recordId: ProviderAccountUsageRecordId;
}>): Promise<HydratedProviderAccountUsageSnapshot | null> {
  if (!input.api.getProviderAccountUsageSnapshotPlain) return null;
  const response = await input.api.getProviderAccountUsageSnapshotPlain({
    recordId: input.recordId,
  });
  if (!response) return null;
  if (response.content?.t !== 'plain') {
    throw new ConnectedServiceStoredContentUnavailableError(
      'provider_account_usage_snapshot',
      'stored_content_corrupt',
      { recordId: input.recordId },
    );
  }
  const snapshot = parseProviderAccountUsageSnapshotForRecordId({
    value: response.content.v,
    recordId: input.recordId,
  });
  return {
    snapshot,
    sources: parseConnectedServiceUsageSources(response.sources),
  };
}

async function openSealedProviderAccountUsageSnapshot(input: Readonly<{
  api: ProviderAccountUsageHydrationApi;
  credentials: StoredCredentials;
  recordId: ProviderAccountUsageRecordId;
  randomBytes?: (length: number) => Uint8Array;
}>): Promise<HydratedProviderAccountUsageSnapshot | null> {
  if (!input.api.getProviderAccountUsageSnapshotSealed) return null;
  const response = await input.api.getProviderAccountUsageSnapshotSealed({
    recordId: input.recordId,
  });
  if (!response) return null;
  const ciphertext = response?.sealed?.ciphertext;
  if (!ciphertext) {
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
  let resealed: ReturnType<
    typeof resealProviderAccountUsageSnapshotCiphertextIfHistoricalAlias
  > = null;
  let openedValue: unknown = null;
  try {
    resealed = input.randomBytes
      ? resealProviderAccountUsageSnapshotCiphertextIfHistoricalAlias({
          material,
          ciphertext,
          randomBytes: input.randomBytes,
        })
      : null;
    openedValue = resealed
      ? resealed.snapshot
      : openProviderAccountUsageSnapshotCiphertext({
          material,
          ciphertext,
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
  const snapshot = parseProviderAccountUsageSnapshotForRecordId({
    value: openedValue,
    recordId: input.recordId,
  });
  return {
    snapshot,
    sources: parseConnectedServiceUsageSources(response.sources),
    ...(resealed?.resealed
      && response.metadata?.materialFingerprint
      ? {
          historicalAliasReseal: {
            sealed: {
              format: 'account_scoped_v1',
              ciphertext: resealed.ciphertext,
            },
            metadata: {
              fetchedAt: response.metadata.fetchedAt,
              staleAfterMs: response.metadata.staleAfterMs,
              status: response.metadata.status,
              materialFingerprint:
                response.metadata.materialFingerprint,
            },
          },
        }
      : {}),
  };
}

async function openProviderAccountUsageSnapshotForHydration(input: Readonly<{
  api: ProviderAccountUsageHydrationApi;
  credentials: StoredCredentials;
  recordId: ProviderAccountUsageRecordId;
  accountEncryptionMode?: 'plain' | 'e2ee' | 'unknown';
  randomBytes?: (length: number) => Uint8Array;
}>): Promise<HydratedProviderAccountUsageSnapshot | null> {
  const mode = input.accountEncryptionMode
    ?? await resolveAccountEncryptionModeForHydration(input.api);
  if (mode === 'plain') {
    return await openPlainProviderAccountUsageSnapshot(input);
  }
  if (mode === 'e2ee') {
    return await openSealedProviderAccountUsageSnapshot(input);
  }
  throw new ConnectedServiceStoredContentUnavailableError(
    'provider_account_usage_snapshot',
    'account_mode_unavailable',
    { recordId: input.recordId },
  );
}

/**
 * Passively reconstructs canonical PAU state for the exact current connected-service sources.
 *
 * The source-to-record resolver is the authoritative server-relation boundary. Hydration still
 * requires the fetched record to return that exact active source, including group generation,
 * before installing either the snapshot or its source alias. This owner intentionally exposes
 * stale/missing sources as refresh work instead of polling, notifying policy, clearing recovery,
 * or switching accounts itself.
 */
export async function hydrateProviderAccountUsageStoreFromCurrentSources(input: Readonly<{
  sources: Iterable<ConnectedServiceUsageSourceV1>;
  resolveRecordIdForSource: (
    source: ConnectedServiceUsageSourceV1,
  ) => Promise<Readonly<{
    recordId: ProviderAccountUsageRecordId;
    providerAccountId: string;
    fetchedAt: number | null;
    staleAfterMs: number | null;
  }> | null>;
  api: ProviderAccountUsageHydrationApi;
  credentials: StoredCredentials;
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot'>;
  nowMs: number;
  randomBytes?: (length: number) => Uint8Array;
}>): Promise<Readonly<{
  hydratedRecordIds: ProviderAccountUsageRecordId[];
  dispositions: ProviderAccountUsageCurrentSourceHydrationDisposition[];
  refreshSources: ConnectedServiceUsageSourceV1[];
}>> {
  const sourcesByKey = new Map<string, ConnectedServiceUsageSourceV1>();
  for (const rawSource of input.sources) {
    const parsed = ConnectedServiceUsageSourceV1Schema.safeParse(rawSource);
    if (!parsed.success) continue;
    sourcesByKey.set(buildProviderAccountUsageCurrentSourceKey(parsed.data), parsed.data);
  }

  const hydratedRecordIds = new Set<ProviderAccountUsageRecordId>();
  const dispositions: ProviderAccountUsageCurrentSourceHydrationDisposition[] = [];
  const refreshSources: ConnectedServiceUsageSourceV1[] = [];
  const snapshotsByRecordId = new Map<ProviderAccountUsageRecordId, HydratedProviderAccountUsageSnapshot | null>();
  const resealedRecordIds = new Set<ProviderAccountUsageRecordId>();
  const nowMs = Number.isFinite(input.nowMs) ? Math.max(0, Math.trunc(input.nowMs)) : 0;
  const accountEncryptionMode = await resolveAccountEncryptionModeForHydration(
    input.api,
  );

  for (const source of sourcesByKey.values()) {
    const resolved = await input.resolveRecordIdForSource(source).catch(() => null);
    const parsedRecordId = ProviderAccountUsageRecordIdSchema.safeParse(resolved?.recordId);
    if (!parsedRecordId.success) {
      dispositions.push({ source, status: 'missing' });
      refreshSources.push(source);
      continue;
    }

    let hydrated = snapshotsByRecordId.get(parsedRecordId.data);
    if (hydrated === undefined) {
      hydrated = await openProviderAccountUsageSnapshotForHydration({
        api: input.api,
        credentials: input.credentials,
        recordId: parsedRecordId.data,
        accountEncryptionMode,
        ...(input.randomBytes ? { randomBytes: input.randomBytes } : {}),
      });
      snapshotsByRecordId.set(parsedRecordId.data, hydrated);
    }
    if (!hydrated) {
      dispositions.push({ source, status: 'missing' });
      refreshSources.push(source);
      continue;
    }

    const exactSourceKey = buildProviderAccountUsageCurrentSourceKey(source);
    const sourceProven = hydrated.sources.some(
      (candidate) => buildProviderAccountUsageCurrentSourceKey(candidate) === exactSourceKey,
    );
    const providerAccountId = resolved?.providerAccountId?.trim() ?? '';
    const accountIdentityProven = hydrated.snapshot.recordKey.subjectKind === 'account'
      && providerAccountId.length > 0
      && hydrated.snapshot.recordKey.accountSubjectId === providerAccountId;
    const freshnessProven = (resolved?.fetchedAt === null || resolved?.fetchedAt === hydrated.snapshot.fetchedAtMs)
      && (resolved?.staleAfterMs === null || resolved?.staleAfterMs === hydrated.snapshot.staleAfterMs);
    if (!sourceProven || !accountIdentityProven || !freshnessProven || !isProviderCompatibleWithConnectedServiceSource({
      providerId: hydrated.snapshot.providerId,
      source,
    })) {
      dispositions.push({ source, status: 'ownership_unproven' });
      refreshSources.push(source);
      continue;
    }

    if (
      hydrated.historicalAliasReseal
      && !resealedRecordIds.has(parsedRecordId.data)
    ) {
      if (!input.api.registerProviderAccountUsageSnapshotSealed) {
        throw new Error(
          'Provider account usage historical alias reseal route unavailable',
        );
      }
      await input.api.registerProviderAccountUsageSnapshotSealed({
        recordId: parsedRecordId.data,
        recordKey: hydrated.snapshot.recordKey,
        source,
        sealed: hydrated.historicalAliasReseal.sealed,
        metadata: hydrated.historicalAliasReseal.metadata,
      });
      resealedRecordIds.add(parsedRecordId.data);
    }

    input.store.recordSnapshot(hydrated.snapshot, { sources: [source] });
    hydratedRecordIds.add(parsedRecordId.data);
    const fetchedAtMs = resolved?.fetchedAt ?? hydrated.snapshot.fetchedAtMs;
    const staleAfterMs = resolved?.staleAfterMs ?? hydrated.snapshot.staleAfterMs;
    const staleAtMs = fetchedAtMs + staleAfterMs;
    const isFresh = nowMs < staleAtMs;
    dispositions.push({
      source,
      status: isFresh ? 'hydrated_fresh' : 'hydrated_stale',
      recordId: parsedRecordId.data,
    });
    if (!isFresh) refreshSources.push(source);
  }

  return {
    hydratedRecordIds: [...hydratedRecordIds],
    dispositions,
    refreshSources,
  };
}
