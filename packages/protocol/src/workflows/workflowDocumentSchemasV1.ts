import { z } from 'zod';
import { WorkflowDefinitionV1Schema, WorkflowValidationIssueV1Schema } from './workflowV1.js';

/** Document contracts have no dependency on executable Action validation. */
export const WorkflowDocumentV1Schema = z.object({
  kind: z.literal('happier.workflow'),
  version: z.literal(1),
  definition: WorkflowDefinitionV1Schema,
}).strict();
export type WorkflowDocumentV1 = z.infer<typeof WorkflowDocumentV1Schema>;

export const WorkflowDocumentParseFailureV1Schema = z.object({
  ok: z.literal(false),
  code: z.enum(['workflow_document_invalid_json', 'workflow_document_unsupported_version',
    'workflow_document_invalid', 'workflow_document_invalid_definition']),
  issues: z.array(WorkflowValidationIssueV1Schema),
  normalizedDefinition: WorkflowDefinitionV1Schema.optional(),
  version: z.unknown().optional(),
}).strict();
