import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ActionSurfaceSchema } from './metadata.js';
import { ApprovalProfileResolutionV1Schema } from './approvalProfiles.js';

/** Host-only confirmation ownership; result custody remains in ActionApproval. */
export const ActionApprovalPolicySchema = lazyZodSchema(() => z.strictObject({
  uiConfirmation: z.optional(z.enum(['policy', 'direct'])),
  uiConfirmationForInput: z.optional(z.custom<(input: unknown) => boolean>((value) => typeof value === 'function')),
  agentDefault: z.optional(z.enum(['egress', 'authority'])),
  /** The Agent/MCP Ask default applies only to inputs with this consequence; Settings Require/Waive still decide. */
  agentDefaultForInput: z.optional(z.custom<(input: unknown) => boolean>((value) => typeof value === 'function')),
  requiredSurfaces: z.optional(z.readonly(z.array(z.keyof(ActionSurfaceSchema)))),
  scopeAdmissionOwnsConfirmation: z.optional(z.literal(true)),
  pluginCaptureWaiver: z.optional(z.literal(true)),
  computerConsent: z.optional(z.literal(true)),
  control: z.optional(z.literal(true)),
  rpcConfirmation: z.optional(z.literal(true)),
  retainUiFieldIntent: z.optional(z.literal(true)),
}));

export const ActionApprovalFlowSchema = lazyZodSchema(() => z.enum(['blocking', 'deferred']));
export type ActionApprovalFlow = z.infer<typeof ActionApprovalFlowSchema>;

export const ActionApprovalResultSchema = lazyZodSchema(() => z.enum(['required', 'optional', 'none']));
export type ActionApprovalResult = z.infer<typeof ActionApprovalResultSchema>;

export const ActionApprovalSchema = lazyZodSchema(() => z.strictObject({
    profile: z.optional(ApprovalProfileResolutionV1Schema),
    flow: z.optional(ActionApprovalFlowSchema),
    result: ActionApprovalResultSchema,
  }).check(z.superRefine((value, ctx) => {
    if (value.result === 'optional' && value.flow == null) {
      ctx.addIssue({
        code: "custom",
        path: ['flow'],
        message: 'optional approval results require an explicit flow',
      });
    }
  })));
export type ActionApproval = z.infer<typeof ActionApprovalSchema>;

export function resolveActionApprovalFlow(approval: ActionApproval): ActionApprovalFlow {
  if (approval.flow) return approval.flow;
  return approval.result === 'required' ? 'blocking' : 'deferred';
}
