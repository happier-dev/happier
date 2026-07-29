import type { Metadata, PermissionMode } from '@/api/types';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import {
  isRuntimeConfigUpdateOutcomeApplied,
  type RuntimeConfigUpdateOutcomeV1,
} from '@happier-dev/agents';

import { createSessionConfigOptionOverrideSynchronizer } from './sessionConfigOptionOverrideSync';
import { createSessionModeOverrideSynchronizer } from './sessionModeOverrideSync';
import { createModelTransitionMetadataObserver } from './modelTransitionMetadataObserver';
import { resolvePermissionIntentFromMetadataSnapshot } from './permissions/modeFromMetadata';

export type RuntimeOverrideTarget = Readonly<{
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    valueId: string | number | boolean | null,
  ) => Promise<RuntimeConfigUpdateOutcomeV1 | void>;
  setSessionModelSelection: (selection: ProviderBoundModelRef) => Promise<void>;
  setPermissionMode?: (permissionMode: PermissionMode) => Promise<RuntimeConfigUpdateOutcomeV1 | void>;
}>;

export type RuntimeOverrideSynchronizers = Readonly<{
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
}>;

function createPermissionModeOverrideSynchronizer(params: Readonly<{
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: { setPermissionMode?: (permissionMode: PermissionMode) => Promise<RuntimeConfigUpdateOutcomeV1 | void> };
  isStarted: () => boolean;
}>): RuntimeOverrideSynchronizers {
  let lastAppliedUpdatedAt = 0;
  let pending: { permissionMode: PermissionMode; updatedAt: number } | null = null;
  let applyingPromise: Promise<void> | null = null;

  const applyPendingIfPossible = (): Promise<void> => {
    if (applyingPromise) return applyingPromise;
    if (!pending) return Promise.resolve();
    if (!params.isStarted()) return Promise.resolve();
    if (!params.runtime.setPermissionMode) return Promise.resolve();

    const next = pending;
    if (next.updatedAt <= lastAppliedUpdatedAt) {
      pending = null;
      return Promise.resolve();
    }

    applyingPromise = params.runtime
      .setPermissionMode(next.permissionMode)
      .then((outcome) => {
        if (!isRuntimeConfigUpdateOutcomeApplied(outcome)) return;
        lastAppliedUpdatedAt = next.updatedAt;
        if (pending && pending.updatedAt <= lastAppliedUpdatedAt) pending = null;
      })
      .catch(() => {
        // Best-effort only. Keep the candidate pending so a later sync or flush can retry it.
      })
      .finally(() => {
        applyingPromise = null;
        if (pending && pending.updatedAt > next.updatedAt && params.isStarted()) {
          void applyPendingIfPossible();
        }
      });

    return applyingPromise;
  };

  const syncFromMetadata = (): void => {
    const next = resolvePermissionIntentFromMetadataSnapshot({
      metadata: params.session.getMetadataSnapshot(),
    });
    if (!next) return;
    if (next.updatedAt <= lastAppliedUpdatedAt) return;

    pending = { permissionMode: next.intent, updatedAt: next.updatedAt };
    if (params.isStarted()) {
      void applyPendingIfPossible();
    }
  };

  const flushPendingAfterStart = async (): Promise<void> => {
    if (!pending) return;
    if (!params.isStarted()) return;
    await applyPendingIfPossible();
  };

  return { syncFromMetadata, flushPendingAfterStart };
}

export function createRuntimeOverrideSynchronizers(params: Readonly<{
  agentTargetKey: string;
  session: { getMetadataSnapshot: () => import('@/api/types').Metadata | null };
  runtime: RuntimeOverrideTarget;
  isStarted: () => boolean;
}>): RuntimeOverrideSynchronizers {
  const modeSync = createSessionModeOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
  });
  const permissionModeSync = createPermissionModeOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
  });
  const configOptionSync = createSessionConfigOptionOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
  });
  const modelSync = createModelTransitionMetadataObserver({
    agentTargetKey: params.agentTargetKey,
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
  });
  let orderedSyncInProgress: Promise<void> | null = null;
  let orderedSyncRequested = false;

  const flushPendingInOrder = async (): Promise<void> => {
    await modeSync.flushPendingAfterStart();
    await permissionModeSync.flushPendingAfterStart();
    await modelSync.flushPendingAfterStart();
    await configOptionSync.flushPendingAfterStart();
  };

  const runOrderedSyncPass = async (): Promise<void> => {
    modeSync.syncFromMetadata();
    await modeSync.flushPendingAfterStart();
    permissionModeSync.syncFromMetadata();
    await permissionModeSync.flushPendingAfterStart();
    await modelSync.flushPendingAfterStart();
    configOptionSync.syncFromMetadata();
    await configOptionSync.flushPendingAfterStart();
  };

  const requestOrderedSync = (): void => {
    orderedSyncRequested = true;
    if (orderedSyncInProgress) return;

    orderedSyncInProgress = (async () => {
      while (orderedSyncRequested) {
        orderedSyncRequested = false;
        await runOrderedSyncPass();
      }
    })().finally(() => {
      orderedSyncInProgress = null;
      if (orderedSyncRequested) {
        requestOrderedSync();
      }
    });
  };

  return {
    syncFromMetadata: () => {
      modelSync.syncFromMetadata();
      requestOrderedSync();
    },
    flushPendingAfterStart: async () => {
      if (orderedSyncInProgress) {
        await orderedSyncInProgress;
      }
      await flushPendingInOrder();
    },
  };
}

export const createAcpRuntimeOverrideSynchronizers = createRuntimeOverrideSynchronizers;
