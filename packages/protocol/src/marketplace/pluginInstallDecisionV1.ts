import { z } from 'zod';

export const HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD = 'daemon.plugins.install.review.decide' as const;

export const HostPrivatePluginInstallOptionalSelectionV1Schema = z.object({
  accessId: z.string().trim().min(1).max(256),
  selected: z.boolean(),
}).strict();

const HostPrivatePluginInstallPositiveDecisionV1Schema = z.object({
  v: z.literal(1),
  pendingChangeId: z.string().trim().min(1).max(256),
  decision: z.literal('installAndTrust'),
  actorEvidence: z.object({
    kind: z.literal('authenticatedLocalUser'),
    interactionId: z.string().trim().min(1).max(256),
    occurredAtMs: z.number().int().nonnegative(),
  }).strict(),
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

const HostPrivatePluginInstallCancelDecisionV1Schema = z.object({
  v: z.literal(1),
  pendingChangeId: z.string().trim().min(1).max(256),
  decision: z.literal('cancel'),
}).strict();

export const HostPrivatePluginInstallDecisionV1Schema = z.union([
  HostPrivatePluginInstallPositiveDecisionV1Schema,
  HostPrivatePluginInstallCancelDecisionV1Schema,
]);

export type HostPrivatePluginInstallDecisionV1 = z.infer<typeof HostPrivatePluginInstallDecisionV1Schema>;
