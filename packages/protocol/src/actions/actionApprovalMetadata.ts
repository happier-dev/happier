import { z } from 'zod';

export const ActionApprovalFlowSchema = z.enum(['blocking', 'deferred']);
export type ActionApprovalFlow = z.infer<typeof ActionApprovalFlowSchema>;

export const ActionApprovalResultSchema = z.enum(['required', 'optional', 'none']);
export type ActionApprovalResult = z.infer<typeof ActionApprovalResultSchema>;

export const ActionApprovalSchema = z
  .object({
    flow: ActionApprovalFlowSchema.optional(),
    result: ActionApprovalResultSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.result === 'optional' && value.flow == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow'],
        message: 'optional approval results require an explicit flow',
      });
    }
  });
export type ActionApproval = z.infer<typeof ActionApprovalSchema>;

export function resolveActionApprovalFlow(approval: ActionApproval): ActionApprovalFlow {
  if (approval.flow) return approval.flow;
  return approval.result === 'required' ? 'blocking' : 'deferred';
}
