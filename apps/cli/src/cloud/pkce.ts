import { createHash, randomBytes } from 'node:crypto';
import { generatePkceCodes as generatePortablePkceCodes, type PkceCodes } from '@happier-dev/cli-common/connectedAccounts';

export type { PkceCodes } from '@happier-dev/cli-common/connectedAccounts';

/** The CLI supplies native crypto to the shared RFC 7636 algorithm. */
export function generatePkceCodes(bytes: number = 32): Promise<PkceCodes> {
  return generatePortablePkceCodes({
    randomBytes,
    sha256: (value) => new Uint8Array(createHash('sha256').update(value).digest()),
  }, bytes);
}
