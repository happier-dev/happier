import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveConfiguredAcpBackendFromPluginBackendDefinition } from '@/agent/acp/catalog/configured/resolveBackend';
import { resolveConfiguredAcpBackendFromAccountSettingsOrPlugins } from '@/agent/acp/catalog/configured/resolveBackend';
import type { CatalogAgentLookupId } from '@/backends/types';
import { resolveLocalPathPluginSource } from '@/extensions/sources/localPath';
import { createPluginStateStore } from '@/extensions/store/state';
import { isConfiguredAcpProbeTarget } from './isConfiguredAcpProbeTarget';

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

async function resolveConfiguredAcpBackendFromPluginState(params: Readonly<{
  backendId: string;
  happyHomeDir?: string;
}>): Promise<ReturnType<typeof resolveConfiguredAcpBackendFromPluginBackendDefinition> | null> {
  const store = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  const state = await store.read();

  for (const record of Object.values(state.plugins)) {
    if (!record.state.enabled) {
      continue;
    }

    const defaultManifestPath = resolve(record.source.locator, '.happier-plugin/plugin.json');
    const resolvedLocator = record.install.mode === 'managed_install'
      ? record.install.installedPath
      : record.source.manifestPath && record.source.manifestPath !== defaultManifestPath
        ? record.source.manifestPath
        : record.source.locator;
    if (typeof resolvedLocator !== 'string' || resolvedLocator.trim().length === 0) {
      continue;
    }

    const resolvedSource = await resolveLocalPathPluginSource({ locator: resolvedLocator });
    if (!resolvedSource.ok) {
      continue;
    }

    const rawBackend = resolvedSource.manifest.contributions.backends.find((entry) => entry.id === params.backendId) ?? null;
    const backend = resolveConfiguredAcpBackendFromPluginBackendDefinition(rawBackend, params.backendId);
    if (backend) {
      return backend;
    }
  }

  return null;
}

export async function resolveConfiguredAcpProbeCacheVariant(params: Readonly<{
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  happyHomeDir?: string;
}>): Promise<string | null> {
  if (!isConfiguredAcpProbeTarget(params)) {
    return null;
  }

  const backendId = params.backendTarget.backendId.trim();
  if (!backendId) {
    return 'configuredAcp:missing-backend-id';
  }
  const backend = await resolveConfiguredAcpBackendFromAccountSettingsOrPlugins({
    settings: params.accountSettings ?? {},
    backendId,
    happyHomeDir: params.happyHomeDir,
  });
  const pluginBackend = backend ?? await resolveConfiguredAcpBackendFromPluginState({
    backendId,
    happyHomeDir: params.happyHomeDir,
  });
  if (!pluginBackend) {
    if (!params.accountSettings) {
      return `configuredAcp:${backendId}:missing-account-settings`;
    }
    return `configuredAcp:${backendId}:missing-backend`;
  }

  const materialProbeSettings = sortJsonValue({
    command: pluginBackend.command,
    args: pluginBackend.args,
    env: pluginBackend.env,
    auth: pluginBackend.auth,
    transportProfile: pluginBackend.transportProfile,
    capabilities: pluginBackend.capabilities,
    defaultMode: pluginBackend.defaultMode,
    defaultModel: pluginBackend.defaultModel,
  });

  // Cache variants must not leak raw env/auth material (may contain secrets). Use a stable digest so
  // the key stays bounded and safe to log/debug.
  const digest = createHash('sha256').update(JSON.stringify(materialProbeSettings)).digest('base64url');
  return `configuredAcp:${pluginBackend.backendId}:${digest}`;
}
