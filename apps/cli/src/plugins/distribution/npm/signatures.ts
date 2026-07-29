import { createPublicKey, verify } from 'node:crypto';

import type { NpmRegistrySignature, NpmRegistrySigningKey } from './types';

function decodeBase64(value: string, label: string): Buffer {
  const normalized = value.replace(/=+$/, '');
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== normalized) throw new Error(`Invalid npm registry ${label}`);
  return decoded;
}

export function verifyNpmRegistrySignatures(params: Readonly<{
  packageName: string;
  version: string;
  integrity: string;
  signatures: readonly NpmRegistrySignature[];
  keys: readonly NpmRegistrySigningKey[];
}>): Readonly<{ status: 'absent' } | { status: 'verified'; keyid: string } | { status: 'unsupported'; keyid: string }> {
  if (params.signatures.length === 0) return { status: 'absent' };
  const message = Buffer.from(`${params.packageName}@${params.version}:${params.integrity}`);

  let unsupportedKeyId: string | null = null;
  let supportedClaimSeen = false;
  for (const signature of params.signatures) {
    const matchingKeys = params.keys.filter((candidate) => candidate.keyid === signature.keyid);
    const supportedKeys = matchingKeys.filter((key) => key.keytype === 'ecdsa-sha2-nistp256' && key.scheme === 'ecdsa-sha2-nistp256');
    if (matchingKeys.length > 0 && supportedKeys.length === 0) {
      unsupportedKeyId ??= signature.keyid;
      continue;
    }
    if (supportedKeys.length === 0) continue;
    supportedClaimSeen = true;
    for (const key of supportedKeys) {
      // `expires` bounds when a registry may create new signatures. The signed npm
      // message has no authenticated signing timestamp, so historical verification
      // must retain rotated keys rather than compare expiry with the install time.
      try {
        const der = decodeBase64(key.key, 'public key');
        const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
        if (verify('sha256', message, publicKey, decodeBase64(signature.sig, 'signature'))) {
          return { status: 'verified', keyid: key.keyid };
        }
      } catch {
        continue;
      }
    }
  }
  if (!supportedClaimSeen && unsupportedKeyId) return { status: 'unsupported', keyid: unsupportedKeyId };
  throw new Error('Npm registry signature validation failed');
}
