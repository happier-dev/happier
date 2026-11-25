import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const WORKFLOW_VALIDATION_ISSUE_CODES = [
  'invalid_version',
  'unknown_field',
  'invalid_id',
  'duplicate_id',
  'missing_reference',
  'invalid_reference_scope',
  'invalid_input',
  'missing_required_input',
  'invalid_result_contract',
  'invalid_condition',
  'invalid_repetition',
  'invalid_max_concurrent',
  'unsupported_persisted_attachment',
  'conversation_workspace_mismatch',
  'target_unavailable',
] as const;
export type WorkflowValidationIssueCode = (typeof WORKFLOW_VALIDATION_ISSUE_CODES)[number];

export const WorkflowValidationIssueV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.enum(WORKFLOW_VALIDATION_ISSUE_CODES),
  path: z.string(), message: z.string(), blockId: z.optional(z.string()),
  severity: z.enum(['error', 'warning']),
}));

export type WorkflowValidationIssue = Readonly<{
  code: WorkflowValidationIssueCode;
  /** JSON-pointer-like location of the exact block or field, e.g. `/blocks/1/input/0`. */
  path: string;
  message: string;
  blockId?: string;
  severity: 'error' | 'warning';
}>;
