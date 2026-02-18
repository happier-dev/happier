import type { Metadata, PermissionMode } from '@/api/types';

import {
  resolveModelOverrideFromMetadataSnapshot,
  resolvePermissionIntentFromMetadataSnapshot,
} from './permission/permissionModeFromMetadata';
import { resolveStartupPermissionModeFromSession } from './permission/startupPermissionModeSeed';

type RuntimePermissionModeRef = { current: PermissionMode; updatedAt: number };
type RuntimeModelOverrideRef = { current: string | null; updatedAt: number };

type SyncSnapshot = {
  permissionMode: RuntimePermissionModeRef;
  modelOverride: RuntimeModelOverrideRef;
};

export async function initializeRuntimeOverridesSynchronizer(params: Readonly<{
  explicitPermissionMode: PermissionMode | undefined;
  sessionKind: 'fresh' | 'attach' | 'resume';
  take?: number;
  session: {
    getMetadataSnapshot: () => Metadata | null;
    fetchLatestUserPermissionIntentFromTranscript: (
      opts?: Readonly<{ take?: number }>,
    ) => Promise<{ intent: PermissionMode; updatedAt: number } | null>;
  };
  permissionMode: RuntimePermissionModeRef;
  modelOverride: RuntimeModelOverrideRef;
  onPermissionModeApplied?: () => void;
  onModelOverrideApplied?: () => void;
}>): Promise<{
  getSnapshot: () => SyncSnapshot;
  seedFromSession: () => Promise<void>;
  syncFromMetadata: () => void;
}> {
  const snapshot: SyncSnapshot = {
    permissionMode: params.permissionMode,
    modelOverride: params.modelOverride,
  };

  const explicitPermissionMode = params.explicitPermissionMode;

  const applyPermissionMode = (next: { intent: PermissionMode; updatedAt: number } | null): void => {
    if (!next) return;
    if (next.updatedAt <= snapshot.permissionMode.updatedAt) return;
    snapshot.permissionMode.current = next.intent;
    snapshot.permissionMode.updatedAt = next.updatedAt;
    params.onPermissionModeApplied?.();
  };

  const applyModelOverride = (next: { modelId: string; updatedAt: number } | null): void => {
    if (!next) return;
    if (next.updatedAt <= snapshot.modelOverride.updatedAt) return;
    snapshot.modelOverride.current = next.modelId;
    snapshot.modelOverride.updatedAt = next.updatedAt;
    params.onModelOverrideApplied?.();
  };

  const seedFromSession = async (): Promise<void> => {
    if (explicitPermissionMode) {
      snapshot.permissionMode.current = explicitPermissionMode;
      params.onPermissionModeApplied?.();
      return;
    }

    const resolved = await resolveStartupPermissionModeFromSession({
      sessionKind: params.sessionKind,
      session: params.session,
      take:
        typeof params.take === 'number' && Number.isFinite(params.take) && params.take > 0
          ? Math.floor(params.take)
          : 50,
    });
    if (!resolved) return;
    applyPermissionMode({ intent: resolved.mode, updatedAt: resolved.updatedAt });
  };

  const syncFromMetadata = (): void => {
    const metadata = params.session.getMetadataSnapshot();
    if (!explicitPermissionMode) {
      applyPermissionMode(resolvePermissionIntentFromMetadataSnapshot({ metadata }));
    }
    applyModelOverride(resolveModelOverrideFromMetadataSnapshot({ metadata }));
  };

  return {
    getSnapshot: () => snapshot,
    seedFromSession,
    syncFromMetadata,
  };
}
