import type { AgentModelConfig } from '../models.js';
import type { AgentSessionModeDescriptor, AgentSessionModesKind } from '../sessionModes.js';
import type { AgentCore, AgentId } from '../types.js';
import type { PluginAgentCliMetadata } from '@happier-dev/protocol';
import type { BuiltInAcpConfig } from '../acp.js';

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type AgentDefinitionCliMetadata = DeepReadonly<PluginAgentCliMetadata>;

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
  cli: AgentDefinitionCliMetadata;
  builtInAcpConfig?: BuiltInAcpConfig | null;
  runtimeContributions?: Readonly<Record<string, unknown>>;
}>;
