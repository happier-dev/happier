import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { WorkflowDefinitionV1Schema, WorkflowValidationIssueV1Schema } from './workflowV1.js';

/** Document contracts have no dependency on executable Action validation. */
export const WorkflowDocumentV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('happier.workflow'),
  version: z.literal(1),
  definition: WorkflowDefinitionV1Schema,
}));
export type WorkflowDocumentV1 = z.infer<typeof WorkflowDocumentV1Schema>;

export const WorkflowDocumentParseFailureV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  code: z.enum(['workflow_document_invalid_json', 'workflow_document_unsupported_version',
    'workflow_document_invalid', 'workflow_document_invalid_definition']),
  issues: z.array(WorkflowValidationIssueV1Schema),
  normalizedDefinition: z.optional(WorkflowDefinitionV1Schema),
  version: z.optional(z.unknown()),
}));
