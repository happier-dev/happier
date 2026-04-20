import type { Metadata, PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol';

import {
  mergeSessionMetadataForStartup,
  type SessionModeOverride as MergeSessionModeOverride,
  type ModelOverride as MergeModelOverride,
  type PermissionModeOverride as MergePermissionModeOverride,
} from './mergeSessionMetadataForStartup';
import { normalizeLegacySessionModeMetadataCompat } from './startup/normalizeLegacySessionModeMetadataCompat';

export type PermissionModeOverride = MergePermissionModeOverride | null;

export type SessionModeOverride = MergeSessionModeOverride | null;

export type ModelOverride = MergeModelOverride | null;

export function buildSessionModeOverride(opts: {
  sessionModeId?: string;
  sessionModeUpdatedAt?: number;
}): SessionModeOverride {
  if (typeof opts.sessionModeId !== 'string') return null;
  const normalized = opts.sessionModeId.trim();
  if (!normalized) return null;
  return { modeId: normalized, updatedAt: opts.sessionModeUpdatedAt };
}

export function buildPermissionModeOverride(opts: {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
}): PermissionModeOverride {
  if (typeof opts.permissionMode !== 'string') {
    return null;
  }
  return { mode: opts.permissionMode, updatedAt: opts.permissionModeUpdatedAt };
}

export function buildModelOverride(opts: {
  modelId?: string;
  modelUpdatedAt?: number;
}): ModelOverride {
  if (typeof opts.modelId !== 'string') return null;
  const normalized = opts.modelId.trim();
  if (!normalized) return null;
  return { modelId: normalized, updatedAt: opts.modelUpdatedAt };
}

export function applyStartupMetadataUpdateToSession(opts: {
  session: { updateMetadata: (updater: (current: Metadata) => Metadata) => Promise<void> | void };
  next: Metadata;
  nowMs?: number;
  permissionModeOverride: PermissionModeOverride;
  sessionModeOverride?: SessionModeOverride;
  modelOverride?: ModelOverride;
  metadataKeysToUnsetOnAttach?: readonly string[] | null;
  attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy | null;
  mode?: 'start' | 'attach';
}): Promise<void> {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  try {
    const result = opts.session.updateMetadata((currentMetadata) =>
      mergeSessionMetadataForStartup({
        current: normalizeLegacySessionModeMetadataCompat(currentMetadata),
        next: normalizeLegacySessionModeMetadataCompat(opts.next),
        nowMs,
        permissionModeOverride: opts.permissionModeOverride ?? null,
        sessionModeOverride: opts.sessionModeOverride ?? null,
        modelOverride: opts.modelOverride ?? null,
        metadataKeysToUnsetOnAttach: opts.metadataKeysToUnsetOnAttach ?? null,
        attachMetadataIdentityPolicy: opts.attachMetadataIdentityPolicy ?? null,
        mode: opts.mode ?? 'start',
      }),
    );
    return Promise.resolve(result).catch((error) => {
      logger.debug('[startupMetadata] Failed to update session metadata (apply_startup_metadata_update) (non-fatal)', error);
    });
  } catch (error) {
    logger.debug('[startupMetadata] Failed to update session metadata (apply_startup_metadata_update) (non-fatal)', error);
    return Promise.resolve();
  }
}
