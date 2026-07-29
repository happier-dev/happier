import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BrowserProfileV1Schema,
  type BrowserProfileOwnerV1,
  type BrowserProfilePurgeFailureReasonCodeV1,
  type BrowserProfileStorageModeV1,
  type BrowserProfileV1,
} from '@happier-dev/protocol';

import type { BrowserStoragePartitionOwner } from '../storage/partitions';

const PROFILE_STORAGE_DIRNAME = 'profiles';

export type BrowserProfileRegistration = Readonly<{
  profileId: string;
  storageMode: BrowserProfileStorageModeV1;
  owner: BrowserProfileOwnerV1;
  displayName?: string;
  createdAt?: number;
  cleanupOnSessionClose?: boolean;
}>;

export type BrowserProfilePurgeAuditRecord = Readonly<{
  kind: 'browser_profile_purged' | 'browser_profile_purge_failed';
  profileId: string;
  storageMode: BrowserProfileStorageModeV1;
  reason: 'session_deleted' | 'logout';
  reasonCode?: BrowserProfilePurgeFailureReasonCodeV1;
  message?: string;
  occurredAt: number;
}>;

export type BrowserProfilePurgeOutcome = Readonly<{
  purgedProfileIds: readonly string[];
  failedProfileIds: readonly string[];
}>;

export type BrowserProfileStore = Readonly<{
  register(registration: BrowserProfileRegistration): BrowserProfileV1;
  getProfile(profileId: string): BrowserProfileV1 | null;
  listProfiles(): readonly BrowserProfileV1[];
  resolveProfileDirectory(profileId: string): string;
  purgeForSessionDeleted(input: Readonly<{ sessionId: string }>): Promise<BrowserProfilePurgeOutcome>;
  purgeForLogout(): Promise<BrowserProfilePurgeOutcome>;
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
  const profilesRoot = join(options.storageRootDirectory, PROFILE_STORAGE_DIRNAME);

  function resolveProfileDirectory(profileId: string): string {
    return join(profilesRoot, profileId);
  }

  function markUnusable(
    profile: BrowserProfileV1,
    reasonCode: BrowserProfilePurgeFailureReasonCodeV1,
    message: string,
    reason: 'session_deleted' | 'logout',
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
    reason: 'session_deleted' | 'logout',
  ): Promise<boolean> {
    const purging = BrowserProfileV1Schema.parse({ ...profile, lifecycleState: 'purging', updatedAt: now() });
    profilesById.set(profile.profileId, purging);

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
    reason: 'session_deleted' | 'logout',
  ): Promise<BrowserProfilePurgeOutcome> {
    const purgedProfileIds: string[] = [];
    const failedProfileIds: string[] = [];
    for (const profile of targets) {
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
      const timestamp = registration.createdAt ?? now();
      const profile = BrowserProfileV1Schema.parse({
        profileId: registration.profileId,
        storageMode: registration.storageMode,
        owner: registration.owner,
        ...(registration.displayName !== undefined ? { displayName: registration.displayName } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        lifecycleState: 'active',
        ...(registration.cleanupOnSessionClose !== undefined
          ? { cleanupOnSessionClose: registration.cleanupOnSessionClose }
          : {}),
      });
      profilesById.set(profile.profileId, profile);
      return profile;
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
        (profile) => profile.storageMode === 'session'
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
  };
}
