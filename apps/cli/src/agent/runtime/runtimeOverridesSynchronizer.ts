import type { Metadata, PermissionMode } from '@/api/types';
import type { ProviderBoundModelRef, SessionModelSelectionIntentV1 } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import { waitForSessionMetadataRetryBackoff } from '@/agent/runtime/session/metadataWaitRetryBackoff';
import {
  createRuntimeOverrideSynchronizers,
  type RuntimeOverrideSynchronizers,
  type RuntimeOverrideTarget,
} from './createRuntimeOverrideSynchronizers';

import {
  resolveModelSelectionIntentFromMetadataSnapshot,
  resolvePermissionIntentFromMetadataSnapshot,
} from './permissions/modeFromMetadata';
import { resolveStartupPermissionModeFromSession } from './permissions/startupSeed';

export type { RuntimeOverrideSynchronizers, RuntimeOverrideTarget } from './createRuntimeOverrideSynchronizers';

type RuntimePermissionModeRef = { current: PermissionMode; updatedAt: number };
type RuntimeModelOverrideRef = { current: ProviderBoundModelRef | null; updatedAt: number };

type SyncSnapshot = {
  permissionMode: RuntimePermissionModeRef;
  modelOverride: RuntimeModelOverrideRef;
};

async function runRuntimeMetadataOverridesWatcherLoop(args: Readonly<{
  shouldExit: () => boolean;
  getAbortSignal: () => AbortSignal | undefined;
  waitForMetadataUpdate: (signal?: AbortSignal) => Promise<boolean>;
  onUpdate: () => void | Promise<void>;
  abortedBackoffMs?: number;
}>): Promise<void> {
  const abortedBackoffMs =
    typeof args.abortedBackoffMs === 'number' && Number.isFinite(args.abortedBackoffMs) && args.abortedBackoffMs > 0
      ? Math.floor(args.abortedBackoffMs)
      : 25;

  while (!args.shouldExit()) {
    const signal = args.getAbortSignal();
    let didUpdate = false;
    try {
      didUpdate = await args.waitForMetadataUpdate(signal);
    } catch (error) {
      logger.debug('[RuntimeOverridesSynchronizer] Metadata watcher wait failed; retrying after backoff', {
        error: error instanceof Error ? error.message : String(error ?? 'unknown error'),
      });
      await waitForSessionMetadataRetryBackoff({ backoffMs: abortedBackoffMs, defaultMs: 25, minMs: 1 });
      continue;
    }
    if (!didUpdate) {
      await waitForSessionMetadataRetryBackoff({ backoffMs: abortedBackoffMs, defaultMs: 25, minMs: 1 });
      continue;
    }
    try {
      await args.onUpdate();
    } catch (error) {
      logger.debug('[RuntimeOverridesSynchronizer] Metadata watcher update failed; retrying after backoff', {
        error: error instanceof Error ? error.message : String(error ?? 'unknown error'),
      });
      await waitForSessionMetadataRetryBackoff({ backoffMs: abortedBackoffMs, defaultMs: 25, minMs: 1 });
    }
  }
}

export async function initializeRuntimeOverridesSynchronizer(params: Readonly<{
  agentTargetKey: string;
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

  const applyModelOverride = (next: SessionModelSelectionIntentV1 | null): void => {
    if (!next) return;
    if (next.updatedAt <= snapshot.modelOverride.updatedAt) return;
    snapshot.modelOverride.current = next.selection;
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
    applyModelOverride(resolveModelSelectionIntentFromMetadataSnapshot({
      metadata,
      agentTargetKey: params.agentTargetKey,
    }));
  };

  return {
    getSnapshot: () => snapshot,
    seedFromSession,
    syncFromMetadata,
  };
}

export async function setupRuntimeMetadataDrivenOverridesSync(params: Readonly<{
  agentTargetKey: string;
  explicitPermissionMode: PermissionMode | undefined;
  sessionKind: 'fresh' | 'attach' | 'resume';
  take?: number;
  session: {
    getMetadataSnapshot: () => Metadata | null;
    fetchLatestUserPermissionIntentFromTranscript: (
      opts?: Readonly<{ take?: number }>,
    ) => Promise<{ intent: PermissionMode; updatedAt: number } | null>;
    waitForMetadataUpdate: (signal?: AbortSignal) => Promise<boolean>;
  };
  permissionMode: RuntimePermissionModeRef;
  modelOverride: RuntimeModelOverrideRef;
  runtime?: Readonly<{
    target: RuntimeOverrideTarget;
    isStarted: () => boolean;
  }> | null;
  onPermissionModeApplied?: () => void;
  onModelOverrideApplied?: () => void;
  persistStartupOverridesCache: () => void;
  shouldExit: () => boolean;
  getAbortSignal: () => AbortSignal | undefined;
}>): Promise<{
  runtimeControlSync: RuntimeOverrideSynchronizers | null;
  syncOverridesFromMetadata: () => void;
}> {
  const runtimeControlSync = params.runtime
    ? createRuntimeOverrideSynchronizers({
        agentTargetKey: params.agentTargetKey,
        session: {
          getMetadataSnapshot: params.session.getMetadataSnapshot,
        },
        runtime: params.runtime.target,
        isStarted: params.runtime.isStarted,
      })
    : null;

  const runtimeOverridesSync = await initializeRuntimeOverridesSynchronizer({
    agentTargetKey: params.agentTargetKey,
    explicitPermissionMode: params.explicitPermissionMode,
    sessionKind: params.sessionKind,
    take: params.take,
    session: {
      getMetadataSnapshot: params.session.getMetadataSnapshot,
      fetchLatestUserPermissionIntentFromTranscript: params.session.fetchLatestUserPermissionIntentFromTranscript,
    },
    permissionMode: params.permissionMode,
    modelOverride: params.modelOverride,
    onPermissionModeApplied: params.onPermissionModeApplied,
    onModelOverrideApplied: params.onModelOverrideApplied,
  });

  const syncOverridesFromMetadata = (): void => {
    runtimeOverridesSync.syncFromMetadata();
    runtimeControlSync?.syncFromMetadata();
  };

  syncOverridesFromMetadata();
  params.persistStartupOverridesCache();
  void runtimeOverridesSync.seedFromSession().catch(() => {
    // Best-effort only.
  });

  void runRuntimeMetadataOverridesWatcherLoop({
    shouldExit: params.shouldExit,
    getAbortSignal: params.getAbortSignal,
    waitForMetadataUpdate: params.session.waitForMetadataUpdate,
    onUpdate: syncOverridesFromMetadata,
  });

  return {
    runtimeControlSync,
    syncOverridesFromMetadata,
  };
}
