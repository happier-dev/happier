import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import { preservedBoundedNfcString } from '../../strings/preservedBoundedNfcString.js';

export const SourceRefSchema = preservedBoundedNfcString(256, 'Source references');
export const SourceRevisionOrEpochSchema = preservedBoundedNfcString(128, 'Source revisions');

export const SessionPermissionSourceAuthorityV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('mediatedExternal'),
  mediatorPluginId: asProtocolZod(PluginIdSchema),
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
}));
export type SessionPermissionSourceAuthorityV1 = z.infer<
  typeof SessionPermissionSourceAuthorityV1Schema
>;

/**
 * Immutable input authority carried with one host-dispatched turn. Its explicit
 * arm separates admitted V1 input from pre-admission legacy/host execution.
 */
export const SessionInputCausalPermissionAuthorityV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('admittedSessionInputV1'),
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  sourceAuthority: z.optional(SessionPermissionSourceAuthorityV1Schema),
}).check(z.superRefine((value, context) => {
  if (
    value.sourceAuthority
    && value.sourceAuthority.admittedPermissionCeiling !== value.admittedPermissionCeiling
  ) {
    context.addIssue({
      code: 'custom',
      path: ['sourceAuthority', 'admittedPermissionCeiling'],
      message: 'Mediated source authority must carry the causal admitted permission ceiling',
    });
  }
})));
export type SessionInputCausalPermissionAuthorityV1 = z.infer<
  typeof SessionInputCausalPermissionAuthorityV1Schema
>;
