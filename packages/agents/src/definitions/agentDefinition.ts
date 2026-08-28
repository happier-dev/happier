import type { AgentModelConfig } from '../models.js';
import type { AgentSessionModeDescriptor, AgentSessionModesKind } from '../sessionModes.js';
import type { AgentCore, AgentId } from '../types.js';
import type { PluginAgentCliMetadata } from '@happier-dev/protocol';

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type AgentDefinitionCliMetadata = DeepReadonly<PluginAgentCliMetadata>;

type ReleasedFlatSessionMetadataRuntimeDescriptorReaderDefinition = Readonly<{
  kind: 'providerRuntimeDescriptorReader';
  providerId: 'codex' | 'opencode';
  generatedReader: Readonly<Record<string, unknown>>;
}>;

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
  /**
   * Read-forward only for flat Session identity metadata written by released
   * cli-v0.2.0@526aa0d and cli-v0.2.1@b1d15a8. Current writers use
   * runtimeDescriptorV1; remove this seam when those releases leave support.
   */
  releasedFlatSessionMetadataRuntimeDescriptorReader?: ReleasedFlatSessionMetadataRuntimeDescriptorReaderDefinition;
}>;
