import type { WorkflowRunAcceptedContextV1 } from './actionsV1.js';
import type { BuiltinWorkflowIdV1 } from './builtins/catalog.js';
import type { WorkflowDefinitionMetadataV1, WorkflowDefinitionSavedByV1 } from './workflowDefinitionV1.js';

/** Information only, from the immutable accepted source; no current-definition lookup. */
export function readWorkflowRunSourceSavedByV1(context: Readonly<{
  source: WorkflowRunAcceptedContextV1['source'];
}> | null | undefined): WorkflowDefinitionSavedByV1 | null {
  const source = context?.source;
  const savedBy = source?.kind === 'saved' || source?.kind === 'automation' ? source.savedBy : null;
  return savedBy ? { kind: savedBy.kind, accountId: savedBy.accountId } : null;
}

/** Portable names for built-ins started without host-authored display metadata. */
export const BUILTIN_WORKFLOW_TITLES_V1 = Object.freeze({
  'builtin:keep-going': 'Keep going until done',
  'builtin:review-and-converge': 'Review & converge',
  'builtin:plan-with-a-panel': 'Panel',
  'builtin:open-a-pull-request': 'Open a pull request',
  'builtin:fresh-opinions': 'Fresh opinions',
  'builtin:answer-and-review': 'Answer + review',
  'builtin:debate': 'Debate',
} satisfies Readonly<Record<BuiltinWorkflowIdV1, string>>);

/** Display only: never add inferred metadata to the frozen accepted/replay context. */
export function readWorkflowRunDisplayMetadataV1(context: Readonly<{
  source: WorkflowRunAcceptedContextV1['source'];
  metadata?: WorkflowDefinitionMetadataV1 | null;
}>): WorkflowDefinitionMetadataV1 | null {
  if (context.metadata) return context.metadata;
  const ref = context.source.kind === 'catalog' ? context.source.ref : null;
  if (ref === null || !Object.hasOwn(BUILTIN_WORKFLOW_TITLES_V1, ref)) return null;
  return { title: BUILTIN_WORKFLOW_TITLES_V1[ref as BuiltinWorkflowIdV1] };
}
