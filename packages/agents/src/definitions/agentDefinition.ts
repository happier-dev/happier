import type { AgentAuthProbeConfig } from '../auth.js';
import type { AgentLocalCliConfig } from '../localCli.js';
import type { AgentModelConfig } from '../models.js';
import type { AgentSessionModeDescriptor, AgentSessionModesKind } from '../sessionModes.js';
import type { AgentCore, AgentId } from '../types.js';
import type { ProviderCliRuntimeSpec } from '../providers/providerCliRuntime.js';
import type { ProviderSettingsDefinition } from '../providerSettings/index.js';

/**
 * Canonical “agent definition” contract exported by bundled first-party extensions.
 *
 * This is intentionally a compact, normalized record that matches the host
 * catalog’s needs and stays stable across packaging/codegen waves.
 */
export type AgentDefinition = Readonly<{
  id: AgentId;
  core: AgentCore;
  sessionModeDescriptor: AgentSessionModeDescriptor;
  sessionModesKind: AgentSessionModesKind;
  modelConfig: AgentModelConfig;
  authProbeConfig: AgentAuthProbeConfig;
  localCli: AgentLocalCliConfig;
  providerCliRuntime: ProviderCliRuntimeSpec;
  providerSettings: ProviderSettingsDefinition | null;
}>;
