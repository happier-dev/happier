import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/**
 * 43 characters of the server's cryptographic alphanumeric alphabet is ~256 bits of
 * entropy. The format is deliberately versionless and identical for transferable and
 * email-bound invitations, so there is one codec and one digest rule.
 */
export const TEAM_INVITATION_TOKEN_LENGTH = 43;
export const TEAM_INVITATION_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9]{${TEAM_INVITATION_TOKEN_LENGTH}}$`);
export const INVITATION_TOKEN_EXPECTED_MESSAGE = 'Paste the invitation token, or open the link in the app. A join link must resolve and verify its Home target before acceptance.';
export const TeamInvitationTokenV1Schema = lazyZodSchema(() => z
  .string().check(z.regex(TEAM_INVITATION_TOKEN_PATTERN)));
export type TeamInvitationTokenV1 = z.infer<typeof TeamInvitationTokenV1Schema>;
