import { readStoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAcpCatalogSettingsFromAccountSettings } from '@/agent/acp/catalog/readAcpCatalogSettingsFromAccountSettings';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeEnvironment';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import {
  createAcpRuntimeCoreFromDefinition,
  normalizeConfiguredAcpDefinition,
} from '@/agent/acp/runtime/definition';
import {
  createEmptyBackendExecutionSurfaces,
  type EngineAdapterResolution,
  type EngineResolutionAgent,
  type EngineResolutionBackend,
} from '../engineRegistryTypes';

const ACCOUNT_CONFIGURED_ACP_SOURCE = Object.freeze({ kind: 'configured' as const });

export async function resolveAccountConfiguredAcpBackend(
  backendId: string,
): Promise<EngineAdapterResolution | null> {
  const settings = getActiveAccountSettingsSnapshot()?.settings;
  if (!settings) {
    return null;
  }

  const catalogSettings = readAcpCatalogSettingsFromAccountSettings(settings);
  if (!catalogSettings.backends.some((backend) => backend.id === backendId)) {
    return null;
  }

  const credentials = await readStoredCredentials();
  if (!credentials) {
    throw new Error('Account-configured ACP backends require credentials to resolve launch environment');
  }

  const configuredBackend = resolveConfiguredAcpBackendFromAccountSettings(settings, backendId);
  if (!configuredBackend) {
    return null;
  }
  const launchEnv = materializeConfiguredAcpEnvironment({
    backend: configuredBackend,
    accountSettings: settings,
    credentials,
  });
  const definition = normalizeConfiguredAcpDefinition({
    backend: configuredBackend,
    launchEnv,
  });
  const agentId = `acp:${configuredBackend.backendId}`;
  const backend: EngineResolutionBackend = Object.freeze({
    id: configuredBackend.backendId,
    agentId,
    provenance: 'configured',
    source: ACCOUNT_CONFIGURED_ACP_SOURCE,
    definition: Object.freeze({
      kindVersion: 1,
      id: configuredBackend.backendId,
      agentId,
    }),
    runtimeKind: 'acp',
    surfaceHandlers: Object.freeze([]),
  });
  const agent: EngineResolutionAgent = Object.freeze({
    id: agentId,
    provenance: 'configured',
    source: ACCOUNT_CONFIGURED_ACP_SOURCE,
    definition: Object.freeze({
      kindVersion: 1,
      id: agentId,
      ownedBackendIds: Object.freeze([configuredBackend.backendId]),
    }),
    runtimeSpec: null,
  });
  const runtimeOwner = Object.freeze({
    backendId: configuredBackend.backendId,
    selected: Object.freeze({
      kind: 'host_configured' as const,
      ownerId: configuredBackend.backendId,
      provenance: 'configured' as const,
    }),
    candidates: Object.freeze([Object.freeze({
      kind: 'host_configured' as const,
      ownerId: configuredBackend.backendId,
      provenance: 'configured' as const,
    })]),
  });

  return Object.freeze({
    backendId: configuredBackend.backendId,
    agentId,
    provenance: 'configured',
    selectedSource: 'configured',
    runtimeOwner,
    backend,
    agent,
    engineAdapter: createAcpRuntimeCoreFromDefinition(definition),
    executionSurfaces: createEmptyBackendExecutionSurfaces(),
    diagnostics: Object.freeze([]),
  });
}
