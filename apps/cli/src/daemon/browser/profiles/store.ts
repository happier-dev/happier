import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { BrowserProfileV1Schema, BrowserExtensionIdV1Schema, BrowserExtensionRecordV1Schema, type BrowserExtensionRecordV1 } from '@happier-dev/protocol/browser/profile/v1';
import type { BrowserProfileOwnerV1, BrowserProfilePurgeFailureReasonCodeV1, BrowserProfileStorageModeV1, BrowserProfileV1 } from '@happier-dev/protocol';
import { isPortableRelativePath } from '@happier-dev/protocol/filesystem/portablePathSegment';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import type { BrowserStoragePartitionOwner } from '../storage/partitions';
import { readProfileExtensions, removeProfileExtension, writeProfileExtension } from './extensions';

const PROFILE_STORAGE_DIRNAME = 'profiles';

export type BrowserProfileRegistration = Readonly<{
  profileId: string;
  storageMode: BrowserProfileStorageModeV1;
  owner: BrowserProfileOwnerV1;
  displayName?: string;
  createdAt?: number;
  cleanupOnSessionClose?: boolean;
  /** Settles the profile's running engine before deleting its storage. */
  beforePurge?: () => Promise<void>;
}>;

export type BrowserProfilePurgeAuditRecord = Readonly<{
  kind: 'browser_profile_purged' | 'browser_profile_purge_failed';
  profileId: string;
  storageMode: BrowserProfileStorageModeV1;
  reason: 'session_deleted' | 'logout' | 'explicit_request';
  reasonCode?: BrowserProfilePurgeFailureReasonCodeV1;
  message?: string;
  occurredAt: number;
}>;

export type BrowserProfilePurgeOutcome = Readonly<{
  purgedProfileIds: readonly string[];
  failedProfileIds: readonly string[];
}>;

export type BrowserPersistentProfileRegistration = BrowserProfileRegistration & Readonly<{ storageMode: 'user' | 'plugin' }>;

export type BrowserProfileExtensionsResult =
  | Readonly<{ ok: true; extensions: readonly BrowserExtensionRecordV1[] }>
  | Readonly<{ ok: false; reason: 'profile_not_found' | 'profile_unavailable' | 'persistent_profile_required' }>;

export type BrowserProfileStore = Readonly<{
  register(registration: BrowserProfileRegistration): BrowserProfileV1;
  registerPersistentProfile(registration: BrowserPersistentProfileRegistration): Promise<BrowserProfileV1>;
  loadPersistentProfile(profileId: string): Promise<BrowserProfileV1 | null>;
  listPersistentProfiles(): Promise<readonly BrowserProfileV1[]>;
  getProfile(profileId: string): BrowserProfileV1 | null;
  listProfiles(): readonly BrowserProfileV1[];
  resolveProfileDirectory(profileId: string): string;
  listExtensions(profileId: string): Promise<BrowserProfileExtensionsResult>;
  setExtension(profileId: string, extension: BrowserExtensionRecordV1): Promise<BrowserProfileExtensionsResult>;
  recordExtensionUpstream(profileId: string, extensionId: string, expectedVersion: string,
    upstream: NonNullable<BrowserExtensionRecordV1['upstream']>): Promise<BrowserProfileExtensionsResult>;
  removeExtension(profileId: string, extensionId: string): Promise<BrowserProfileExtensionsResult>;
  purgeForSessionDeleted(input: Readonly<{ sessionId: string }>): Promise<BrowserProfilePurgeOutcome>;
  purgeForLogout(): Promise<BrowserProfilePurgeOutcome>;
  /** Explicitly purges the named profiles, settling their native engines first. */
  purgeForExplicitRequest(input: Readonly<{ profileIds: readonly string[] }>): Promise<BrowserProfilePurgeOutcome>;
}>;

export type BrowserProfileStoreOptions = Readonly<{
  storageRootDirectory: string;
  partitionOwner: BrowserStoragePartitionOwner;
  removeDirectory?: (directory: string) => Promise<void>;
  emitAudit?: (record: BrowserProfilePurgeAuditRecord) => void;
  now?: () => number;
}>;

