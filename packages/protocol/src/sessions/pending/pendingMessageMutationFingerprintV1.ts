import { z } from 'zod';

/**
 * A bounded SHA-256 digest asserted by the authenticated Pending mutation
 * caller. It identifies one canonical admitted edit payload without exposing
 * E2EE plaintext to the server during an exact response-loss rejoin.
 */
export const PendingMessageMutationFingerprintV1Schema = z.string().regex(
  /^[A-Za-z0-9_-]{43}$/u,
  'Expected an unpadded base64url SHA-256 digest',
);

export type PendingMessageMutationFingerprintV1 = z.infer<
  typeof PendingMessageMutationFingerprintV1Schema
>;
