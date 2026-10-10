import { z } from 'zod';

import { lazyZodSchema } from '../lazyZodSchema.js';
import {
  HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1,
} from '../teams/identity/actionIds.js';
import {
  IdentityConnectionV1Schema,
  IdentityConnectionCreateInputV1Schema,
  IdentityConnectionMutationResultV1Schema,
  IdentityConnectionRemovalPreflightV1Schema,
  IdentityConnectionTestConsumeResultV1Schema,
  IdentityEligibleProviderV1Schema,
  TeamIdentityConnectionListInputV1Schema,
  TeamIdentityConnectionRefInputV1Schema,
  TeamIdentityConnectionSettingsUpdateInputV1Schema,
  TeamIdentityConnectionTestConsumeInputV1Schema,
  TeamIdentityConnectionRemoveResultV1Schema,
  TeamIdentityConnectionTestStartResultV1Schema,
} from '../teams/identity/connection.js';
import {
  TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema,
  TeamIdentityWorkosConnectionCreateInputV1Schema,
  TeamIdentityWorkosConnectionSetInputV1Schema,
  TeamIdentityWorkosReconcileInputV1Schema,
  TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema,
  identityWorkosReconcileResultV1Schema,
} from '../teams/identity/workos.js';

export { HOME_IDENTITY_ACTION_IDS_V1, HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1,
  type HomeIdentityActionIdV1, type HomeIdentityConnectionUserActionIdV1 } from '../teams/identity/actionIds.js';

/** Home and Team are strict projections of the same scoped identity owner. */
export const HomeIdentityConnectionV1Schema = lazyZodSchema(() => IdentityConnectionV1Schema.safeExtend({
  teamId: z.null(),
  allowedActions: z.array(z.enum(HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1))
    .max(HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1.length)
    .refine((actions) => new Set(actions).size === actions.length),
}));
export type HomeIdentityConnectionV1 = z.infer<typeof HomeIdentityConnectionV1Schema>;
export const HomeIdentityEligibleProviderV1Schema = lazyZodSchema(() => IdentityEligibleProviderV1Schema.refine(
  (value) => value.owner === 'home' && !(value.availability.status === 'available'
    && value.availability.setupChoice.kind === 'create_managed'
    && value.availability.setupChoice.actionId === 'teams.identity.workos.connection.create'),
));
export type HomeIdentityEligibleProviderV1 = z.infer<typeof HomeIdentityEligibleProviderV1Schema>;
export const HomeIdentityConnectionListInputV1Schema = TeamIdentityConnectionListInputV1Schema.omit({ teamId: true });
export const HomeIdentityConnectionRefInputV1Schema = TeamIdentityConnectionRefInputV1Schema.omit({ teamId: true });
export const HomeIdentityConnectionCreateInputV1Schema = IdentityConnectionCreateInputV1Schema;
export const HomeIdentityConnectionSettingsUpdateInputV1Schema = TeamIdentityConnectionSettingsUpdateInputV1Schema.omit({ teamId: true });
export const HomeIdentityConnectionTestStartInputV1Schema = HomeIdentityConnectionRefInputV1Schema;
export const HomeIdentityConnectionTestConsumeInputV1Schema = TeamIdentityConnectionTestConsumeInputV1Schema.omit({ teamId: true });
export const HomeIdentityConnectionListResultV1Schema = lazyZodSchema(() => z.object({
  items: z.array(HomeIdentityConnectionV1Schema),
  eligibleProviders: z.array(HomeIdentityEligibleProviderV1Schema),
}).strict());
export type HomeIdentityConnectionListResultV1 = z.infer<typeof HomeIdentityConnectionListResultV1Schema>;
export const HomeIdentityConnectionMutationResultV1Schema = lazyZodSchema(() => IdentityConnectionMutationResultV1Schema.safeExtend({ connection: HomeIdentityConnectionV1Schema }));
export const HomeIdentityConnectionRemovalPreflightV1Schema = lazyZodSchema(() => IdentityConnectionRemovalPreflightV1Schema.safeExtend({ connection: HomeIdentityConnectionV1Schema }));
export const HomeIdentityConnectionTestConsumeResultV1Schema = lazyZodSchema(() => IdentityConnectionTestConsumeResultV1Schema.safeExtend({ connection: HomeIdentityConnectionV1Schema }));
export const HomeIdentityWorkosConnectionCreateInputV1Schema = lazyZodSchema(() => TeamIdentityWorkosConnectionCreateInputV1Schema.omit({ teamId: true }).required({ displayName: true }));
export const HomeIdentityWorkosAdminPortalLinkCreateInputV1Schema = lazyZodSchema(() => TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema
  .omit({ teamId: true, directorySourceId: true }).safeExtend({ intent: z.literal('sso') }));
