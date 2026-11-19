import { resolveBuiltinWorkflowDefinitionV1 } from './builtins/catalog.js';
import { parseWorkflowDefinitionRefV1 } from './workflowDefinitionRefV1.js';
import type { WorkflowDefinitionV1 } from './workflowV1.js';
import type { WorkflowPluginSourceReaderV1, WorkflowPluginSourceV1 } from './workflowPluginSourceContractV1.js';

type DefinitionSourceV1 = Readonly<{ definition: unknown }>;

export type WorkflowResolvedDefinitionRefV1<TArtifact extends DefinitionSourceV1 = DefinitionSourceV1> =
  | Readonly<TArtifact & { kind: 'saved'; sourceKey: string }>
  | Readonly<{ kind: 'catalog'; ref: string; sourceKey: string; definition: WorkflowDefinitionV1; version: number | string; metadata?: Readonly<{ title: string; description?: string }> }>;

/** Exact lookup over the serving host's already-admitted plugin sources. */
export async function resolveWorkflowPluginSourceV1(workflow: string, options: Readonly<{
  readPluginWorkflows?: WorkflowPluginSourceReaderV1;
  signal?: AbortSignal;
}>): Promise<WorkflowPluginSourceV1 | null> {
  options.signal?.throwIfAborted();
  const source = (await options.readPluginWorkflows?.(workflow, options.signal))?.find(entry => entry.workflow === workflow) ?? null;
  options.signal?.throwIfAborted();
  return source;
}

/** One routing owner; the caller keeps authority over opening Account Artifacts. */
export async function resolveWorkflowDefinitionRefV1<TArtifact extends DefinitionSourceV1 = DefinitionSourceV1>(
  value: string,
  options: Readonly<{
    readArtifact?: (artifactId: string, signal?: AbortSignal) => Promise<TArtifact | null>;
    readPluginWorkflows?: WorkflowPluginSourceReaderV1;
    signal?: AbortSignal;
  }> = {},
): Promise<WorkflowResolvedDefinitionRefV1<TArtifact> | null> {
  options.signal?.throwIfAborted();
  const ref = parseWorkflowDefinitionRefV1(value);
  if (ref?.kind === 'builtin') {
    const entry = resolveBuiltinWorkflowDefinitionV1(ref.id);
    return entry ? { kind: 'catalog', ref: value, sourceKey: value, ...entry } : null;
  }
  if (ref?.kind === 'plugin') {
    const entry = await resolveWorkflowPluginSourceV1(value, options);
    return entry ? { kind: 'catalog', ref: value, sourceKey: value, definition: entry.definition, version: entry.version,
      metadata: { title: entry.title, ...(entry.description === undefined ? {} : { description: entry.description }) } } : null;
  }
  if (ref?.kind !== 'artifact' || !options.readArtifact) return null;
  try {
    const artifact = await options.readArtifact(ref.artifactId, options.signal);
    options.signal?.throwIfAborted();
    return artifact ? { ...artifact, kind: 'saved', sourceKey: value } : null;
  } catch (error) {
    options.signal?.throwIfAborted();
    // Missing, inaccessible or unreadable content is a source refusal. A failed
    // transport observation is uncertain and must keep the caller's recovery path.
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'content_unavailable') return null;
    throw error;
  }
}
