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
  /** Agent-owned native permission labels, projected from the same mapping used at launch. */
  nativePermissionModes?: Readonly<Record<string, string>>;
  /**
   * Optional static model facts for catalog and preflight fallback use.
   *
   * ACP Agents may intentionally omit this when their model catalog is owned by
   * live session negotiation. Omission must not be interpreted as another
   * Agent's defaults or as proof that the runtime cannot select a model.
   */
  modelConfig?: AgentModelConfig | null;
  /** Absent when executable and auth selection belong to configured definitions. */
  cli?: AgentDefinitionCliMetadata;
  /**
   * Read-forward only for flat Session identity metadata written by released
   * cli-v0.2.0@526aa0d and cli-v0.2.1@b1d15a8. Current writers use
   * runtimeDescriptorV1; remove this seam when those releases leave support.
   */
  releasedFlatSessionMetadataRuntimeDescriptorReader?: ReleasedFlatSessionMetadataRuntimeDescriptorReaderDefinition;
  /**
   * Read-forward only for output transcript records written by released 0.2
   * Claude CLI writers. The declaring Agent owns the native record types;
   * remove this seam when those writers and their retained data leave support.
   */
  releasedOutputTranscriptRecordReader?: Readonly<{
    nonTranscriptRecordTypes: readonly string[];
  }>;
}>;
