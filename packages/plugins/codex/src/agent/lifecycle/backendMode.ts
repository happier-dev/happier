import type { CodexBackendMode } from '@happier-dev/agents';
import {
  normalizeCodexBackendMode,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

import { readCanonicalCodexRuntimeDescriptorV1 } from '../identity/runtimeDescriptor.js';

export function resolveCanonicalCodexBackendMode(params: Readonly<{
  codexBackendMode?: unknown;
  runtimeDescriptorV1?: unknown;
}>): CodexBackendMode | undefined {
  const runtimeDescriptor = readCanonicalCodexRuntimeDescriptorV1(
    readRuntimeDescriptorV1FromMetadata({
      runtimeDescriptorV1: params.runtimeDescriptorV1,
    }),
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

export function resolveCodexBackendModeForRun(opts: Readonly<{
  codexBackendMode?: unknown;
  defaultBackendMode?: unknown;
}>): CodexBackendMode {
  const explicitMode = normalizeCodexBackendMode(opts.codexBackendMode);
  if (explicitMode) return explicitMode;

  const defaultMode = normalizeCodexBackendMode(opts.defaultBackendMode);
  return defaultMode ?? 'appServer';
}
