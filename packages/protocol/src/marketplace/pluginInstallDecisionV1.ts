import { z } from 'zod';

export const HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD = 'daemon.plugins.install.review.decide' as const;

export const HostPrivatePluginInstallOptionalSelectionV1Schema = z.object({
  accessId: z.string().trim().min(1).max(256),
  selected: z.boolean(),
}).strict();

const HostPrivatePluginInstallActorEvidenceV1Schema = z.object({
  kind: z.literal('authenticatedLocalUser'),
  interactionId: z.string().trim().min(1).max(256),
  occurredAtMs: z.number().int().nonnegative(),
}).strict();

const HostPrivatePluginInstallPositiveDecisionV1Schema = z.object({
  v: z.literal(1),
  pendingChangeId: z.string().trim().min(1).max(256),
  decision: z.literal('installAndTrust'),
  actorEvidence: HostPrivatePluginInstallActorEvidenceV1Schema,
  optionalSelections: z.array(HostPrivatePluginInstallOptionalSelectionV1Schema).max(128),
}).strict().superRefine((value, context) => {
  const accessIds = new Set<string>();
  for (const selection of value.optionalSelections) {
    if (accessIds.has(selection.accessId)) {
      context.addIssue({
        code: 'custom',
        message: 'optionalSelections must contain unique accessId values',
        path: ['optionalSelections'],
      });
      return;
    }
    accessIds.add(selection.accessId);
  }
});

/**
 * Authorizes the daemon to evaluate executable plugin code from a local
 * development source root.
 *
 * This is a different authorization from `installAndTrust`: it grants no
 * optional host access and commits no plugin. It advances a pending
 * source-root review to the ordinary install-and-trust review the daemon
 * change service already owns, so the decision vocabulary here matches the
 * one at `apps/cli/src/plugins/daemon/changeContract.ts`
 * (`PluginChangeDecision`) rather than adding a second one.
 */
const HostPrivatePluginInstallTrustSourceRootDecisionV1Schema = z.object({
  v: z.literal(1),
  pendingChangeId: z.string().trim().min(1).max(256),
  decision: z.literal('trustSourceRoot'),
  actorEvidence: HostPrivatePluginInstallActorEvidenceV1Schema,
}).strict();

const HostPrivatePluginInstallCancelDecisionV1Schema = z.object({
  v: z.literal(1),
  pendingChangeId: z.string().trim().min(1).max(256),
  decision: z.literal('cancel'),
}).strict();

export const HostPrivatePluginInstallDecisionV1Schema = z.union([
  HostPrivatePluginInstallPositiveDecisionV1Schema,
  HostPrivatePluginInstallTrustSourceRootDecisionV1Schema,
  HostPrivatePluginInstallCancelDecisionV1Schema,
]);

export type HostPrivatePluginInstallDecisionV1 = z.infer<typeof HostPrivatePluginInstallDecisionV1Schema>;
