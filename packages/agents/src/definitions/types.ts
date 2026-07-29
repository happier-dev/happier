import type { AgentCore, AgentId } from '../types.js';
import type { AgentSessionModeDescriptor, AgentSessionModesKind } from '../sessionModes.js';
import type { AgentModelConfig } from '../models.js';
import type { AgentLocalCliConfig } from '../localCli.js';
import type { AnyAgentRuntimeKindsManifest } from '../runtimeKinds.js';
import type { EngineSpec } from '../runtime/engine/contracts.js';
import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol';

export type AgentCatalogDefinition = Readonly<{
  id: AgentId;
  settingsBackendId: string | null;
  core: AgentCore;
  sessionModeDescriptor: AgentSessionModeDescriptor;
  sessionModesKind: AgentSessionModesKind;
  modelConfig: AgentModelConfig;
  localCli: AgentLocalCliConfig;
}>;

/**
 * Important naming split:
 * - `PluginBackendDefinitionV1` (protocol) remains the plugin wire contract.
 * - `BackendCatalogDefinition` (agents) is the normalized host catalog record.
 */
export type BackendCatalogDefinition = Readonly<{
  id: AgentId;
  agentId: AgentId;
  agent: AgentCatalogDefinition;
  engine: EngineSpec | null;
  runtimeKinds: AnyAgentRuntimeKindsManifest | null;
}>;

/**
 * Canonical normalized agent/backend definition contract used by registry consumers.
 *
 * This is intentionally smaller than the built-in catalog facts above. It keeps the
 * cross-package contribution registry on one stable, versioned shape while the richer
 * built-in metadata stays owned by the agents package.
 */
export type AgentDefinitionContractV1 = Readonly<{
  kindVersion: 1;
  id: string;
  ownedBackendIds: readonly string[];
  enablementCompatibilityBackendIds?: readonly string[];
  providerRequirements?: AgentProviderRequirementsV1;
}>;

export type BackendDefinitionContractV1 = Readonly<{
  kindVersion: 1;
  id: string;
  agentId: string;
}>;
