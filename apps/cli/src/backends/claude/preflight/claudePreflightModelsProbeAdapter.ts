import type { AgentModelDescriptor } from '@happier-dev/agents';

import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { resolveClaudeModelCatalogResolution } from '@/backends/claude/models/resolveClaudeModelCatalog';
import { probeClaudeCatalogs } from './probeClaudeCatalogs';
import {
  isClaudeModelOptionSupportedByInstalledRuntime,
  probeClaudeInstalledRuntimeCapabilities,
} from '@/backends/claude/sessionControls/probeClaudeInstalledRuntimeCapabilities';

function toProbeRawModel(
  model: AgentModelDescriptor,
  installedCapabilities: Awaited<ReturnType<typeof probeClaudeInstalledRuntimeCapabilities>>,
): Record<string, unknown> {
  const modelOptions = model.modelOptions?.filter((option) =>
    isClaudeModelOptionSupportedByInstalledRuntime(option.id, installedCapabilities));
  return {
    id: model.id,
    name: model.name,
    ...(typeof model.description === 'string' ? { description: model.description } : {}),
    ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
    ...(typeof model.extendedContextModelId === 'string' ? { extendedContextModelId: model.extendedContextModelId } : {}),
    ...(modelOptions && modelOptions.length > 0 ? { modelOptions } : {}),
  };
}

/**
 * New-session model probe for Claude.
 *
 * The catalog itself is owned by `resolveClaudeModelCatalog`, which the in-session
 * `sessionModelsV1` publisher also reads, so both surfaces describe the same models with the same
 * effort tiers.
 */
export const claudePreflightModelsProbeAdapter: PreflightSessionControlsProbeAdapter = {
  connectedServiceAuth: {
    probeModels: 'provider-owned',
    probeModes: 'not-required',
    probeConfigOptions: 'not-required',
    probeCatalogs: 'materialized-env',
  },
  probeCatalogsRaw: probeClaudeCatalogs,
  modelProbeCachePolicy: 'provider-owned',
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: async ({ cwd, timeoutMs, deadlineAt, signal, onNativeCleanup, connectedServices, credentials, accountSettings, profileId, processEnv, bypassCache }) => {
    const resolution = await resolveClaudeModelCatalogResolution({
      timeoutMs,
      deadlineAt,
      signal,
      onNativeCleanup,
      bypassCache,
      connectedServices,
      credentials,
      accountSettings,
      profileId,
      processEnv,
    });
    if (resolution.source === 'static') {
      return { availableModels: resolution.models, source: 'static', refreshError: resolution.refreshError };
    }
    const installedCapabilities = await probeClaudeInstalledRuntimeCapabilities({ cwd, timeoutMs, processEnv });
    return {
      availableModels: resolution.models.map((model) => toProbeRawModel(model, installedCapabilities)),
      source: resolution.source,
      observedAt: resolution.observedAt,
      ...(resolution.refreshError ? { refreshError: true } : {}),
    };
  },
};