async function defaultRemoveDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export function createBrowserProfileStore(options: BrowserProfileStoreOptions): BrowserProfileStore {
  const removeDirectory = options.removeDirectory ?? defaultRemoveDirectory;
  const now = options.now ?? (() => Date.now());
  const emitAudit = options.emitAudit ?? (() => undefined);
  const profilesById = new Map<string, BrowserProfileV1>();
  const beforePurgeById = new Map<string, () => Promise<void>>();
  const profilesRoot = join(options.storageRootDirectory, PROFILE_STORAGE_DIRNAME);

  function resolveProfileDirectory(profileId: string): string {
    if (!isPortableRelativePath(profileId) || profileId.includes('/')) {
      throw new TypeError('Browser profile ID must be a portable path segment.');
    }
    return join(profilesRoot, profileId);
  }

  function buildRegisteredProfile(registration: BrowserProfileRegistration): BrowserProfileV1 {
    const timestamp = registration.createdAt ?? now();
    const profile = BrowserProfileV1Schema.parse({
      profileId: registration.profileId,
      storageMode: registration.storageMode,
      owner: registration.owner,
      ...(registration.displayName !== undefined ? { displayName: registration.displayName } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      lifecycleState: 'active',
      ...(registration.cleanupOnSessionClose !== undefined ? { cleanupOnSessionClose: registration.cleanupOnSessionClose } : {}),
    });
    resolveProfileDirectory(profile.profileId);
    return profile;
  }

  async function readProfileDirectory(profileId: string) {
    const directory = resolveProfileDirectory(profileId);
    const entry = await lstat(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    });
    if (entry && !entry.isDirectory()) throw new TypeError('Browser profile storage must be a directory, not a link.');
    return { directory, exists: entry !== null };
  }

  async function loadPersistentProfile(profileId: string): Promise<BrowserProfileV1 | null> {
    const existing = profilesById.get(profileId);
    if (existing) return existing.storageMode === 'user' || existing.storageMode === 'plugin' ? existing : null;
    const { directory, exists } = await readProfileDirectory(profileId);
    if (!exists) return null;
    const content = await readFile(join(directory, 'profile.json'), 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    });
    if (content === null) return null;
    const profile = BrowserProfileV1Schema.parse(JSON.parse(content));
    if (profile.profileId !== profileId || (profile.storageMode !== 'user' && profile.storageMode !== 'plugin')) {
      throw new TypeError('Stored browser profile identity does not match its persistent directory.');
    }
    profilesById.set(profileId, profile);
    return profile;
  }

  function admitExtensionStorage(profileId: string): Readonly<{ ok: true; directory: string; profile: BrowserProfileV1 }> | Extract<BrowserProfileExtensionsResult, { ok: false }> {
    const profile = profilesById.get(profileId);
    if (!profile) return { ok: false, reason: 'profile_not_found' };
    if (profile.lifecycleState !== 'active') return { ok: false, reason: 'profile_unavailable' };
    if (profile.storageMode !== 'user' && profile.storageMode !== 'plugin') return { ok: false, reason: 'persistent_profile_required' };
    return { ok: true, directory: resolveProfileDirectory(profileId), profile };
  }

  function markUnusable(
    profile: BrowserProfileV1,
    reasonCode: BrowserProfilePurgeFailureReasonCodeV1,
    message: string,
    reason: BrowserProfilePurgeAuditRecord['reason'],
  ): void {
    const occurredAt = now();
    const unusable = BrowserProfileV1Schema.parse({
      ...profile,
      lifecycleState: 'unusable',
      disabledReasons: [`${reasonCode}: ${message}`.slice(0, 128)],
      purgeFailure: { reasonCode, message: message.slice(0, 512), occurredAt },
      updatedAt: occurredAt,
    });
    profilesById.set(profile.profileId, unusable);
    emitAudit({
      kind: 'browser_profile_purge_failed',
      profileId: profile.profileId,
      storageMode: profile.storageMode,
      reason,
      reasonCode,
      message,
      occurredAt,
    });
  }

  async function purgeProfile(
    profile: BrowserProfileV1,
    reason: BrowserProfilePurgeAuditRecord['reason'],
  ): Promise<boolean> {
    const purging = BrowserProfileV1Schema.parse({ ...profile, lifecycleState: 'purging', updatedAt: now() });
    profilesById.set(profile.profileId, purging);

    try {
      await beforePurgeById.get(profile.profileId)?.();
    } catch {
      // Engine/CDP errors can contain private endpoints; the audit carries the typed cause only.
      markUnusable(profile, 'profile_in_use', 'Browser profile process did not settle.', reason);
      return false;
    }

    const partitionResult = await options.partitionOwner.purgePartitionsForProfiles(new Set([profile.profileId]));
    if (partitionResult.failures.length > 0) {
      markUnusable(
        profile,
        'disk_purge_failed',
        partitionResult.failures[0]?.message ?? 'Browser storage partition purge failed.',
        reason,
      );
      return false;
    }

    try {
      await removeDirectory(resolveProfileDirectory(profile.profileId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Browser profile directory purge failed.';
      markUnusable(profile, 'disk_purge_failed', message, reason);
      return false;
    }

    profilesById.delete(profile.profileId);
    beforePurgeById.delete(profile.profileId);
    emitAudit({
      kind: 'browser_profile_purged',
      profileId: profile.profileId,
      storageMode: profile.storageMode,
      reason,
      occurredAt: now(),
    });
    return true;
  }

  async function purgeProfiles(
    targets: readonly BrowserProfileV1[],
    reason: BrowserProfilePurgeAuditRecord['reason'],
  ): Promise<BrowserProfilePurgeOutcome> {
    const purgedProfileIds: string[] = [];
    const failedProfileIds: string[] = [];
    for (const profile of targets) {
      // An admitted purge owns process settlement and deletion. Concurrent purges
      // must not re-enter it or wait back on the lifecycle cancelling it.
      if (profilesById.get(profile.profileId)?.lifecycleState !== 'active') continue;
      const purged = await purgeProfile(profile, reason);
      if (purged) {
        purgedProfileIds.push(profile.profileId);
      } else {
        failedProfileIds.push(profile.profileId);
      }
    }
    return { purgedProfileIds, failedProfileIds };
  }

  return {
    register(registration) {
      const profile = buildRegisteredProfile(registration);
      profilesById.set(profile.profileId, profile);
      if (registration.beforePurge) beforePurgeById.set(profile.profileId, registration.beforePurge);
      return profile;
    },

    async registerPersistentProfile(registration) {
      const profile = buildRegisteredProfile({ ...registration, cleanupOnSessionClose: registration.cleanupOnSessionClose ?? false });
      if (profile.storageMode !== 'user' && profile.storageMode !== 'plugin') throw new TypeError('Persistent browser profiles must be user or plugin owned.');
      const { directory } = await readProfileDirectory(profile.profileId);
      await writeJsonAtomic(join(directory, 'profile.json'), profile);
      profilesById.set(profile.profileId, profile);
      if (registration.beforePurge) beforePurgeById.set(profile.profileId, registration.beforePurge);
      return profile;
    },

    loadPersistentProfile,

    async listPersistentProfiles() {
      const entries = await readdir(profilesRoot, { withFileTypes: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) if (entry.isDirectory()) await loadPersistentProfile(entry.name);
      return [...profilesById.values()].filter(profile => profile.storageMode === 'user' || profile.storageMode === 'plugin');
    },

    async listExtensions(profileId) {
      const storage = admitExtensionStorage(profileId);
      if (!storage.ok) return storage;
      return { ok: true, extensions: await readProfileExtensions(storage.directory) };
    },

    async setExtension(profileId, extension) {
      const storage = admitExtensionStorage(profileId);
      if (!storage.ok) return storage;
      const record = BrowserExtensionRecordV1Schema.parse(extension);
      const previous = await readProfileExtensions(storage.directory);
      // Existing synchronous registrations also become discoverable after restart
      // once they own an installed extension.
      await writeJsonAtomic(join(storage.directory, 'profile.json'), storage.profile);
      await writeProfileExtension(storage.directory, record);
      return { ok: true, extensions: [...previous.filter(item => item.id !== record.id), record].sort((left, right) => left.id.localeCompare(right.id)) };
    },

    async recordExtensionUpstream(profileId, extensionId, expectedVersion, upstream) {
      const storage = admitExtensionStorage(profileId);
      if (!storage.ok) return storage;
      const previous = await readProfileExtensions(storage.directory);
      const installed = previous.find(extension => extension.id === extensionId);
      // An observation belongs to the version checked, never to a newer install
      // or a removed record. Merge into the current record to retain user choices.
      if (!installed || installed.version !== expectedVersion) return { ok: true, extensions: previous };
      const record = BrowserExtensionRecordV1Schema.parse({ ...installed, upstream });
      await writeProfileExtension(storage.directory, record);
      return { ok: true, extensions: previous.map(extension => extension.id === record.id ? record : extension) };
    },

    async removeExtension(profileId, extensionId) {
      const storage = admitExtensionStorage(profileId);
      if (!storage.ok) return storage;
      const id = BrowserExtensionIdV1Schema.parse(extensionId);
      const previous = await readProfileExtensions(storage.directory);
      await removeProfileExtension(storage.directory, id);
      return { ok: true, extensions: previous.filter(item => item.id !== id) };
    },

    getProfile(profileId) {
      return profilesById.get(profileId) ?? null;
    },

    listProfiles() {
      return [...profilesById.values()];
    },

    resolveProfileDirectory,

    async purgeForSessionDeleted(input) {
      const targets = [...profilesById.values()].filter(
        (profile) => (profile.storageMode === 'session'
            || (profile.storageMode === 'ephemeral' && profile.cleanupOnSessionClose))
          && profile.owner.kind === 'session'
          && profile.owner.id === input.sessionId
          && profile.lifecycleState !== 'unusable',
      );
      return await purgeProfiles(targets, 'session_deleted');
    },

    async purgeForLogout() {
      const targets = [...profilesById.values()].filter(
        (profile) => profile.storageMode === 'ephemeral' && profile.lifecycleState !== 'unusable',
      );
      return await purgeProfiles(targets, 'logout');
    },
    async purgeForExplicitRequest(input) {
      const profileIds = new Set(input.profileIds);
      const targets = [...profilesById.values()].filter(profile => profileIds.has(profile.profileId)
        && profile.lifecycleState !== 'unusable');
      return await purgeProfiles(targets, 'explicit_request');
    },
  };
}
