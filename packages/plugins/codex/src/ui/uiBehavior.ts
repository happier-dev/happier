import {
  buildCodexAgentRuntimeDescriptorV1 as buildCodexAgentRuntimeDescriptor,
  normalizeCodexBackendMode,
  readCodexAgentRuntimeDescriptorV1,
} from '../protocol/runtimeDescriptorV1.js';

export const CODEX_UI_BEHAVIOR_OVERRIDE = {
  payload: {
    buildBackendTransportFields: ({
      providerMode,
      legacyExperimentalMode,
      runtimeDescriptorV1,
      providerSessionId,
    }: {
      providerMode?: unknown;
      legacyExperimentalMode?: boolean;
      runtimeDescriptorV1?: unknown;
      providerSessionId?: string;
    }) => {
      const runtimeDescriptor = readCodexAgentRuntimeDescriptorV1(runtimeDescriptorV1);
      const resolvedBackendMode =
        normalizeCodexBackendMode(runtimeDescriptor?.agent.backendMode)
        ?? normalizeCodexBackendMode(providerMode)
        ?? (legacyExperimentalMode === true ? 'acp' : undefined);

      if (!resolvedBackendMode) {
        return {};
      }

      if (runtimeDescriptor) {
        const runtimeBackendMode = normalizeCodexBackendMode(runtimeDescriptor.agent.backendMode);
        return {
          ...(runtimeBackendMode ? { codexBackendMode: runtimeBackendMode } : {}),
          runtimeDescriptorV1: runtimeDescriptor,
        };
      }

      return {
        codexBackendMode: resolvedBackendMode,
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: resolvedBackendMode,
          providerSessionId,
        }),
      };
    },
  },
} as const;
