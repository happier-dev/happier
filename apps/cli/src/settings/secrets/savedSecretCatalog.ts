import { createHash } from 'node:crypto';

import { decryptSecretValueWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { SecretStringV1Schema } from '@happier-dev/protocol/crypto/settingsSecretStringSchemasV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { parseSavedSecretCatalogReferenceV1, projectSavedSecretCatalogCollisionStateV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { SavedSecretCatalogResourceV1, SavedSecretResourceStoredContentV1, SecretStringV1 } from '@happier-dev/protocol';
import {
  getActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export type SavedSecretCatalogResourceInputV1 = Omit<SavedSecretCatalogResourceV1, 'storedContent' | 'displayName'> & Readonly<{
  /**
   * The Home's projected display name, which is genuinely absent for a retained
   * resource whose stored name is empty. Inventing one here would then disagree
   * with the authenticated payload and reject healthy material as corrupt.
   */
  displayName: string | null;
  storedContent: SavedSecretResourceStoredContentV1 | null;
  resourceDataKey?: Uint8Array;
}>;

export type SavedSecretCatalogState = 'ready' | 'temporarily_unavailable' | 'disabled';

export type SavedSecretResolutionV1 =
  | Readonly<{
      status: 'ready';
      value: string;
      fingerprint: string;
      source: 'personal' | 'shared_resource';
    }>
  | Readonly<{
      status: 'missing'
        | 'temporarily_unavailable'
        | 'forbidden'
        | 'repair_required'
        | 'deleted'
        | 'mode_incompatible'
        | 'corrupt';
    }>;

export type SavedSecretResolutionFailureStatusV1 = Exclude<
  SavedSecretResolutionV1,
  { status: 'ready' }
>['status'];

/**
 * Typed launch/materialization refusal for an explicitly configured Saved
 * Secret reference. Adapters add only their usage location; the catalog's
 * status remains the canonical reason and is never translated to generic
 * "missing" text.
 */
export class SavedSecretResolutionError extends Error {
  readonly code = 'saved_secret_resolution_failed' as const;
  readonly status: SavedSecretResolutionFailureStatusV1;
  readonly reference: string;
  readonly consumer: string;
  readonly field: string;

  constructor(input: Readonly<{
    status: SavedSecretResolutionFailureStatusV1;
    reference: string;
    consumer: string;
    field: string;
  }>) {
    super(`Saved Secret ${input.status} while materializing ${input.consumer} ${input.field}`);
    this.name = 'SavedSecretResolutionError';
    this.status = input.status;
    this.reference = input.reference;
    this.consumer = input.consumer;
    this.field = input.field;
  }
}

export type SavedSecretInspectionV1 =
  | Readonly<{
      status: 'ready';
      fingerprint: string;
      source: 'personal' | 'shared_resource';
      kind: 'apiKey' | 'token' | 'password' | 'other' | null;
      storage: 'settings_plain' | 'settings_encrypted' | 'resource_plain' | 'resource_e2ee';
    }>
  | Exclude<SavedSecretResolutionV1, { status: 'ready' }>;

export type SavedSecretMaterializerV1 = Readonly<{
  inspect: (ref: string) => SavedSecretInspectionV1;
  resolve: (ref: string) => SavedSecretResolutionV1;
  recheck: (ref: string, fingerprint: string) => SavedSecretResolutionV1;
  matchesSharedResourceRevision: (ref: string, revision: number) => boolean;
}>;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type PersonalSavedSecretMaterial = Readonly<{
  secret: SecretStringV1;
  kind: 'apiKey' | 'token' | 'password' | 'other' | null;
  updatedAt: number | null;
}>;

function readPersonalSecrets(settingsLike: unknown): ReadonlyMap<string, PersonalSavedSecretMaterial> {
  const raw = isRecord(settingsLike) && Array.isArray(settingsLike.secrets)
    ? settingsLike.secrets
    : [];
  const out = new Map<string, PersonalSavedSecretMaterial>();
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') continue;
    const parsed = SecretStringV1Schema.safeParse(candidate.encryptedValue);
    if (!parsed.success) continue;
    const kind = candidate.kind === 'apiKey'
      || candidate.kind === 'token'
      || candidate.kind === 'password'
      || candidate.kind === 'other'
      ? candidate.kind
      : null;
    out.set(candidate.id, {
      secret: parsed.data,
      kind,
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : null,
    });
  }
  return out;
}

/**
 * Creates the one process-local Saved Secret resolver used by consumers. It
 * never fetches over HTTP or returns a server-side reveal; callers provide the
 * current Account-scoped catalog snapshot and existing settings read keys.
 */
export function createSavedSecretMaterializerV1(input: Readonly<{
  accountSettings: unknown;
  settingsSecretsReadKeys: readonly Uint8Array[];
  resources?: readonly SavedSecretCatalogResourceInputV1[];
  resourceCatalogState?: SavedSecretCatalogState;
}>): SavedSecretMaterializerV1 {
  const personal = readPersonalSecrets(input.accountSettings);
  const activeSnapshot = getActiveAccountSettingsSnapshot();
  const activeSnapshotForSettings = activeSnapshot !== null
    && activeSnapshot.settings === input.accountSettings
    ? activeSnapshot
    : null;
  const activeResources = activeSnapshotForSettings?.savedSecretResources;
  const resources = new Map((input.resources ?? activeResources)?.map((resource) => [resource.resourceId, resource]) ?? []);
  const resourceCatalogState = input.resourceCatalogState
    ?? activeSnapshotForSettings?.savedSecretCatalogState;
  const collisionState = projectSavedSecretCatalogCollisionStateV1(
    isRecord(input.accountSettings) && Array.isArray(input.accountSettings.secrets)
      ? input.accountSettings.secrets
      : [],
  );
  const collidingPersonalRefs = new Set(collisionState.collisions.map((collision) => collision.ref));

  const inspect = (ref: string): SavedSecretInspectionV1 => {
    const personalMaterial = personal.get(ref);
    if (personalMaterial) {
      return {
        status: 'ready',
        fingerprint: `saved-secret-record:v1:${digest({
          kind: 'personal',
          ref,
          encryptedValue: personalMaterial.secret,
          secretKind: personalMaterial.kind,
          updatedAt: personalMaterial.updatedAt,
        })}`,
        source: 'personal',
        kind: personalMaterial.kind,
        storage: personalMaterial.secret.encryptedValue ? 'settings_encrypted' : 'settings_plain',
      };
    }
    if (collidingPersonalRefs.has(ref)) return { status: 'corrupt' };
    const parsed = parseSavedSecretCatalogReferenceV1(ref);
    if (!parsed) return { status: 'missing' };
    if (parsed.kind === 'personal') return { status: 'missing' };
    if (resourceCatalogState === 'temporarily_unavailable' || resourceCatalogState === 'disabled') {
      return { status: 'temporarily_unavailable' };
    }
    const resource = resources.get(parsed.id);
    if (!resource) {
      return resourceCatalogState === 'ready'
        ? { status: 'forbidden' }
        : { status: 'temporarily_unavailable' };
    }
    if (resource.materialStatus !== 'ready') {
      switch (resource.materialStatus) {
        case 'preparing_encrypted_access':
        case 'temporarily_unavailable':
          return { status: 'temporarily_unavailable' };
        case 'recipient_mode_unsupported':
          return { status: 'mode_incompatible' };
        case 'access_removed':
          return { status: 'forbidden' };
        case 'deleted':
          return { status: 'deleted' };
        case 'update_required':
          return { status: 'repair_required' };
      }
    }
    if (resource.encryptionMode === 'e2ee' && !resource.resourceDataKey) {
      return { status: 'temporarily_unavailable' };
    }
    if (!resource.storedContent) return { status: 'corrupt' };
    return {
      status: 'ready',
      fingerprint: `saved-secret-record:v1:${digest({
        kind: 'shared_resource',
        ref,
        revision: resource.revision,
        storedContent: resource.storedContent,
      })}`,
      source: 'shared_resource',
      kind: resource.kind,
      storage: resource.encryptionMode === 'plain' ? 'resource_plain' : 'resource_e2ee',
    };
  };

  const resolve = (ref: string): SavedSecretResolutionV1 => {
    const inspected = inspect(ref);
    if (inspected.status !== 'ready') return inspected;
    if (inspected.source === 'personal') {
      const material = personal.get(ref)!;
      const value = decryptSecretValueWithKeysV1(material.secret, input.settingsSecretsReadKeys);
      if (value === null) return { status: 'temporarily_unavailable' };
      return {
        status: 'ready',
        value,
        fingerprint: inspected.fingerprint,
        source: 'personal',
      };
    }

    const parsed = parseSavedSecretCatalogReferenceV1(ref)!;
    if (parsed.kind !== 'shared_resource') return { status: 'missing' };
    const resource = resources.get(parsed.id);
    if (!resource) return { status: 'missing' };
    if (!resource.storedContent) return { status: 'corrupt' };
    const content = resource.encryptionMode === 'plain'
      ? openSavedSecretResourceStoredContentV1({
        resourceId: resource.resourceId,
        mode: 'plain',
        storedContent: resource.storedContent,
      })
      : resource.resourceDataKey
        ? openSavedSecretResourceStoredContentV1({
          resourceId: resource.resourceId,
          mode: 'e2ee',
          storedContent: resource.storedContent,
          resourceDataKey: resource.resourceDataKey,
        })
        : null;
    if (!content) return { status: 'corrupt' };
    // The Home projects display metadata separately so an encrypted resource
    // remains identifiable while access is preparing. Once opened, the
    // authenticated payload must agree with that projection; otherwise a
    // stale or tampered snapshot must never be materialized. An absent
    // projected name states nothing to contradict, so it is not a mismatch.
    if ((resource.displayName !== null && content.name !== resource.displayName)
      || content.kind !== resource.kind) {
      return { status: 'corrupt' };
    }
    return {
      status: 'ready',
      value: content.value,
      fingerprint: inspected.fingerprint,
      source: 'shared_resource',
    };
  };

  return {
    inspect,
    resolve,
    matchesSharedResourceRevision: (ref, revision) => {
      if (collidingPersonalRefs.has(ref)) return false;
      const parsed = parseSavedSecretCatalogReferenceV1(ref);
      return parsed?.kind === 'shared_resource'
        && resources.get(parsed.id)?.revision === revision;
    },
    recheck: (ref, fingerprint) => {
      const resolved = resolve(ref);
      return resolved.status === 'ready' && resolved.fingerprint !== fingerprint
        ? { status: 'repair_required' }
        : resolved;
    },
  };
}

export function createSavedSecretMaterializerFromSnapshotV1(
  snapshot: ActiveAccountSettingsSnapshot,
): SavedSecretMaterializerV1 {
  return createSavedSecretMaterializerV1({
    accountSettings: snapshot.settings,
    settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
    resources: snapshot.savedSecretResources,
    resourceCatalogState: snapshot.savedSecretCatalogState,
  });
}
