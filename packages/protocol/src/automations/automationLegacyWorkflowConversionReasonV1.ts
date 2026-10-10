import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const LegacyAutomationWorkflowConversionReasonV1Schema = lazyZodSchema(() => z.enum([
  'review_required',
  'attachments_unsupported',
  'references_unsupported_target',
  'conversation_unrepresentable',
  'workspace_unrepresentable',
  'settings_unrepresentable',
  'runtime_descriptor_unsupported',
  'spawn_unrepresentable',
  'channel_reply_handoff',
  'channel_association_unknown',
]));
export type LegacyAutomationWorkflowConversionReasonV1 = z.infer<typeof LegacyAutomationWorkflowConversionReasonV1Schema>;