export const HomeIdentityWorkosReconcileInputV1Schema = TeamIdentityWorkosReconcileInputV1Schema.omit({ teamId: true });
export const HomeIdentityWorkosConnectionSetInputV1Schema = TeamIdentityWorkosConnectionSetInputV1Schema.omit({ teamId: true });
export const HomeIdentityWorkosReconcileResultV1Schema = lazyZodSchema(() => identityWorkosReconcileResultV1Schema(HomeIdentityConnectionV1Schema));
export const HomeIdentityConnectionRemoveResultV1Schema = TeamIdentityConnectionRemoveResultV1Schema;
export const HomeIdentityConnectionTestStartResultV1Schema = TeamIdentityConnectionTestStartResultV1Schema;
export const HomeIdentityWorkosConnectionCreateResultV1Schema = HomeIdentityConnectionMutationResultV1Schema;
export const HomeIdentityWorkosAdminPortalLinkCreateResultV1Schema = TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema;

export type HomeIdentityConnectionListInputV1 = z.infer<typeof HomeIdentityConnectionListInputV1Schema>;
export type HomeIdentityConnectionRefInputV1 = z.infer<typeof HomeIdentityConnectionRefInputV1Schema>;
export type HomeIdentityConnectionCreateInputV1 = z.infer<typeof HomeIdentityConnectionCreateInputV1Schema>;
export type HomeIdentityConnectionSettingsUpdateInputV1 = z.infer<typeof HomeIdentityConnectionSettingsUpdateInputV1Schema>;
export type HomeIdentityConnectionMutationResultV1 = z.infer<typeof HomeIdentityConnectionMutationResultV1Schema>;
export type HomeIdentityConnectionRemoveResultV1 = z.infer<typeof HomeIdentityConnectionRemoveResultV1Schema>;
export type HomeIdentityConnectionRemovalPreflightV1 = z.infer<typeof HomeIdentityConnectionRemovalPreflightV1Schema>;
export type HomeIdentityConnectionTestStartInputV1 = z.infer<typeof HomeIdentityConnectionTestStartInputV1Schema>;
export type HomeIdentityConnectionTestStartResultV1 = z.infer<typeof HomeIdentityConnectionTestStartResultV1Schema>;
export type HomeIdentityConnectionTestConsumeInputV1 = z.infer<typeof HomeIdentityConnectionTestConsumeInputV1Schema>;
export type HomeIdentityConnectionTestConsumeResultV1 = z.infer<typeof HomeIdentityConnectionTestConsumeResultV1Schema>;
export type HomeIdentityWorkosConnectionCreateInputV1 = z.infer<typeof HomeIdentityWorkosConnectionCreateInputV1Schema>;
export type HomeIdentityWorkosConnectionCreateResultV1 = z.infer<typeof HomeIdentityWorkosConnectionCreateResultV1Schema>;
export type HomeIdentityWorkosAdminPortalLinkCreateInputV1 = z.infer<typeof HomeIdentityWorkosAdminPortalLinkCreateInputV1Schema>;
export type HomeIdentityWorkosAdminPortalLinkCreateResultV1 = z.infer<typeof HomeIdentityWorkosAdminPortalLinkCreateResultV1Schema>;
export type HomeIdentityWorkosReconcileInputV1 = z.infer<typeof HomeIdentityWorkosReconcileInputV1Schema>;
export type HomeIdentityWorkosReconcileResultV1 = z.infer<typeof HomeIdentityWorkosReconcileResultV1Schema>;
export type HomeIdentityWorkosConnectionSetInputV1 = z.infer<typeof HomeIdentityWorkosConnectionSetInputV1Schema>;
