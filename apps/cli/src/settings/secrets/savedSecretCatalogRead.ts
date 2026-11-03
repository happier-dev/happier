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
  /** Optional Profile defaults may be omitted after the same fresh authorization read. */
  required?: boolean;
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

/** Native reads and writes share the Machine ingress' existing Manage authority. */
export function assertSavedSecretNativeSourceAccessForOperation(
  machine: SavedSecretOperationContextV1['machineAdmission'], reference = '',
): void {
  if (machine && machine.actorAccountId !== machine.custodianAccountId
    && machine.role !== MACHINE_NATIVE_SECRET_SOURCE_ACCESS_POLICY_V1.sharedMachineAccess) {
    throw new SavedSecretOperationAdmissionError({ reason: 'reference_forbidden', reference });
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
        audience: row.entry.audience,
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
  secretSources?: TargetSecretSourcesV1;
  /** Existing host-private ingress proof when the caller already owns Account custody. */
  machineAdmission?: SavedSecretOperationContextV1['machineAdmission'];
  /** Native source bootstrap credentials must themselves be inline. */
  sourceKind?: 'inline';
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

/** Host-only read outcome; no read is inferred from a shared-looking reference. */
export type SavedSecretCatalogOperationAdmissionV1 = Readonly<{
  snapshot: ActiveAccountSettingsSnapshot;
  catalogRead: boolean;
}>;

function sharedOperationReferences(snapshot: ActiveAccountSettingsSnapshot, references: readonly SavedSecretOperationReferenceV1[]) {
  const collisionRefs = new Set(
    resolveActiveSavedSecretCatalogCollisionState(snapshot).collisions.map((collision) => collision.ref),
  );
  for (const reference of references) {
    if (reference.revision !== undefined && collisionRefs.has(reference.ref)) {
      throw new SavedSecretOperationAdmissionError({
        reason: 'reference_collision_migration_required',
        reference: reference.ref,
      });
    }
  }
  return references.filter(
    (reference) => !collisionRefs.has(reference.ref)
      && parseSavedSecretRefV1(reference.ref).kind === 'shared_resource',
  );
}

function assertSharedOperationReferencesReady(snapshot: ActiveAccountSettingsSnapshot,
  references: readonly SavedSecretOperationReferenceV1[], isCurrent?: () => boolean): void {
  const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot, isCurrent ? { isCurrent } : undefined);
  for (const reference of references) {
    if (resolveActiveSavedSecretCatalogCollisionState(snapshot).collisions.some(
      (collision) => collision.ref === reference.ref,
    )) {
      throw new SavedSecretOperationAdmissionError({ reason: 'reference_collision_migration_required', reference: reference.ref });
    }
    if (reference.revision !== undefined && !materializer.matchesSharedResourceRevision(reference.ref, reference.revision)) {
      throw new SavedSecretOperationAdmissionError({ reason: 'reference_stale', reference: reference.ref });
    }
    const resolved = materializer.resolveContent(reference.ref);
    if (resolved.status !== 'ready' && reference.required !== false) {
      throw new SavedSecretOperationAdmissionError({ reason: savedSecretOperationAdmissionReason(resolved.status), reference: reference.ref });
    }
  }
}

/** Validate newly selected references against this operation's already read catalog. */
export function assertSavedSecretOperationReferencesReady(snapshot: ActiveAccountSettingsSnapshot,
  references: readonly SavedSecretOperationReferenceV1[]): void {
  assertSharedOperationReferencesReady(snapshot, sharedOperationReferences(snapshot, references));
}

/** Read/admit only: composite dispatch and importer share this cut without recursively importing. */
export async function readSavedSecretCatalogAdmissionForOperation(input: SavedSecretCatalogRefreshInputV1): Promise<SavedSecretCatalogOperationAdmissionV1> {
  input.signal?.throwIfAborted();
  const requestedReferences = readRequestedSavedSecretOperationReferences(input);
  const context = input.operationContext;
  if (context && !await context.isCurrent(input.signal)) throw new Error('saved_secret_account_lifetime_changed');
  const current = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  if (!current || current.scopeKey !== input.expectedScopeKey) throw new Error('saved_secret_account_snapshot_unavailable');
  const sharedReferences = sharedOperationReferences(current, requestedReferences);
  if (sharedReferences.length === 0 && input.refreshCatalog !== true) return { snapshot: current, catalogRead: false };

  const credentials = context?.credentials ?? await readStoredCredentials().catch(() => null);
  input.signal?.throwIfAborted();
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
  input.signal?.throwIfAborted();
  const refreshed = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  if (
    !refreshed
    || refreshed.scopeKey !== input.expectedScopeKey
    || refreshed.savedSecretCatalogState !== 'ready'
  ) {
    throw new Error('saved_secret_catalog_refresh_unavailable');
  }
  assertSharedOperationReferencesReady(refreshed, sharedReferences,
    context ? () => context.readSnapshot() === refreshed : undefined);
  return { snapshot: refreshed, catalogRead: true };
}

export async function readSavedSecretCatalogForOperation(input: SavedSecretCatalogRefreshInputV1): Promise<ActiveAccountSettingsSnapshot> {
  return (await readSavedSecretCatalogAdmissionForOperation(input)).snapshot;
}

/** Consume catalog admission once, then hold only this operation's selected native material. */
export async function acquireSavedSecretMaterializerForOperation(input: Readonly<{
  snapshot: ActiveAccountSettingsSnapshot;
  references: readonly SavedSecretOperationReferenceV1[];
  operationContext?: SavedSecretOperationContextV1;
  secretSources?: TargetSecretSourcesV1;
  machineAdmission?: SavedSecretOperationContextV1['machineAdmission'];
  sourceKind?: 'inline';
  signal?: AbortSignal;
  /** Already admitted invocation owners supply their existing lifetime witness. */
  isCurrent?: () => boolean;
}>): Promise<SavedSecretMaterializerV1> {
  const context = input.operationContext;
  const snapshot = input.snapshot;
  const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  const isCurrent = input.isCurrent ?? (context ? () => context.readSnapshot()?.scopeKey === snapshot.scopeKey
    : () => getActiveAccountSettingsSnapshot()?.scopeKey === snapshot.scopeKey
      && getActiveAccountSettingsSnapshotLifetimeToken() === lifetime);
  const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent });
  if (input.sourceKind === 'inline') return materializer;
  const acquisitions = new Map<string, SavedSecretExternalAcquisitionV1>();
  const contents = new Map<string, SavedSecretResourceContentV1>();
  const externalReferences: { ref: string; source: SavedSecretExternalSourceV1 }[] = [];
  const sources = input.secretSources ?? context?.secretSources;
  for (const ref of new Set(input.references.map(reference => reference.ref))) {
    input.signal?.throwIfAborted();
    const resolved = materializer.resolveContent(ref);
    if (resolved.status !== 'ready') continue;
    const parsed = parseSavedSecretRefV1(ref);
    if (parsed.kind === 'shared_resource') contents.set(parsed.resourceId, resolved.content);
    if (resolved.content.v !== 2 || resolved.content.source.kind !== 'external') continue;
    assertSavedSecretNativeSourceAccessForOperation(context?.machineAdmission ?? input.machineAdmission, ref);
    externalReferences.push({ ref, source: resolved.content.source });
  }
  // Native bootstrap may refresh this same catalog and retire its old DEKs.
  // Keep all selected authenticated content in this operation's existing
  // opened-content projection before the first asynchronous native read.
  for (const { ref, source } of externalReferences) {
    input.signal?.throwIfAborted();
    if (!sources) {
      acquisitions.set(ref, { status: 'temporarily_unavailable' });
      continue;
    }
    const acquired = await sources.acquire(source, { signal: input.signal });
    input.signal?.throwIfAborted();
    if (acquired.ok) acquisitions.set(ref, { status: 'ready', value: acquired.value });
    else if (acquired.code === 'cancelled') throw new DOMException('Saved Secret acquisition canceled', 'AbortError');
    else acquisitions.set(ref, { status: acquired.code === 'access_denied' ? 'forbidden'
      : acquired.code === 'not_found' ? 'missing'
        : acquired.code === 'authentication_required' || acquired.code === 'native_unavailable' ? 'repair_required'
          : 'temporarily_unavailable',
      sourceFailure: { code: acquired.code, ...(acquired.repair ? { repair: acquired.repair } : {}) } });
  }
  return createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent, externalAcquisitions: acquisitions,
    openedInstallationContents: contents });
}

export async function readSavedSecretMaterializerForOperation(input: SavedSecretCatalogRefreshInputV1): Promise<Readonly<{
  snapshot: ActiveAccountSettingsSnapshot;
  materializer: SavedSecretMaterializerV1;
}>> {
  const { snapshot } = await readSavedSecretCatalogAdmissionForOperation(input);
  const materializer = await acquireSavedSecretMaterializerForOperation({ ...input, snapshot,
    references: readRequestedSavedSecretOperationReferences(input) });
  return { snapshot, materializer };
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
