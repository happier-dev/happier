import type { AgentCore, AgentId } from '../types.js';
import type { AgentSessionModeDescriptor, AgentSessionModesKind } from '../sessionModes.js';
import type { AgentModelConfig } from '../models.js';
import type { AgentLocalCliConfig } from '../localCli.js';
import type { AgentCliRuntimeSpec } from '../cli/runtime.js';
import type { AnyAgentRuntimeKindsManifest } from '../runtimeKinds.js';
import type { AgentSettingsDefinition } from '../agentSettings/index.js';
import type { EngineSpec } from '../runtime/engine/contracts.js';

export type AgentCatalogDefinition = Readonly<{
  id: AgentId;
  settingsBackendId: string | null;
  core: AgentCore;
  sessionModeDescriptor: AgentSessionModeDescriptor;
  sessionModesKind: AgentSessionModesKind;
  modelConfig: AgentModelConfig;
  localCli: AgentLocalCliConfig;
  agentCliRuntime: AgentCliRuntimeSpec;
  agentSettings: AgentSettingsDefinition | null;
}>;

/**
 * Important naming split:
 * - `BackendDefinitionV1` (protocol) remains the extension wire contract.
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
}>;

export type BackendDefinitionContractV1 = Readonly<{
  kindVersion: 1;
  id: string;
  agentId: string;
}>;
