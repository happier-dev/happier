import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';

import { createSessionConfigOptionOverrideSynchronizer } from './sessionConfigOptionOverrideSync';
import { createSessionModeOverrideSynchronizer } from './sessionModeOverrideSync';
import { createModelOverrideSynchronizer } from './modelOverrideSync';

export type RuntimeOverrideTarget = Readonly<{
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    valueId: string | number | boolean | null,
  ) => Promise<RuntimeConfigUpdateOutcomeV1 | void>;
  setSessionModel: (modelId: string) => Promise<void>;
}>;

export type RuntimeOverrideSynchronizers = Readonly<{
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
}>;

export function createRuntimeOverrideSynchronizers(params: Readonly<{
  session: { getMetadataSnapshot: () => import('@/api/types').Metadata | null };
  runtime: RuntimeOverrideTarget;
  isStarted: () => boolean;
}>): RuntimeOverrideSynchronizers {
  const modeSync = createSessionModeOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
  });
  const configOptionSync = createSessionConfigOptionOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
  });
  const modelSync = createModelOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
  });

  return {
    syncFromMetadata: () => {
      modeSync.syncFromMetadata();
      configOptionSync.syncFromMetadata();
      modelSync.syncFromMetadata();
    },
    flushPendingAfterStart: async () => {
      await modeSync.flushPendingAfterStart();
      await configOptionSync.flushPendingAfterStart();
      await modelSync.flushPendingAfterStart();
    },
  };
}

export const createAcpRuntimeOverrideSynchronizers = createRuntimeOverrideSynchronizers;
