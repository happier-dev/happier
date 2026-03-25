import type { CodexBackendMode } from '@happier-dev/agents';
import {
  normalizeCodexBackendMode,
  readCanonicalAgentRuntimeDescriptorV1ForProvider,
} from '@happier-dev/protocol';

export function resolveCanonicalCodexBackendMode(params: Readonly<{
    codexBackendMode?: unknown;
    experimentalCodexAcp?: boolean;
    agentRuntimeDescriptorV1?: unknown;
}>): CodexBackendMode | undefined {
    const runtimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(params.agentRuntimeDescriptorV1, 'codex');
    const runtimeBackendMode = normalizeCodexBackendMode(runtimeDescriptor?.backendMode);
    if (runtimeBackendMode) {
      return runtimeBackendMode;
    }

    const requestedBackendMode = normalizeCodexBackendMode(params.codexBackendMode);
    if (requestedBackendMode) {
      return requestedBackendMode;
    }

    return params.experimentalCodexAcp === true ? 'acp' : undefined;
}
