import type { AgentAuthProbeConfig } from '../auth.js';
import type { AgentLocalCliConfig } from '../localCli.js';
import type { AgentModelConfig } from '../models.js';
import type { AgentSessionModeDescriptor, AgentSessionModesKind } from '../sessionModes.js';
import type { AgentCore, AgentId } from '../types.js';
import type { AgentCliRuntimeSpec } from '../cli/runtime.js';
import type { AgentSettingsDefinition } from '../agentSettings/index.js';
import type { BuiltInAcpConfig } from '../acp.js';

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
  agentCliRuntime: AgentCliRuntimeSpec;
  builtInAcpConfig?: BuiltInAcpConfig | null;
  agentSettings: AgentSettingsDefinition | null;
  runtimeContributions?: Readonly<Record<string, unknown>>;
}>;
