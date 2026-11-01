import { z } from 'zod';

import { SESSION_PERMISSION_MODES } from '../sessionMetadata/sessionPermissionModes.js';
import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import { lazySchema } from '../lazySchema.js';

/** The shared permission-response wire shape; legacy dispatch remains unparsed. */
export const SessionPermissionResponseSchema = lazySchema(() => z.object({
  id: z.string(),
  occurrenceId: z.string().optional(),
  approved: z.boolean(),
  decision: z.enum(['approved', 'approved_for_session', 'approved_execpolicy_amendment', 'denied', 'abort']).optional(),
  reason: z.string().optional(),
  mode: z.enum(SESSION_PERMISSION_MODES).optional(),
  allowedTools: z.array(z.string()).optional(),
  allowTools: z.array(z.string()).optional(),
  updatedPermissions: z.unknown().optional(),
  execPolicyAmendment: z.object({ command: z.array(z.string()) }).optional(),
  answers: z.record(z.string(), z.string()).optional(),
  structuredAnswersV1: StructuredQuestionAnswersV1Schema.optional(),
  receivedAt: z.number().optional(),
}));

export type SessionPermissionResponse = z.infer<typeof SessionPermissionResponseSchema>;

/** A decision bound to the canonical request occurrence displayed by its caller. */
export const SessionPermissionResponseToOccurrenceV1Schema = lazySchema(() => SessionPermissionResponseSchema.extend({
  id: z.string().trim().min(1),
  occurrenceId: z.string().trim().min(1),
}));

export type SessionPermissionResponseToOccurrenceV1 = z.infer<typeof SessionPermissionResponseToOccurrenceV1Schema>;
