import type { Metadata, PermissionMode } from '@/api/types';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';

import {
  mergeSessionMetadataForStartup,
  type AcpSessionModeOverride as MergeAcpSessionModeOverride,
  type ModelOverride as MergeModelOverride,
  type PermissionModeOverride as MergePermissionModeOverride,
} from './mergeSessionMetadataForStartup';

export type PermissionModeOverride = MergePermissionModeOverride | null;

export type AcpSessionModeOverride = MergeAcpSessionModeOverride | null;

export type ModelOverride = MergeModelOverride | null;

export function buildAcpSessionModeOverride(opts: {
  agentModeId?: string;
  agentModeUpdatedAt?: number;
}): AcpSessionModeOverride {
  if (typeof opts.agentModeId !== 'string') return null;
  const normalized = opts.agentModeId.trim();
  if (!normalized) return null;
  return { modeId: normalized, updatedAt: opts.agentModeUpdatedAt };
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
  acpSessionModeOverride?: AcpSessionModeOverride;
  modelOverride?: ModelOverride;
  mode?: 'start' | 'attach';
}): void {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  updateMetadataBestEffort(
    opts.session,
    (currentMetadata) =>
      mergeSessionMetadataForStartup({
        current: currentMetadata,
        next: opts.next,
        nowMs,
        permissionModeOverride: opts.permissionModeOverride ?? null,
        acpSessionModeOverride: opts.acpSessionModeOverride ?? null,
        modelOverride: opts.modelOverride ?? null,
        mode: opts.mode ?? 'start',
      }),
    '[startupMetadata]',
    'apply_startup_metadata_update',
  );
}
