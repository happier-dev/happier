import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { TeamInvitationTokenV1Schema } from '../teams/invitationToken.js';

/** Bounded fresh-Account admission supplied by an explicit Team invitation journey. */
export const TeamInvitationAccountAdmissionV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('team_invitation'),
  token: TeamInvitationTokenV1Schema,
}).strict());

export type TeamInvitationAccountAdmissionV1 = z.infer<
  typeof TeamInvitationAccountAdmissionV1Schema
>;
