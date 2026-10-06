import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

/** Process-local proof material for the existing purpose-bound external-auth flow. */
export function createExternalAuthProof(
  randomBytes: (size: number) => Uint8Array = (size) => new Uint8Array(nodeRandomBytes(size)),
): Readonly<{ proof: string; proofHash: string }> {
  const proof = encodeBase64(randomBytes(32), 'base64url');
  return {
    proof,
    proofHash: createHash('sha256').update(proof, 'utf8').digest('hex'),
  };
}
