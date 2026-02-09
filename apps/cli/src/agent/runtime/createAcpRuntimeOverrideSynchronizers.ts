import { createAcpConfigOptionOverrideSynchronizer } from './acpConfigOptionOverrideSync';
import { createAcpSessionModeOverrideSynchronizer } from './acpSessionModeOverrideSync';
import { createModelOverrideSynchronizer } from './modelOverrideSync';

type AcpRuntimeOverrideTarget = {
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, valueId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
};

export function createAcpRuntimeOverrideSynchronizers(params: Readonly<{
  session: { getMetadataSnapshot: () => import('@/api/types').Metadata | null };
  runtime: AcpRuntimeOverrideTarget;
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  const modeSync = createAcpSessionModeOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
  });
  const configOptionSync = createAcpConfigOptionOverrideSynchronizer({
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
