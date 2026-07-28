import { createSessionConfigOptionOverrideSynchronizer } from './sessionConfigOptionOverrideSync';
import { createSessionModeOverrideSynchronizer } from './sessionModeOverrideSync';
import { createModelOverrideSynchronizer } from './modelOverrideSync';
import type { AgentState } from '@/api/types';
import { logger } from '@/ui/logger';

type AcpRuntimeOverrideTarget = {
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, valueId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
};

type RuntimeOverrideSession = {
  getMetadataSnapshot: () => import('@/api/types').Metadata | null;
  updateMetadata?: (updater: (metadata: import('@/api/types').Metadata) => import('@/api/types').Metadata) => Promise<void>;
  updateAgentState?: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
};

export function createRuntimeOverrideSynchronizers(params: Readonly<{
  session: RuntimeOverrideSession;
  runtime: AcpRuntimeOverrideTarget;
  isStarted: () => boolean;
  reportTerminalFailure?: (failure:
    | Readonly<{ kind: 'model'; requested: string; error: unknown }>
    | Readonly<{ kind: 'config'; configId: string; requested: string; error: unknown }>
  ) => void;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
  rebindSession: (session: RuntimeOverrideSession) => Promise<void>;
} {
  const publishTombstoneSupport = async (session: RuntimeOverrideSession): Promise<void> => {
    if (!session.updateAgentState) return;
    await session.updateAgentState((state) => ({
      ...state,
      capabilities: {
        ...(state.capabilities ?? {}),
        modelScopedConfigTombstonesV1: true,
      },
    }));
  };
  const modeSync = createSessionModeOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
    autoApplyFromMetadata: false,
  });
  const configOptionSync = createSessionConfigOptionOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
    autoApplyFromMetadata: false,
    reportTerminalFailure: params.reportTerminalFailure,
  });
  const modelSync = createModelOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
    autoApplyFromMetadata: false,
    reportTerminalFailure: params.reportTerminalFailure,
    onDefinitiveRejection: ({ updatedAt }) => configOptionSync.retirePendingThrough(updatedAt),
  });
  if (params.session.updateAgentState) {
    void publishTombstoneSupport(params.session).catch((error) => {
      logger.debug('[createRuntimeOverrideSynchronizers] Failed to publish model-scoped tombstone support', error);
    });
  }

  return {
    syncFromMetadata: () => {
      modeSync.syncFromMetadata();
      modelSync.syncFromMetadata();
      configOptionSync.syncFromMetadata();
      if (params.isStarted()) {
        void flushPendingAfterStart();
      }
    },
    flushPendingAfterStart,
    rebindSession: async (session) => {
      modeSync.rebindSession(session);
      modelSync.rebindSession(session);
      configOptionSync.rebindSession(session);
      await publishTombstoneSupport(session);
    },
  };

  async function flushPendingAfterStart(): Promise<void> {
      await modeSync.flushPendingAfterStart();
      if (!await modelSync.flushPendingAfterStartWithOutcome()) return;
      await configOptionSync.flushPendingAfterStart();
  }
}

export const createAcpRuntimeOverrideSynchronizers = createRuntimeOverrideSynchronizers;
