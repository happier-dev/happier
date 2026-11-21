import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema, type PluginContributionIdentityV1 } from '../contributionIdentity.js';
import { qualifyPluginContributionReferenceV1 } from '../contributionKey.js';
import { PluginContributionReferenceV2Schema, PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { asProtocolZod, projectZodProtocolSchema } from "../actions/internalProtocolZodAdapter.js";

export const PluginScmOperationV2Schema = lazyZodSchema(() => z.enum(['detect', 'clone', 'fetch', 'status', 'diff', 'commit', 'push', 'pullRequest']));
export const PluginScmOperationsV2Schema = lazyZodSchema(() => z.array(PluginScmOperationV2Schema).check(z.minLength(1, 'SCM contributions must declare at least one operation.'), z.superRefine((operations, ctx) => {
    const seen = new Set<string>();
    operations.forEach((operation, index) => {
      if (seen.has(operation)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `Duplicate SCM operation '${operation}'.`,
        });
      }
      seen.add(operation);
    });
  })));
/** Current source presence, independently projected by the repository's hosting provider. */
export const ScmHostingProjectReadinessSourceFactV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['ready', 'actionNeeded', 'unavailable']),
  reason: z.string().check(z.minLength(1)),
  setupSurface: z.optional(asProtocolZod(PluginContributionIdentityV1Schema)),
}));
export type ScmHostingProjectReadinessSourceFactV1 = z.infer<typeof ScmHostingProjectReadinessSourceFactV1Schema>;
export const ScmHostingProjectReadinessSourceFactV1ProtocolSchema = projectZodProtocolSchema(ScmHostingProjectReadinessSourceFactV1Schema);

/** Remote provider operations are finite declared Actions; local Git remains on the requester. */
export const ScmHostingOperationActionsV1Schema = lazyZodSchema(() => z.strictObject({
  listPullRequests: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  getPullRequest: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  createPullRequest: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  resolvePullRequestCheckoutReference: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  describePublishTargets: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  createRepository: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  getRepository: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  describeCloneTargets: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
}));
export type ScmHostingOperationActionsV1 = z.infer<typeof ScmHostingOperationActionsV1Schema>;
export type ScmHostingOperationV1 = keyof ScmHostingOperationActionsV1;

export const ScmHostingProviderContributionSchema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: zMini.optional(PluginLocalizedStringV2Schema),
  kind: z.string().check(z.trim(), z.minLength(1)),
  capabilities: PluginScmOperationsV2Schema,
  authService: zMini.optional(asProtocolZod(PluginContributionReferenceV2Schema)),
  /** Read-only Action resolving an exact repository ref to immutable commit provenance. */
  resolveRefAction: zMini.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  /** Safe Account Action projecting current CI and security source presence for an exact repository. */
  projectReadinessAction: zMini.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  operationActions: z.optional(ScmHostingOperationActionsV1Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type ScmHostingProviderContribution = z.infer<typeof ScmHostingProviderContributionSchema>;

/**
 * The one connected-account purpose an SCM hosting provider's `authService` serves: Happier clones, pushes and reads
 * the forge with it. The provider's qualified identity is the purpose consumer.
 */
export const SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID = 'authentication';

export function resolveScmHostingConnectedAccountPurposeV1(
  consumer: PluginContributionIdentityV1,
  authService: string | PluginContributionIdentityV1,
) {
  return Object.freeze({
    purpose: Object.freeze({ consumer, purpose: SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID }),
    serviceRefs: Object.freeze([Object.freeze(qualifyPluginContributionReferenceV1(authService, consumer.pluginId))]),
  });
}
