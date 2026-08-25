import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import {
  BUNDLED_FIRST_PARTY_PLUGIN_METADATA,
  type BundledFirstPartyPluginMetadata,
} from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';

import { resolveDaemonCatalogAgentIdFromBackendTarget } from './backendTargetRouting';

export function resolveBundledPluginMetadataForBackendTarget(
  target: BackendTargetRefV2 | undefined,
): BundledFirstPartyPluginMetadata | null {
  const agentId = resolveDaemonCatalogAgentIdFromBackendTarget(target);
  if (!agentId) {
    return null;
  }
  return BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find((entry) => entry.agentId === agentId) ?? null;
}

export function resolveBundledPluginIdForBackendTarget(
  target: BackendTargetRefV2 | undefined,
): string | null {
  const pluginId = resolveBundledPluginMetadataForBackendTarget(target)?.pluginId.trim() ?? '';
  return pluginId || null;
}
