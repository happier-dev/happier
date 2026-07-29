import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

import type { ModelPackHasher } from './installerCore.js';

/**
 * Shared incremental SHA-256 implementation for host adapters that do not have
 * a native streaming digest. It keeps only hash state, never file chunks.
 */
export function createSha256Hasher(): ModelPackHasher {
  const hasher = sha256.create();
  let finalized = false;
  return {
    update: (chunk) => {
      if (finalized) {
        throw new Error('model_pack_hasher_finalized');
      }
      hasher.update(chunk);
    },
    digestHex: async () => {
      finalized = true;
      return bytesToHex(hasher.digest()).toLowerCase();
    },
  };
}
