import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { sameStrictJsonValue, StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { ActionIdSchema, type ActionId } from '../actionIds.js';
import { ActionSurfaceSchema } from '../metadata.js';
import type { HostReviewedChildrenPlanV1 } from './types.js';
import type { HostReviewedChildPolicyV1 } from './deploymentRoleChild.js';

/** One closed representation for prepared review facts, at rest and in authenticated dispatch. */
export const HostReviewedChildDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  action: z.union([ActionIdSchema, asProtocolZod(PluginContributionIdentityV1Schema)]),
    role: z.string().check(z.minLength(1)), input: z.optional(StrictJsonValueSchema),
    scopeInput: z.optional(z.record(z.string(), StrictJsonValueSchema)),
}));
export const HostReviewedChildrenPlanV1Schema = lazyZodSchema(() => z.strictObject({
  children: z.array(HostReviewedChildDeclarationV1Schema),
}));

export type AdmittedHostReviewedChildrenV1 = Readonly<{
  parentActionId: ActionId;
  parentInputDigest: string;
  plan: HostReviewedChildrenPlanV1;
  policies: readonly HostReviewedChildPolicyV1[];
  reviewAdmitted?: true;
}>;

/** Policy is already decided by the sending host; this carries facts, never a function or credential. */
export const AdmittedHostReviewedChildrenV1Schema = lazyZodSchema(() => z.strictObject({
  parentActionId: ActionIdSchema,
  parentInputDigest: z.string().check(z.minLength(1)),
  plan: HostReviewedChildrenPlanV1Schema,
  policies: z.array(z.strictObject({
    action: HostReviewedChildDeclarationV1Schema.shape.action,
    role: HostReviewedChildDeclarationV1Schema.shape.role,
    surface: z.keyof(ActionSurfaceSchema),
    requiredActionIds: z.optional(z.array(z.string())),
  })),
  reviewAdmitted: z.optional(z.literal(true)),
}).check(z.refine(facts => facts.plan.children.length > 0
  && facts.plan.children.length === facts.policies.length
  && facts.plan.children.every((child, index) => child.role === facts.policies[index]?.role
    && sameStrictJsonValue(child.action, facts.policies[index]?.action)),
{ message: 'Child policy must match the admitted plan' }))) satisfies z.ZodMiniType<AdmittedHostReviewedChildrenV1>;
