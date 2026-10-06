import axios from 'axios';

import { listSecretReferenceOverlayV1BindingNames, readSecretReferenceOverlayV1Reference } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { FeaturesResponse, SavedSecretResourceMaterialV1, SecretReferenceOverlayV1 } from '@happier-dev/protocol';

import { decodeBase64 } from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentials } from '@/persistence';
import {
  beginActiveSavedSecretCatalogRefresh,
  commitActiveSavedSecretCatalog,
  disableActiveSavedSecretCatalog,
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  resolveActiveSavedSecretCatalogCollisionState,
  withdrawActiveSavedSecretCatalog,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { deriveKey } from '@/utils/deriveKey';
import {
  createSavedSecretMaterializerFromSnapshotV1,
  type SavedSecretResolutionFailureStatusV1,
  type SavedSecretCatalogResourceInputV1,
  type SavedSecretCatalogState,
} from './savedSecretCatalog';

export type HydratedSavedSecretCatalog = Readonly<{
  resources: readonly SavedSecretCatalogResourceInputV1[];
  state: Exclude<SavedSecretCatalogState, 'temporarily_unavailable'>;
}>;

export type SavedSecretOperationAdmissionFailureReason =
  | 'reference_missing'
  | 'reference_unavailable'
  | 'reference_forbidden'
  | 'reference_deleted'
  | 'reference_mode_incompatible'
  | 'reference_repair_required'
  | 'reference_corrupt'
  | 'reference_stale'
  | 'reference_collision_migration_required';

/** Maps canonical materializer/admission failures to the consumer status vocabulary. */
export function savedSecretOperationAdmissionStatus(
  reason: SavedSecretOperationAdmissionFailureReason,
): SavedSecretResolutionFailureStatusV1 {
  switch (reason) {
    case 'reference_missing':
      return 'missing';
    case 'reference_unavailable':
      return 'temporarily_unavailable';
    case 'reference_forbidden':
      return 'forbidden';
    case 'reference_deleted':
      return 'deleted';
    case 'reference_mode_incompatible':
      return 'mode_incompatible';
    case 'reference_repair_required':
    case 'reference_stale':
    case 'reference_collision_migration_required':
      return 'repair_required';
    case 'reference_corrupt':
      return 'corrupt';
  }
}

function savedSecretOperationAdmissionReason(
  status: SavedSecretResolutionFailureStatusV1,
): SavedSecretOperationAdmissionFailureReason {
  switch (status) {
    case 'missing':
      return 'reference_missing';
    case 'temporarily_unavailable':
      return 'reference_unavailable';
    case 'forbidden':
      return 'reference_forbidden';
    case 'deleted':
      return 'reference_deleted';
    case 'mode_incompatible':
      return 'reference_mode_incompatible';
    case 'repair_required':
      return 'reference_repair_required';
    case 'corrupt':
      return 'reference_corrupt';
  }
}

export type SavedSecretOperationReferenceV1 = Readonly<{
  ref: string;
  revision?: number;
}>;

export class SavedSecretOperationAdmissionError extends Error {
  readonly reason: SavedSecretOperationAdmissionFailureReason;
  readonly reference: string;

  constructor(input: Readonly<{
    reason: SavedSecretOperationAdmissionFailureReason;
    reference: string;
  }>) {
    super(`Saved Secret operation reference is ${input.reason}`);
    this.name = 'SavedSecretOperationAdmissionError';
    this.reason = input.reason;
    this.reference = input.reference;
  }
}

type HealthySavedSecretResourceMaterialV1 = Extract<
  SavedSecretResourceMaterialV1,
  Readonly<{ resourceId: string }>
>;

function isHealthySavedSecretResourceMaterialV1(
  row: SavedSecretResourceMaterialV1,
): row is HealthySavedSecretResourceMaterialV1 {
  return 'resourceId' in row;
}

async function accountContentPrivateKey(token: string): Promise<Uint8Array | null> {
  const credentials = await readStoredCredentials().catch(() => null);
  if (!credentials || credentials.token !== token || !credentials.encryption) return null;
  return credentials.encryption.type === 'dataKey'
    ? credentials.encryption.machineKey
    : deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']);
}

/** Hydrates authorized full material into the existing active Account snapshot. */
export async function hydrateSavedSecretCatalog(input: Readonly<{
  token: string;
  serverFeatures: FeaturesResponse | null;
  signal?: AbortSignal;
}>): Promise<HydratedSavedSecretCatalog> {
  const scopeKey = resolveAccountSettingsScopeKeyForToken(input.token);
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!input.serverFeatures || readServerEnabledBit(input.serverFeatures, 'teams') !== true) {
    if (snapshot?.scopeKey === scopeKey) {
      disableActiveSavedSecretCatalog({
        scopeKey,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      });
    }
    return Object.freeze({
      resources: Object.freeze([]),
      state: 'disabled',
    });
  }
  if (!snapshot || snapshot.scopeKey !== scopeKey) throw new Error('saved_secret_account_snapshot_unavailable');
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  // A refresh is an authorization observation boundary. Keep display metadata
  // for recovery, but retire all opened material before waiting on the Home.
  // Listeners are woken once, by the refresh's outcome, and only when the
  // authorized catalog changed.
  beginActiveSavedSecretCatalogRefresh({ scopeKey, lifetimeToken });
  let settled = false;
  try {
    const response = await axios.get(
      `${resolveServerHttpBaseUrl()}/v1/account/saved-secrets/resources/materials`,
      {
        headers: {
          Authorization: `Bearer ${input.token}`,
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        },
        signal: input.signal,
        timeout: 15_000,
        validateStatus: () => true,
      },
    );
    if (response.status === 404) {
      const resources: readonly SavedSecretCatalogResourceInputV1[] = Object.freeze([]);
      if (!commitActiveSavedSecretCatalog({ scopeKey, lifetimeToken, resources, state: 'ready' })) {
        throw new Error('saved_secret_account_lifetime_changed');
      }
      settled = true;
      return Object.freeze({ resources, state: 'ready' });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`saved_secret_catalog_http_${response.status}`);
    }
    const parsed = SavedSecretResourceMaterialsResponseV1Schema.parse(response.data);
    // Corrupt rows intentionally expose only row-local repair metadata. They have
    // no canonical resource reference or material envelope and therefore cannot
    // participate in the CLI's materialization snapshot.
    const materialRows = parsed.resources.filter(isHealthySavedSecretResourceMaterialV1);
    const privateKey = materialRows.some((row) => row.encryptionMode === 'e2ee')
      ? await accountContentPrivateKey(input.token)
      : null;
    const resources: SavedSecretCatalogResourceInputV1[] = materialRows.map((row) => {
      const resourceDataKey = row.encryptionMode === 'e2ee' && row.recipientEnvelope && privateKey
        ? openEncryptedDataKeyEnvelopeV1({
          envelope: decodeBase64(row.recipientEnvelope.encryptedDataKey),
          recipientSecretKeyOrSeed: privateKey,
        })
        : null;
      return {
        resourceId: row.resourceId,
        ownerAccountId: row.entry.ownerAccountId ?? '',
        displayName: row.entry.name,
        kind: row.entry.kind ?? 'other',
        encryptionMode: row.encryptionMode,
        revision: row.entry.revision ?? 1,
        storedContent: row.storedContent,
        materialStatus: row.entry.materialStatus,
        ...(resourceDataKey ? { resourceDataKey } : {}),
      };
    });
    if (!commitActiveSavedSecretCatalog({ scopeKey, lifetimeToken, resources, state: 'ready' })) {
      throw new Error('saved_secret_account_lifetime_changed');
    }
    settled = true;
    return Object.freeze({ resources: Object.freeze(resources), state: 'ready' });
  } finally {
    // Any unsettled refresh (transport failure, non-success or malformed Home
    // answer, unopenable envelope) ends with the fail-closed state published.
    if (!settled) withdrawActiveSavedSecretCatalog({ scopeKey, lifetimeToken });
  }
}

