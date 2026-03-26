import type { Metadata } from '@/api/types';
import {
  computePendingModelOverrideApplication,
  computePendingSessionModeOverrideApplication,
} from '@/agent/runtime/permission/permissionModeFromMetadata';
import { resolveSessionConfigOptionOverridesFromMetadataSnapshot } from '@/agent/runtime/sessionConfigOptionOverrideSync';
import { logger } from '@/ui/logger';

type CodexAppServerOverrideSeedRuntime = Readonly<{
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, valueId: string) => Promise<void>;
}>;

export async function seedCodexAppServerPendingSessionOverrides(params: Readonly<{
  metadata: Metadata | null | undefined;
  runtime: CodexAppServerOverrideSeedRuntime;
}>): Promise<void> {
  const metadata = params.metadata ?? null;

  const pendingModel = computePendingModelOverrideApplication({
    metadata,
    lastAppliedUpdatedAt: 0,
  });
  if (pendingModel) {
    try {
      await params.runtime.setSessionModel(pendingModel.modelId);
    } catch (error) {
      logger.debug('[codex-app-server] Failed to pre-seed model override before startOrLoad (non-fatal)', {
        modelId: pendingModel.modelId,
        error: error instanceof Error ? error.message : String(error ?? 'unknown error'),
      });
    }
  }

  const configOverrides = resolveSessionConfigOptionOverridesFromMetadataSnapshot({ metadata });
  for (const override of configOverrides) {
    try {
      await params.runtime.setSessionConfigOption(override.configId, override.valueId);
    } catch (error) {
      logger.debug('[codex-app-server] Failed to pre-seed config override before startOrLoad (non-fatal)', {
        configId: override.configId,
        valueId: override.valueId,
        error: error instanceof Error ? error.message : String(error ?? 'unknown error'),
      });
    }
  }

  const pendingMode = computePendingSessionModeOverrideApplication({
    metadata,
    lastAppliedUpdatedAt: 0,
  });
  if (pendingMode && pendingMode.modeId.trim().length > 0) {
    try {
      await params.runtime.setSessionMode(pendingMode.modeId);
    } catch (error) {
      logger.debug('[codex-app-server] Failed to pre-seed session mode override before startOrLoad (non-fatal)', {
        modeId: pendingMode.modeId,
        error: error instanceof Error ? error.message : String(error ?? 'unknown error'),
      });
    }
  }
}
