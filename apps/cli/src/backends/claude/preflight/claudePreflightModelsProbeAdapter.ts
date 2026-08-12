import type { AgentModelDescriptor } from '@happier-dev/agents';

import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { resolveClaudeModelCatalogResolution } from '@/backends/claude/models/resolveClaudeModelCatalog';
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
  modelProbeCachePolicy: 'provider-owned',
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: async ({ cwd, timeoutMs, connectedServices, credentials, accountSettings, profileId }) => {
    const resolution = await resolveClaudeModelCatalogResolution({
      timeoutMs,
      connectedServices,
      credentials,
      accountSettings,
      profileId,
    });
    if (resolution.source === 'static') return null;
    const installedCapabilities = await probeClaudeInstalledRuntimeCapabilities({ cwd, timeoutMs });
    return resolution.models.map((model) => toProbeRawModel(model, installedCapabilities));
  },
};