/**
 * Refreshes the canonical shared-material snapshot at a Session/Execution Run
 * operation boundary. AccountChange is only a wake-up hint, so a launch must
 * not treat a previously hydrated row as current authorization after a missed
 * hint. Callers pass their canonical effective reference batch (or the
 * Execution Run's value-free overlay); personal-only batches stay entirely
 * within Account Settings and do not require a Home catalog request.
 */
export async function refreshSavedSecretCatalogForOperation(input: Readonly<{
  expectedScopeKey: string;
  secretReferenceOverlay?: SecretReferenceOverlayV1;
  references?: readonly SavedSecretOperationReferenceV1[];
  signal?: AbortSignal;
}>): Promise<NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>> {
  const secretReferenceOverlay = input.secretReferenceOverlay;
  const requestedReferences: readonly SavedSecretOperationReferenceV1[] = Object.freeze([
    ...(input.references ?? []),
    ...(secretReferenceOverlay
      ? listSecretReferenceOverlayV1BindingNames(secretReferenceOverlay)
        .map((name) => readSecretReferenceOverlayV1Reference(
          secretReferenceOverlay,
          name,
        ))
        .filter((reference): reference is SavedSecretOperationReferenceV1 => reference !== null)
      : []),
  ]);
  const current = getActiveAccountSettingsSnapshot();
  if (!current || current.scopeKey !== input.expectedScopeKey) {
    throw new Error('saved_secret_account_snapshot_unavailable');
  }
  const collisionRefs = new Set(
    resolveActiveSavedSecretCatalogCollisionState(current).collisions.map((collision) => collision.ref),
  );
  for (const reference of requestedReferences) {
    if (reference.revision !== undefined && collisionRefs.has(reference.ref)) {
      throw new SavedSecretOperationAdmissionError({
        reason: 'reference_collision_migration_required',
        reference: reference.ref,
      });
    }
  }
  const sharedReferences = requestedReferences.filter(
    (reference) => !collisionRefs.has(reference.ref)
      && parseSavedSecretRefV1(reference.ref).kind === 'shared_resource',
  );
  if (sharedReferences.length === 0) return current;

  const credentials = await readStoredCredentials().catch(() => null);
  if (
    !credentials
    || resolveAccountSettingsScopeKeyForToken(credentials.token)
      !== input.expectedScopeKey
  ) {
    throw new Error('saved_secret_account_credentials_unavailable');
  }
  await hydrateSavedSecretCatalog({
    token: credentials.token,
    serverFeatures: await fetchServerFeaturesSnapshot({
      serverUrl: resolveServerHttpBaseUrl(),
      token: credentials.token,
      projection: 'authenticated',
      ...(input.signal ? { signal: input.signal } : {}),
    }).then((snapshot) => snapshot.status === 'ready' ? snapshot.features : null),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const refreshed = getActiveAccountSettingsSnapshot();
  if (
    !refreshed
    || refreshed.scopeKey !== input.expectedScopeKey
    || refreshed.savedSecretCatalogState !== 'ready'
  ) {
    throw new Error('saved_secret_catalog_refresh_unavailable');
  }
  const materializer = createSavedSecretMaterializerFromSnapshotV1(refreshed);
  for (const reference of sharedReferences) {
    if (resolveActiveSavedSecretCatalogCollisionState(refreshed).collisions.some(
      (collision) => collision.ref === reference.ref,
    )) {
      throw new SavedSecretOperationAdmissionError({
        reason: 'reference_collision_migration_required',
        reference: reference.ref,
      });
    }
    if (
      reference.revision !== undefined
      && !materializer.matchesSharedResourceRevision(reference.ref, reference.revision)
    ) {
      throw new SavedSecretOperationAdmissionError({
        reason: 'reference_stale',
        reference: reference.ref,
      });
    }
    const resolved = materializer.resolve(reference.ref);
    if (resolved.status !== 'ready') {
      throw new SavedSecretOperationAdmissionError({
        reason: savedSecretOperationAdmissionReason(resolved.status),
        reference: reference.ref,
      });
    }
  }
  return refreshed;
}
