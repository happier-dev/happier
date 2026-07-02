import type { CodexBackendMode } from '@happier-dev/protocol';

import { resolveCanonicalCodexBackendMode } from './backendMode.js';

export type CodexSpawnResumeSupportParamsInput = Readonly<{
  catalogAgentId?: unknown;
  options?: Readonly<{
    codexBackendMode?: unknown;
    runtimeDescriptorV1?: unknown;
  }> | null;
}>;

export type CodexVendorResumeSupportParams = Readonly<{
  codexBackendMode?: CodexBackendMode;
}>;

export function resolveCodexVendorResumeSupportParamsForSpawn(
  params: CodexSpawnResumeSupportParamsInput,
): CodexVendorResumeSupportParams {
  if (params.catalogAgentId !== 'codex') {
    return {};
  }

  const codexBackendMode = resolveCanonicalCodexBackendMode({
    codexBackendMode: params.options?.codexBackendMode,
    runtimeDescriptorV1: params.options?.runtimeDescriptorV1,
  });

  return codexBackendMode ? { codexBackendMode } : {};
}
