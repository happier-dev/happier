import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/**
 * 43 characters of the server's cryptographic alphanumeric alphabet is ~256 bits of
 * entropy. The format is deliberately versionless and identical for transferable and
 * email-bound invitations, so there is one codec and one digest rule.
 */
export const TEAM_INVITATION_TOKEN_LENGTH = 43;
export const TeamInvitationTokenV1Schema = lazyZodSchema(() => z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9]{${TEAM_INVITATION_TOKEN_LENGTH}}$`)));
export type TeamInvitationTokenV1 = z.infer<typeof TeamInvitationTokenV1Schema>;
