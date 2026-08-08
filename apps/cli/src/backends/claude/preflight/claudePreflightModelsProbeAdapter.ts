import type { AgentModelDescriptor } from '@happier-dev/agents';

import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { hasDiscoveredClaudeModels, resolveClaudeModelCatalog } from '@/backends/claude/models/resolveClaudeModelCatalog';

function toProbeRawModel(model: AgentModelDescriptor): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    ...(typeof model.description === 'string' ? { description: model.description } : {}),
    ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
    ...(typeof model.extendedContextModelId === 'string' ? { extendedContextModelId: model.extendedContextModelId } : {}),
    ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0 ? { modelOptions: model.modelOptions } : {}),
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
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: async ({ timeoutMs, connectedServices }) => {
    const models = await resolveClaudeModelCatalog({ timeoutMs, connectedServices });
    // Nothing beyond the curated catalog means the probe added nothing: return null so the caller
    // reports the list as `static` rather than mislabelling the curated catalog as dynamic.
    if (!hasDiscoveredClaudeModels(models)) return null;
    return models.map(toProbeRawModel);
  },
};
