import type { AgentCore, AgentId } from '../types.js';
import type { AgentSessionModeDescriptor, AgentSessionModesKind } from '../sessionModes.js';
import type { AgentModelConfig } from '../models.js';
import type { AgentLocalCliConfig } from '../localCli.js';
import type { ProviderCliRuntimeSpec } from '../providers/providerCliRuntime.js';
import type { AnyAgentRuntimeKindsManifest } from '../runtimeKinds.js';
import type { ProviderSettingsDefinition } from '../providerSettings/index.js';

export type ProviderDefinition = Readonly<{
  id: AgentId;
  core: AgentCore;
  sessionModeDescriptor: AgentSessionModeDescriptor;
  sessionModesKind: AgentSessionModesKind;
  modelConfig: AgentModelConfig;
  localCli: AgentLocalCliConfig;
  providerCliRuntime: ProviderCliRuntimeSpec;
  providerSettings: ProviderSettingsDefinition | null;
}>;

export type BackendDefinition = Readonly<{
  id: AgentId;
  providerId: AgentId;
  provider: ProviderDefinition;
  runtimeKinds: AnyAgentRuntimeKindsManifest | null;
}>;

/**
 * Canonical normalized provider/backend definition contract used by registry consumers.
 *
 * This is intentionally smaller than the built-in catalog facts above. It keeps the
 * cross-package contribution registry on one stable, versioned shape while the richer
 * built-in metadata stays owned by the agents package.
 */
export type ProviderDefinitionContractV1 = Readonly<{
  kindVersion: 1;
  id: string;
  ownedBackendIds: readonly string[];
}>;

export type BackendDefinitionContractV1 = Readonly<{
  kindVersion: 1;
  id: string;
  providerId: string;
}>;
