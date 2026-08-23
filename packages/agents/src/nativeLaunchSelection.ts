import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol';

import { getAgentModelConfig, getAgentStaticModels } from './models.js';
import { getAgentSessionModeDescriptor } from './sessionModes.js';
import type { AgentId } from './types.js';

/**
 * Native launch facts that can be rejected without touching a plugin, runtime,
 * connection, or the filesystem. Dynamic provider prerequisites remain launch-owned.
 */
export type AgentNativeSpawnSelectionInput = Readonly<{
  modelId?: unknown;
  acpSessionModeId?: unknown;
  sessionConfigOptionOverrides?: unknown;
}>;

export type AgentNativeSpawnDefinitiveRejection =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false }>;

export function resolveAgentNativeSpawnDefinitiveRejection(params: Readonly<{
  agentId: AgentId;
  selection: AgentNativeSpawnSelectionInput;
}>): AgentNativeSpawnDefinitiveRejection {
  const { selection } = params;
  if (
    selection.sessionConfigOptionOverrides !== undefined
    && !AcpConfigOptionOverridesV1Schema.safeParse(selection.sessionConfigOptionOverrides).success
  ) {
    return { ok: false };
  }

  const acpSessionModeId = selection.acpSessionModeId;
  if (
    acpSessionModeId != null
    && (typeof acpSessionModeId !== 'string' || acpSessionModeId.trim().length === 0)
  ) {
    return { ok: false };
  }

  const sessionModeDescriptor = getAgentSessionModeDescriptor(params.agentId);
  if (
    acpSessionModeId != null
    && (sessionModeDescriptor.source === 'none' || sessionModeDescriptor.semantics === 'none')
  ) {
    return { ok: false };
  }

  const modelId = selection.modelId;
  if (modelId === undefined || modelId === 'default') return { ok: true };
  if (typeof modelId !== 'string' || modelId.trim().length === 0) return { ok: false };

  const modelConfig = getAgentModelConfig(params.agentId);
  if (modelConfig.supportsSelection !== true) return { ok: false };
  if (getAgentStaticModels(params.agentId).some((model) =>
    model.id === modelId || model.extendedContextModelId === modelId,
  )) {
    return { ok: true };
  }
  if (modelConfig.dynamicProbe !== 'static-only') return { ok: true };
  return { ok: modelConfig.supportsFreeform === true };
}
