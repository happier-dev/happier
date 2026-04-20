import type { CodexBackendMode } from '@happier-dev/agents';
import {
  normalizeCodexBackendMode,
  readRuntimeDescriptorV1FromMetadata,
  readCanonicalRuntimeDescriptorV1ForProvider,
} from '@happier-dev/protocol';

export function resolveCanonicalCodexBackendMode(params: Readonly<{
    codexBackendMode?: unknown;
    runtimeDescriptorV1?: unknown;
}>): CodexBackendMode | undefined {
    const runtimeDescriptor = readCanonicalRuntimeDescriptorV1ForProvider(
      readRuntimeDescriptorV1FromMetadata({
        runtimeDescriptorV1: params.runtimeDescriptorV1,
      }),
      'codex',
    );
    const runtimeBackendMode = normalizeCodexBackendMode(runtimeDescriptor?.backendMode);
    if (runtimeBackendMode) {
      return runtimeBackendMode;
    }

    const requestedBackendMode = normalizeCodexBackendMode(params.codexBackendMode);
    if (requestedBackendMode) {
      return requestedBackendMode;
    }

    return undefined;
}

export function resolveCanonicalCodexBackendModeFromCompatInput(params: Readonly<{
    codexBackendMode?: unknown;
    experimentalCodexAcp?: boolean;
    runtimeDescriptorV1?: unknown;
}>): CodexBackendMode | undefined {
    return resolveCanonicalCodexBackendMode({
      codexBackendMode: params.codexBackendMode ?? (params.experimentalCodexAcp === true ? 'acp' : undefined),
      runtimeDescriptorV1: params.runtimeDescriptorV1,
    });
}
