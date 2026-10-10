import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

const boundedId = z.string().trim().min(1).max(512);

/**
 * Every destructive consequence a single handoff destination decision can
 * authorize, in canonical order.
 */
export const HANDOFF_TARGET_APPROVAL_CONSEQUENCES_V1 = [
  'replace_nonempty_workspace_target',
  'delete_target_only_files_during_exact_mirror',
] as const;

export type HandoffTargetApprovalConsequenceV1 = typeof HANDOFF_TARGET_APPROVAL_CONSEQUENCES_V1[number];

/**
 * Host-private evidence stamped by the target daemon after inspecting a handoff
 * destination under root arbitration. One proof carries every destructive
 * consequence the destination decision authorizes, so the user is asked exactly
 * once. It is durable only as approval subject data and is never
 * caller-supplied Action/SDK input.
 */
export const HandoffTargetReplacementApprovalV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  consequences: z.array(z.enum(HANDOFF_TARGET_APPROVAL_CONSEQUENCES_V1))
    .min(1)
    .max(HANDOFF_TARGET_APPROVAL_CONSEQUENCES_V1.length)
    .refine((consequences) => consequences.every((consequence, index) => (
      index === 0
      || HANDOFF_TARGET_APPROVAL_CONSEQUENCES_V1.indexOf(consequence)
        > HANDOFF_TARGET_APPROVAL_CONSEQUENCES_V1.indexOf(consequences[index - 1]!)
    )), 'handoff target approval consequences must be unique and canonically ordered'),
  serverId: boundedId,
  machineId: boundedId,
  canonicalRoot: z.string().min(1).max(4096),
  rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  operationId: boundedId,
}).strict());

export type HandoffTargetReplacementApprovalV1 = z.infer<
  typeof HandoffTargetReplacementApprovalV1Schema
>;

export function sameHandoffTargetReplacementApproval(
  left: HandoffTargetReplacementApprovalV1,
  right: HandoffTargetReplacementApprovalV1,
): boolean {
  return left.v === right.v
    && left.consequences.length === right.consequences.length
    && left.consequences.every((consequence, index) => consequence === right.consequences[index])
    && left.serverId === right.serverId
    && left.machineId === right.machineId
    && left.canonicalRoot === right.canonicalRoot
    && left.rootFingerprint === right.rootFingerprint
    && left.operationId === right.operationId;
}
