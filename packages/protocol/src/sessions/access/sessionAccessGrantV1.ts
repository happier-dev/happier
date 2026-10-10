import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import {
  AccountPrincipalRefV1Schema, GroupPrincipalRefV1Schema, TeamPrincipalRefV1Schema,
} from '../../teams/principal.js';
import { SessionRecipientEnvelopeInputV1Schema } from '../encryption/sessionDataKeyEnvelopes.js';

export const SessionAccessLevelV1Schema = lazyZodSchema(() => z.enum(['view', 'edit', 'admin']));
export type SessionAccessLevelV1 = z.infer<typeof SessionAccessLevelV1Schema>;

const grantValue = {
  accessLevel: SessionAccessLevelV1Schema,
  canApprovePermissions: z.boolean(),
};

function enforcePermissionDelegationLevel(
  grant: Readonly<{ accessLevel: z.infer<typeof SessionAccessLevelV1Schema>; canApprovePermissions: boolean }>,
  ctx: z.RefinementCtx,
) {
  if (grant.accessLevel === 'view' && grant.canApprovePermissions) {
    ctx.addIssue({
      code: 'custom', path: ['canApprovePermissions'],
      message: 'Permission delegation requires edit or admin access',
    });
  }
}

/** Public desired-state grant intent. Encryption material is host-owned. */
export const SessionGrantIntentV1Schema = lazyZodSchema(() => z.union([
  z.object({ subject: AccountPrincipalRefV1Schema, ...grantValue }).strict(),
  z.object({ subject: TeamPrincipalRefV1Schema, ...grantValue }).strict(),
  z.object({ subject: GroupPrincipalRefV1Schema, ...grantValue }).strict(),
]).superRefine(enforcePermissionDelegationLevel));
export type SessionGrantIntentV1 = z.infer<typeof SessionGrantIntentV1Schema>;

/** Private physical mutation. Only a trusted host may add direct-recipient material. */
export const SessionGrantMutationV1Schema = lazyZodSchema(() => z.union([
  z.object({
    subject: AccountPrincipalRefV1Schema,
    ...grantValue,
    accountEnvelopeInput: SessionRecipientEnvelopeInputV1Schema.optional(),
  }).strict(),
  z.object({ subject: TeamPrincipalRefV1Schema, ...grantValue }).strict(),
  z.object({ subject: GroupPrincipalRefV1Schema, ...grantValue }).strict(),
]).superRefine(enforcePermissionDelegationLevel));
export type SessionGrantMutationV1 = z.infer<typeof SessionGrantMutationV1Schema>;

/** Explicit grant facts exclude persistence identity, timestamps, keys, and membership. */
export const SessionAccessGrantV1Schema = lazyZodSchema(() => z.union([
  z.object({ subject: AccountPrincipalRefV1Schema, ...grantValue }).strict(),
  z.object({ subject: TeamPrincipalRefV1Schema, ...grantValue, requiredByTeamPolicy: z.boolean() }).strict(),
  z.object({ subject: GroupPrincipalRefV1Schema, ...grantValue }).strict(),
]));
export type SessionAccessGrantV1 = z.infer<typeof SessionAccessGrantV1Schema>;
