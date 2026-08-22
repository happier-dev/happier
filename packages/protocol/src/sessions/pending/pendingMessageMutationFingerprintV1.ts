import { z } from 'zod';

/**
 * A bounded equality tag asserted by the authenticated Pending mutation caller.
 * It identifies one canonical admitted edit payload across an exact
 * response-loss rejoin.
 *
 * The server only ever compares two caller-asserted values for equality; it
 * never derives one. How the caller derives it therefore follows the Session's
 * persisted encryption mode, matching the discrimination
 * `SessionInputRequestEqualityEvidenceV1Schema` already enforces:
 *
 * - `plain` uploads the record itself, so the tag is an unkeyed digest of that
 *   same record and stays recomputable from the content the server received.
 * - `e2ee` uploads ciphertext, so the tag is keyed by the Session's own
 *   encryption material. An unkeyed digest of the plaintext carried beside the
 *   ciphertext would be exactly the offline equality oracle for prior plaintext
 *   that `docs/encryption.md` rules out.
 *
 * Both derivations are SHA-256-sized, so the wire shape is one 43-character
 * unpadded base64url value either way.
 */
export const PendingMessageMutationFingerprintV1Schema = z.string().regex(
  /^[A-Za-z0-9_-]{43}$/u,
  'Expected an unpadded base64url SHA-256 digest',
);

export type PendingMessageMutationFingerprintV1 = z.infer<
  typeof PendingMessageMutationFingerprintV1Schema
>;
