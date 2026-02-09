import type { Metadata, PermissionMode } from '@/api/types';

import { resolvePermissionIntentFromMetadataSnapshot } from './permissionModeFromMetadata';
import { resolveStartupPermissionModeFromSession } from './startupPermissionModeSeed';

export type PermissionModeSeedSession = {
  getMetadataSnapshot: () => Metadata | null;
  fetchLatestUserPermissionIntentFromTranscript: (
    opts?: { take?: number },
  ) => Promise<{ intent: PermissionMode; updatedAt: number } | null>;
};

export function readPermissionModeUpdatedAtFromMetadataSnapshot(metadata: Metadata | null | undefined): number {
  return typeof metadata?.permissionModeUpdatedAt === 'number' ? metadata.permissionModeUpdatedAt : 0;
}

export async function applyStartupPermissionModeSeedIfNewer(opts: {
  explicitPermissionMode: unknown;
  session: PermissionModeSeedSession;
  currentPermissionModeUpdatedAt: number;
  take?: number;
  apply: (next: { mode: PermissionMode; updatedAt: number }) => void;
}): Promise<number> {
  if (typeof opts.explicitPermissionMode === 'string') {
    return opts.currentPermissionModeUpdatedAt;
  }

  const seeded = await resolveStartupPermissionModeFromSession({
    session: opts.session,
    take: opts.take,
  });

  if (!seeded || seeded.updatedAt <= opts.currentPermissionModeUpdatedAt) {
    return opts.currentPermissionModeUpdatedAt;
  }

  opts.apply({ mode: seeded.mode, updatedAt: seeded.updatedAt });
  return seeded.updatedAt;
}

export function applyPermissionIntentFromMetadataIfNewer(opts: {
  metadata: Metadata | null | undefined;
  currentPermissionModeUpdatedAt: number;
  apply: (next: { intent: PermissionMode; updatedAt: number }) => void;
}): number {
  const resolved = resolvePermissionIntentFromMetadataSnapshot({ metadata: opts.metadata });
  if (!resolved || resolved.updatedAt <= opts.currentPermissionModeUpdatedAt) {
    return opts.currentPermissionModeUpdatedAt;
  }

  opts.apply({ intent: resolved.intent, updatedAt: resolved.updatedAt });
  return resolved.updatedAt;
}

export async function initializePermissionModeStateSync(opts: {
  explicitPermissionMode: unknown;
  session: PermissionModeSeedSession;
  currentPermissionModeUpdatedAt: number;
  take?: number;
  applyMode: (next: { mode: PermissionMode; updatedAt: number }) => void;
}): Promise<{
  permissionModeUpdatedAt: number;
  syncFromMetadata: (metadata: Metadata | null | undefined) => number;
}> {
  let permissionModeUpdatedAt = await applyStartupPermissionModeSeedIfNewer({
    explicitPermissionMode: opts.explicitPermissionMode,
    session: opts.session,
    currentPermissionModeUpdatedAt: opts.currentPermissionModeUpdatedAt,
    take: opts.take,
    apply: ({ mode, updatedAt }) => {
      opts.applyMode({ mode, updatedAt });
    },
  });

  const syncFromMetadata = (metadata: Metadata | null | undefined): number => {
    permissionModeUpdatedAt = applyPermissionIntentFromMetadataIfNewer({
      metadata,
      currentPermissionModeUpdatedAt: permissionModeUpdatedAt,
      apply: ({ intent, updatedAt }) => {
        opts.applyMode({ mode: intent, updatedAt });
      },
    });
    return permissionModeUpdatedAt;
  };

  return {
    permissionModeUpdatedAt,
    syncFromMetadata,
  };
}
