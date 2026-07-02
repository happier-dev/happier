import type { AgentCore, AgentId } from '../types.js';
import type { AgentSessionModeDescriptor, AgentSessionModesKind } from '../sessionModes.js';
import type { AgentModelConfig } from '../models.js';
import type { AgentLocalCliConfig } from '../localCli.js';
import type { AgentCliRuntimeSpec } from '../cli/runtime.js';
import type { AnyAgentRuntimeKindsManifest } from '../runtimeKinds.js';
import type { ProviderSettingsDefinition } from '../providerSettings/index.js';
import type { EngineSpec } from '../runtime/engine/contracts.js';

export type ProviderCatalogDefinition = Readonly<{
  id: AgentId;
  core: AgentCore;
  sessionModeDescriptor: AgentSessionModeDescriptor;
  sessionModesKind: AgentSessionModesKind;
  modelConfig: AgentModelConfig;
  localCli: AgentLocalCliConfig;
  agentCliRuntime: AgentCliRuntimeSpec;
  providerSettings: ProviderSettingsDefinition | null;
}>;

export type BackendCatalogDefinition = Readonly<{
  id: AgentId;
  providerId: AgentId;
  provider: ProviderCatalogDefinition;
  engine: EngineSpec | null;
  runtimeKinds: AnyAgentRuntimeKindsManifest | null;
}>;

/**
 * Compatibility aliases while host/runtime consumers migrate to catalog-specific naming.
 *
 * Important naming split:
 * - `BackendDefinitionV1` (protocol) remains the extension wire contract.
 * - `BackendCatalogDefinition` (agents) is the normalized host catalog record.
 */
export type ProviderDefinition = ProviderCatalogDefinition;
export type BackendDefinition = BackendCatalogDefinition;

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
