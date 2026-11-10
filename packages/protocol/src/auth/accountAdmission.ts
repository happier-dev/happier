import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { TeamInvitationTokenV1Schema } from '../teams/invitationToken.js';

/** Bounded fresh-Account admission supplied by an explicit Team invitation journey. */
export const TeamInvitationAccountAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('team_invitation'),
  token: TeamInvitationTokenV1Schema,
}));

export type TeamInvitationAccountAdmissionV1 = z.infer<
  typeof TeamInvitationAccountAdmissionV1Schema
>;
