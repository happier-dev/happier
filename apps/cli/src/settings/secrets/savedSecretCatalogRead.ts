import type { SavedSecretMaterializerV1 } from './savedSecretCatalog';
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import type { SavedSecretExternalAcquisitionV1 } from './savedSecretCatalog';
import type { SavedSecretResourceContentV1 } from '@happier-dev/protocol';
import type { SavedSecretExternalSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { MACHINE_NATIVE_SECRET_SOURCE_ACCESS_POLICY_V1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import axios from 'axios';

import { listSecretReferenceOverlayV1BindingNames, readSecretReferenceOverlayV1Reference } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { openEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1";

import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import type { FeaturesResponse, SavedSecretResourceMaterialV1, SecretReferenceOverlayV1 } from '@happier-dev/protocol';

import { decodeBase64 } from "@/api/encryption";

import { resolveServerHttpBaseUrl } from "@/api/client/serverHttpBaseUrl";

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';

import { beginActiveSavedSecretCatalogRefresh, commitActiveSavedSecretCatalog, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, resolveActiveSavedSecretCatalogCollisionState, withdrawActiveSavedSecretCatalog, type ActiveAccountSettingsSnapshot } from "@/settings/accountSettings/activeAccountSettingsSnapshot";
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { deriveKey } from '@/utils/deriveKey';
import { createSavedSecretMaterializerFromSnapshotV1, readSavedSecretRevisionsFromSnapshotV1, savedSecretOperationAdmissionReason, type SavedSecretOperationAdmissionFailureReason, type SavedSecretCatalogResourceInputV1, type SavedSecretCatalogState } from "./savedSecretCatalog";
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';

export type HydratedSavedSecretCatalog = Readonly<{
  resources: readonly SavedSecretCatalogResourceInputV1[];
  state: Exclude<SavedSecretCatalogState, 'temporarily_unavailable'>;
}>;

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

async function accountContentPrivateKey(token: string, suppliedCredentials?: StoredCredentials): Promise<Uint8Array | null> {
  const credentials = suppliedCredentials ?? await readStoredCredentials().catch(() => null);
  if (!credentials || credentials.token !== token || !credentials.encryption) return null;
  return credentials.encryption.type === 'dataKey'
    ? credentials.encryption.machineKey
    : deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']);
}

/** Hydrates through the admitted Account publication owner, active or invocation-local. */
export async function hydrateSavedSecretCatalog(input: Readonly<{
  token: string;
  serverFeatures: FeaturesResponse | null;
  signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
}>): Promise<HydratedSavedSecretCatalog> {
  const scopeKey = resolveAccountSettingsScopeKeyForToken(input.token);
  const context = input.operationContext;
  if (context && (context.credentials.token !== input.token || !await context.isCurrent())) {
    throw new Error('saved_secret_account_lifetime_changed');
  }
  const snapshot = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const lifetimeToken = context ? null : getActiveAccountSettingsSnapshotLifetimeToken();
  const commitCatalog = async (catalog: Readonly<{ resources: readonly SavedSecretCatalogResourceInputV1[]; state: SavedSecretCatalogState }>) => {
    if (input.signal?.aborted) return false;
    if (context) return await context.isCurrent() && context.commitCatalog(catalog);
    return commitActiveSavedSecretCatalog({ scopeKey, lifetimeToken: lifetimeToken!, ...catalog });
  };
  // The Home's resource owner authorizes personal and granted material.
  // Teams availability controls Team audiences, not private resource access.
  if (!snapshot || snapshot.scopeKey !== scopeKey) throw new Error('saved_secret_account_snapshot_unavailable');
  // A refresh is an authorization observation boundary. Keep display metadata
  // for recovery, but retire all opened material before waiting on the Home.
  // Listeners are woken once, by the refresh's outcome, and only when the
  // authorized catalog changed.
  if (!(context ? context.beginRefresh() : beginActiveSavedSecretCatalogRefresh({ scopeKey, lifetimeToken: lifetimeToken! }))) {
    throw new Error('saved_secret_account_lifetime_changed');
  }
  let settled = false;
  try {
    const response = await axios.get(
      `${context?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}/v1/account/saved-secrets/resources/materials`,
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
      if (!await commitCatalog({ resources, state: 'ready' })) {
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
      ? await accountContentPrivateKey(input.token, context?.credentials)
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
        relationship: row.entry.relationship,
        capabilities: { use: row.entry.capabilities.use },
        displayName: row.entry.name,
        kind: row.entry.kind ?? 'other',
        encryptionMode: row.encryptionMode,
        revision: row.entry.revision ?? 1,
        storedContent: row.storedContent,
        materialStatus: row.entry.materialStatus,
        ...(resourceDataKey ? { resourceDataKey } : {}),
      };
    });
    if (!await commitCatalog({ resources, state: 'ready' })) {
      for (const resource of resources) resource.resourceDataKey?.fill(0);
      throw new Error('saved_secret_account_lifetime_changed');
    }
    settled = true;
    return Object.freeze({ resources: Object.freeze(resources), state: 'ready' });
  } finally {
    // Any unsettled refresh (transport failure, non-success or malformed Home
    // answer, unopenable envelope) ends with the fail-closed state published.
    if (!settled) {
      if (context) context.withdrawCatalog();
      else withdrawActiveSavedSecretCatalog({ scopeKey, lifetimeToken: lifetimeToken! });
    }
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
export type SavedSecretCatalogRefreshInputV1 = Readonly<{
  expectedScopeKey: string;
  secretReferenceOverlay?: SecretReferenceOverlayV1;
  references?: readonly SavedSecretOperationReferenceV1[];
  signal?: AbortSignal;
  /** Resource imports need an authoritative absence/tombstone observation before create. */
  refreshCatalog?: boolean;
  operationContext?: SavedSecretOperationContextV1;
  /** Explicit editors pin their original source; unpinned demand loaders may rebase. */
  sourceExpectation?: Readonly<{ mode: 'plain' | 'e2ee'; raw: Readonly<Record<string, unknown>>; version: number }>;
}>;

export function readRequestedSavedSecretOperationReferences(input: SavedSecretCatalogRefreshInputV1): readonly SavedSecretOperationReferenceV1[] {
  const secretReferenceOverlay = input.secretReferenceOverlay;
  return Object.freeze([
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
}

/** Read/admit only: composite dispatch and importer share this cut without recursively importing. */
export async function readSavedSecretCatalogForOperation(input: SavedSecretCatalogRefreshInputV1): Promise<ActiveAccountSettingsSnapshot> {
  const requestedReferences = readRequestedSavedSecretOperationReferences(input);
  const context = input.operationContext;
  if (context && !await context.isCurrent()) throw new Error('saved_secret_account_lifetime_changed');
  const current = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
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
  if (sharedReferences.length === 0 && input.refreshCatalog !== true) return current;

  const credentials = context?.credentials ?? await readStoredCredentials().catch(() => null);
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
      serverUrl: context?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      token: credentials.token,
      projection: 'authenticated',
      ...(input.signal ? { signal: input.signal } : {}),
    }).then((snapshot) => snapshot.status === 'ready' ? snapshot.features : null),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(context ? { operationContext: context } : {}),
  });
  const refreshed = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  if (
    !refreshed
    || refreshed.scopeKey !== input.expectedScopeKey
    || refreshed.savedSecretCatalogState !== 'ready'
  ) {
    throw new Error('saved_secret_catalog_refresh_unavailable');
  }
  const materializer = createSavedSecretMaterializerFromSnapshotV1(refreshed,
    context ? { isCurrent: () => context.readSnapshot() === refreshed } : undefined);
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

/** Canonical row-write proof capture; it neither imports nor activates a domain. */
export async function captureSavedSecretReferencesForOperation(input: Readonly<{
  expectedScopeKey: string;
  references: readonly string[];
  operationContext?: SavedSecretOperationContextV1;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  referencedSavedSecretIds: string[];
  savedSecretRevisions: { resourceId: string; expectedRevision: number }[];
}>> {
  input.signal?.throwIfAborted();
  const references = [...new Set(input.references)];
  const context = input.operationContext;
  await readSavedSecretCatalogForOperation({ ...input, references: references.map(ref => ({ ref })) });
  input.signal?.throwIfAborted();
  if (context && !await context.isCurrent()) throw new Error('saved_secret_account_lifetime_changed');
  const snapshot = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  if (!snapshot || snapshot.scopeKey !== input.expectedScopeKey) throw new Error('saved_secret_account_snapshot_unavailable');
  const captured = readSavedSecretRevisionsFromSnapshotV1(snapshot, references, context
    ? { isCurrent: () => context.readSnapshot() === snapshot } : undefined);
  if (captured.status !== 'ready') {
    throw new Error('saved_secret_reference_revision_unavailable');
  }
  return { referencedSavedSecretIds: references, savedSecretRevisions: [...captured.resourcesByRef.values()]
    .map(({ resourceId, revision }) => ({ resourceId, expectedRevision: revision })) };
}

export async function readSavedSecretMaterializerForOperation(input: SavedSecretCatalogRefreshInputV1): Promise<Readonly<{
  snapshot: ActiveAccountSettingsSnapshot;
  materializer: SavedSecretMaterializerV1;
}>> {
  const snapshot = await readSavedSecretCatalogForOperation(input);
  const context = input.operationContext;
  const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot,
    context ? { isCurrent: () => context.readSnapshot() === snapshot } : undefined);
  return { snapshot, materializer };
}
