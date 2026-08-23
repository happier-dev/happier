import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol';

import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { StoredCredentials } from '@/persistence';

/**
 * The one mapping from stored CLI credentials to Account-scoped crypto material for
 * qualified Connected Account content. A token-only credential genuinely carries no
 * Account material, so this returns `null` rather than fabricating a replacement key;
 * the caller decides using the persisted Account mode, never key presence.
 */
export function resolveConnectedAccountCryptoMaterial(
  credentials: StoredCredentials,
): AccountScopedCryptoMaterial | null {
  if (!credentials.encryption) return null;
  return credentials.encryption.type === 'legacy'
    ? Object.freeze({
      type: 'legacy' as const,
      secret: credentials.encryption.secret,
    })
    : Object.freeze({
      type: 'dataKey' as const,
      machineKey: credentials.encryption.machineKey,
    });
}

/**
 * Required only once the persisted Account mode is `e2ee`. Missing material for an
 * E2EE Account fails closed instead of falling back to a plain representation.
 */
export function requireConnectedAccountCryptoMaterial(
  credentials: StoredCredentials,
  material: AccountScopedCryptoMaterial | null,
): AccountScopedCryptoMaterial {
  if (material) return material;
  requireAccountEncryptionCredentials(credentials);
  throw new Error(
    'Account encryption credentials unexpectedly resolved without crypto material',
  );
}
