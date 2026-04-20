import type { CatalogAgentId, VendorResumeSupportParams } from '@/backends/types';
import type { CanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';

import { resolveCanonicalCodexBackendMode } from './backendMode';

export function resolveCodexVendorResumeSupportParamsForSpawn(params: Readonly<{
  catalogAgentId: CatalogAgentId | null;
  options: CanonicalSpawnRuntimeSelection;
}>): VendorResumeSupportParams {
  if (params.catalogAgentId !== 'codex') {
    return {};
  }

  const codexBackendMode = resolveCanonicalCodexBackendMode({
    codexBackendMode: params.options.codexBackendMode,
    runtimeDescriptorV1: params.options.runtimeDescriptorV1,
  });

  return codexBackendMode ? { codexBackendMode } : {};
}
